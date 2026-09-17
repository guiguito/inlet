import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, withKey } from '../setup/api.js';

/**
 * The one cross-origin surface (CR-010, FD-013).
 *
 * `inlet-sdk/crash/browser` runs on the integrator's own origin, so crash ingest and the
 * health probe answer cross-origin and everything else does not. What is worth pinning here
 * is the boundary, in both directions: the three paths that must work from a browser, and a
 * list of near neighbours that must not.
 *
 * `inject` does not enforce CORS the way a browser does; it lets us observe exactly what the
 * server granted, which is the stronger assertion. The browser half is
 * `e2e/api/sdk-browser.spec.ts`, which drives real Chromium from a real second origin.
 */
describe('cross-origin collection', () => {
  let h: Harness;
  let projectId: string;
  let databaseId: string;
  let publishable: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    resetCrashRateLimits();
    projectId = await createProject(h);
    databaseId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Desktop app' })).json().id;
    publishable = (await createCredential(h, projectId, 'publishable')).secret;
  });

  const envelope = () => ({
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sdk: { name: 'inlet-sdk', version: '0.1.0' },
    kind: 'exception',
    release: { version: '1.4.0' },
    exception: { type: 'TypeError', message: 'boom', handled: false, frames: [{ function: 'run', file: 'main.js', inApp: true }] },
  });

  /** A browser's preflight: no body, no credential, just the question. */
  const preflight = (url: string, method = 'POST') =>
    h.app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    });

  it('answers the ingest preflight, so a browser on another origin may report at all', async () => {
    for (const url of [`/v1/crash-databases/${databaseId}/reports`, `/v1/crash-databases/${databaseId}/reports/batch`]) {
      const response = await preflight(url);
      expect(response.statusCode, url).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-headers']).toContain('authorization');
      expect(response.headers['access-control-allow-headers']).toContain('content-type');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-max-age']).toBe('86400');
      // The absence is the security property: without it a browser sends no cookie, so a
      // management session can never be replayed from another origin.
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('carries the origin on the answer, on a refusal, and on the health probe', async () => {
    const accepted = await withKey(h.app, publishable, 'POST', `/v1/crash-databases/${databaseId}/reports`, envelope());
    expect(accepted.statusCode).toBe(201);
    expect(accepted.headers['access-control-allow-origin']).toBe('*');
    // CR-016: Retry-After is not CORS-safelisted, so a cross-origin client cannot read it
    // unless it is exposed, and would back off on a guess instead of the server's number.
    expect(accepted.headers['access-control-expose-headers']).toContain('retry-after');
    expect(accepted.headers['access-control-allow-credentials']).toBeUndefined();

    // A cross-origin error response without the header is an opaque network failure to
    // fetch, and the SDK would requeue for ever a report the server has already refused.
    const refused = await withKey(h.app, 'ipk_not_a_real_key', 'POST', `/v1/crash-databases/${databaseId}/reports`, envelope());
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['access-control-allow-origin']).toBe('*');

    // FD-013: the SDK reads this before its first send to tell an old deployment from an
    // unreachable one, so it has to be readable cross-origin too.
    const health = await h.app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.headers['access-control-allow-origin']).toBe('*');
  });

  it('leaves every other route same-origin', async () => {
    const closed = [
      `/v1/crash-databases/${databaseId}`,
      `/v1/projects/${projectId}/crash-databases`,
      // The nearest misses to the pattern: crash routes under the same prefix.
      `/v1/crash-databases/${databaseId}/reports/crp_whatever`,
      `/v1/crash-databases/${databaseId}/groups`,
      '/v1/feedback-databases',
      '/v1/auth/sign-in',
      '/v1/auth/me',
      '/',
    ];
    for (const url of closed) {
      const response = await preflight(url, 'GET');
      expect(response.statusCode, url).toBe(404);
      expect(response.headers['access-control-allow-origin'], url).toBeUndefined();
    }

    // And on the real answers, not only on the preflights.
    const managed = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}`);
    expect(managed.statusCode).toBe(200);
    expect(managed.headers['access-control-allow-origin']).toBeUndefined();
    const session = await asAdmin(h, 'GET', '/v1/auth/me');
    expect(session.headers['access-control-allow-origin']).toBeUndefined();
  });
});
