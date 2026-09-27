import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { analyticsDatabases, users } from '../../src/db/schema.js';
import { eventExportPages } from '../../src/services/analytics-export.js';
import { querySlots } from '../../src/services/analytics-query.js';
import { querySlotTimings } from '../../src/services/analytics-slots.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * The event export (UX Analytics AN-210, AN-204, AN-205, AN-212): newline-delimited JSON, one
 * stored event per line, paged by effective time and event ID, filtered, stable, skipping what an
 * erasure took, one query slot per page.
 */

const INST1 = '0192f5a0-1111-7000-8000-00000000000a';
const INST2 = '0192f5a0-2222-7000-8000-00000000000b';
const SESSION = '0192f5a0-aaaa-7000-8000-000000000001';
const DAY_MS = 86_400_000;

describe('the event export (AN-210)', () => {
  let h: Harness;
  let projectId: string;
  let key: string;
  let databaseId: string;
  let credentialId: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    projectId = await createProject(h);
    const credential = await createCredential(h, projectId, 'publishable');
    key = credential.secret;
    credentialId = credential.id;
    const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone: 'UTC' });
    expect(created.statusCode, created.body).toBe(201);
    databaseId = created.json().id as string;
  });

  const event = (overrides: Record<string, unknown> = {}) => ({
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    name: 'checkout_completed',
    installationId: INST1,
    platform: 'web',
    app: { version: '1.4.0' },
    sdk: { name: 'inlet-sdk', version: '0.3.0' },
    ...overrides,
  });

  async function send(events: Record<string, unknown>[]) {
    const response = await withKey(h.app, key, 'POST', `/v1/analytics-databases/${databaseId}/batch`, { sentAt: new Date().toISOString(), events });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().rejected, response.body).toEqual([]);
    return events.map((e) => e.eventId as string);
  }

  const url = (query = '') => `/v1/analytics-databases/${databaseId}/exports/events${query}`;
  async function lines(query = ''): Promise<Record<string, unknown>[]> {
    const response = await asAdmin(h, 'GET', url(query));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    return response.body.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  const eventIds = async (query = '') => (await lines(query)).map((line) => line.eventId);

  it('writes one line per stored event with its stored fields and derived values', async () => {
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const [id] = await send([
      event({ timestamp, userId: 'u1', sessionId: SESSION, attribution: 'newsletter', experiments: { checkout: 'b' }, params: { plan: 'pro', items: 3 }, locale: 'fr-FR', country: 'FR', category: 'purchase' }),
    ]);
    const [line] = await lines();
    expect(line).toEqual({
      eventId: id,
      name: 'checkout_completed',
      category: 'purchase',
      time: timestamp,
      receivedTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      localDay: timestamp.slice(0, 10),
      installationId: INST1,
      installationKind: 'device',
      ephemeral: false,
      userId: 'u1',
      sessionId: SESSION,
      context: expect.objectContaining({ platform: 'web', appVersion: '1.4.0', locale: 'fr-FR', country: 'FR', attribution: 'newsletter', experiments: { checkout: 'b' } }),
      params: { plan: 'pro', items: '3' },
      installAge: { days: 0, weeks: 0, months: 0 },
      clockCorrected: false,
      credentialId,
    });
    expect(Date.parse(line!.receivedTime as string)).toBeGreaterThanOrEqual(Date.parse(timestamp));
  });

  it('pages by effective time and event ID across days, each page stable, the stream and the pages agreeing', async () => {
    const now = Date.now();
    const sent = await send([
      event({ timestamp: new Date(now - 2 * DAY_MS).toISOString() }),
      event({ timestamp: new Date(now - 2 * DAY_MS + 1_000).toISOString() }),
      event({ timestamp: new Date(now - DAY_MS).toISOString(), installationId: INST2 }),
      event({ timestamp: new Date(now - DAY_MS + 1).toISOString(), installationId: INST2, name: 'app_started' }),
      event({ timestamp: new Date(now - 5_000).toISOString() }),
      event({ timestamp: new Date(now - 4_000).toISOString() }),
      event({ timestamp: new Date(now - 3_000).toISOString() }),
    ]);
    const streamed = await lines();
    // Distinct times here: a tie is ordered by the event ID as the event store compares UUIDs.
    const expected = [...streamed].sort((a, b) => String(a.time).localeCompare(String(b.time)));
    expect(streamed).toEqual(expected);
    expect(new Set(streamed.map((line) => line.eventId))).toEqual(new Set(sent));

    // One JSON page of three at a time (AN-204); an event arriving meanwhile, however early its
    // time, never lands on a page after the first.
    const paged: unknown[] = [];
    let cursor: string | null = null;
    let first = true;
    do {
      const response = await asAdmin(h, 'GET', url(`?limit=3${cursor ? `&cursor=${cursor}` : ''}`));
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json() as { events: { eventId: string }[]; nextCursor: string | null };
      expect(page.events.length).toBeLessThanOrEqual(3);
      paged.push(...page.events.map((e) => e.eventId));
      cursor = page.nextCursor;
      if (first) await send([event({ timestamp: new Date(now - DAY_MS - 1_000).toISOString() })]);
      first = false;
    } while (cursor !== null);
    expect(paged).toEqual(streamed.map((line) => line.eventId));
    expect(await eventIds()).toHaveLength(8);
    expect(errorCode(await asAdmin(h, 'GET', url('?limit=3&cursor=nope')))).toBe('invalid_query');
  });

  it('filters by days, event name, installation ID and user ID', async () => {
    const now = Date.now();
    const [old, , signedIn, started] = await send([
      event({ timestamp: new Date(now - 3 * DAY_MS).toISOString() }),
      event({ installationId: INST2 }),
      event({ userId: 'u1' }),
      event({ name: 'app_started' }),
    ]);
    const today = new Date(now).toISOString().slice(0, 10);
    const threeDaysAgo = new Date(now - 3 * DAY_MS).toISOString().slice(0, 10);
    expect(await eventIds(`?to=${threeDaysAgo}`)).toEqual([old]);
    expect(await eventIds(`?from=${today}`)).toHaveLength(3);
    expect(await eventIds('?name=app_started')).toEqual([started]);
    expect(await eventIds('?name=never_sent')).toEqual([]);
    expect(await eventIds(`?installationId=${INST2.toUpperCase()}`)).toHaveLength(1);
    expect(await eventIds('?userId=u1')).toEqual([signedIn]);
    expect(errorCode(await asAdmin(h, 'GET', url('?installationId=not-a-uuid')))).toBe('invalid_query');
    expect(errorCode(await asAdmin(h, 'GET', url(`?from=${today}&to=${threeDaysAgo}`)))).toBe('invalid_query');
  });

  it('never exports what an erasure took (AN-184)', async () => {
    const [, kept] = await send([event({ userId: 'u1' }), event({ installationId: INST2 })]);
    const erased = await asAdmin(h, 'POST', `/v1/projects/${projectId}/erasures`, { kind: 'user', id: 'u1', confirm: 'u1', databases: [databaseId] });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(await eventIds()).toEqual([kept]);
  });

  it('holds one query slot per page, and only while the page is read (AN-205); a Viewer may export, a publishable key may not', async () => {
    await send([event(), event(), event(), event(), event()]);
    const [admin] = await h.ctx.db.select().from(users);
    const caller = { id: `user:${admin!.id}`, user: true };
    const waitMs = querySlotTimings.waitMs;
    querySlotTimings.waitMs = 300;
    try {
      const release = await querySlots.acquire(caller, 'query');
      try {
        expect(errorCode(await asAdmin(h, 'GET', url()))).toBe('analytics_busy');
        expect(errorCode(await asAdmin(h, 'GET', url('?limit=10')))).toBe('analytics_busy');
      } finally {
        release();
      }

      // Between two pages no slot is held: the caller's own slot is free at once.
      const [database] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, databaseId));
      const principal = { kind: 'user' as const, userId: admin!.id, email: admin!.email };
      const pages = eventExportPages(h.ctx, database!, principal, {}, undefined, 2);
      let seen = 0;
      let count = 0;
      for await (const page of pages) {
        seen += 1;
        count += page.length;
        const free = await querySlots.acquire(caller, 'query');
        free();
      }
      expect(seen).toBe(3);
      expect(count).toBe(5);
    } finally {
      querySlotTimings.waitMs = waitMs;
    }

    const invitation = await asAdmin(h, 'POST', `/v1/analytics-databases/${databaseId}/invitations`, { role: 'viewer' });
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email: 'viewer@example.com', password: 'a-long-enough-password' } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const cookie = await signIn(h.app, 'viewer@example.com', 'a-long-enough-password');
    expect((await h.app.inject({ method: 'GET', url: url(), headers: { cookie } })).statusCode).toBe(200);
    expect(errorCode(await withKey(h.app, key, 'GET', url()))).toBe('insufficient_scope');
  });
});
