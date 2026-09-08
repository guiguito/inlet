import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessions, users } from '../../src/db/schema.js';
import { bootstrapAdmin } from '../../src/services/bootstrap.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { newId } from '@inlet/shared';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../setup/config.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, errorCode } from '../setup/api.js';

/**
 * Authentication and account creation (FR-001, FR-001A, FR-001B, FR-002, FR-004).
 *
 * Acceptance criterion: "The deployment starts with one configured Admin account; no
 * public registration page exists."
 */
describe('authentication', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  it('starts with exactly one bootstrapped Admin account (FR-001B)', async () => {
    const all = await h.ctx.db.select().from(users);
    expect(all).toHaveLength(1);
    expect(all[0]?.email).toBe(ADMIN_EMAIL);
    expect(all[0]?.displayName).toBe('Test Admin');
  });

  it('never stores the bootstrap password in plaintext (section 12.1)', async () => {
    const all = await h.ctx.db.select().from(users);
    const hash = all[0]?.passwordHash ?? '';
    expect(hash).not.toContain(ADMIN_PASSWORD);
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('is idempotent and does not reset an existing password on restart', async () => {
    const before = (await h.ctx.db.select().from(users))[0]?.passwordHash;

    // Simulate the operator changing the password after first start.
    await h.ctx.db
      .update(users)
      .set({ passwordHash: await hashPassword('a-different-password') })
      .where(eq(users.email, ADMIN_EMAIL));

    expect(await bootstrapAdmin(h.ctx)).toBe('exists');

    const after = (await h.ctx.db.select().from(users))[0]?.passwordHash;
    expect(after).not.toBe(before);
    expect(await h.ctx.db.select().from(users)).toHaveLength(1);
  });

  it('exposes no registration route (FR-001A)', async () => {
    for (const url of ['/v1/auth/register', '/v1/auth/sign-up', '/v1/users']) {
      const response = await h.app.inject({
        method: 'POST',
        url,
        payload: { email: 'someone@example.com', password: 'whatever-long-enough' },
      });
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('not_found');
    }
  });

  it('signs in with the configured credentials and sets a secure session cookie', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('inlet_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('matches the email case-insensitively', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: ADMIN_EMAIL.toUpperCase(), password: ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const wrongPassword = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: ADMIN_EMAIL, password: 'not-the-password' },
    });
    const unknownAccount = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: 'nobody@example.com', password: 'not-the-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownAccount.statusCode).toBe(401);
    expect(errorCode(wrongPassword)).toBe('invalid_credentials');
    expect(wrongPassword.body).toBe(unknownAccount.body);
  });

  it('stores only a hash of the session token', async () => {
    const raw = h.cookie.split('=')[1] ?? '';
    const decoded = decodeURIComponent(raw);
    const stored = await h.ctx.db.select().from(sessions);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).not.toContain(decoded.split('.')[0]);
    expect(stored[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prevents unauthenticated access to the management interface (FR-004)', async () => {
    const paths: [string, 'GET' | 'POST'][] = [
      ['/v1/auth/me', 'GET'],
      ['/v1/projects', 'GET'],
      ['/v1/projects', 'POST'],
    ];
    for (const [url, method] of paths) {
      const response = await h.app.inject({ method, url, payload: { name: 'x' } });
      expect(response.statusCode).toBe(401);
      expect(errorCode(response)).toBe('unauthenticated');
    }
  });

  it('rejects a forged or tampered session cookie', async () => {
    for (const cookie of [
      'inlet_session=not-a-real-token',
      `${h.cookie}tampered`,
      'inlet_session=',
    ]) {
      const response = await h.app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('signs out and invalidates the session immediately', async () => {
    expect((await asAdmin(h, 'GET', '/v1/auth/me')).statusCode).toBe(200);

    const out = await asAdmin(h, 'POST', '/v1/auth/sign-out');
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ ok: true });

    expect((await asAdmin(h, 'GET', '/v1/auth/me')).statusCode).toBe(401);
    expect(await h.ctx.db.select().from(sessions)).toHaveLength(0);
  });

  it('refuses an expired session', async () => {
    await h.ctx.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await asAdmin(h, 'GET', '/v1/auth/me')).statusCode).toBe(401);
  });

  it('refuses a session whose account has been removed', async () => {
    await h.ctx.db.delete(users).where(eq(users.email, ADMIN_EMAIL));
    expect((await asAdmin(h, 'GET', '/v1/auth/me')).statusCode).toBe(401);
  });

  it('keeps sessions separate between accounts', async () => {
    const otherId = newId('user');
    await h.ctx.db.insert(users).values({
      id: otherId,
      email: 'second@inlet.test',
      passwordHash: await hashPassword('second-account-password'),
      displayName: 'Second',
    });
    const otherCookie = await signIn(h.app, 'second@inlet.test', 'second-account-password');

    const me = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: otherCookie },
    });
    expect(JSON.parse(me.body)).toMatchObject({ id: otherId, email: 'second@inlet.test' });

    // Signing the second account out leaves the first session working.
    await h.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-out',
      headers: { cookie: otherCookie },
    });
    expect((await asAdmin(h, 'GET', '/v1/auth/me')).statusCode).toBe(200);
  });

  it('rejects a malformed sign-in body with the standard error shape', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: 'a' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });
});
