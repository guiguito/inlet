import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { analyticsDatabases, analyticsEventNameDeletions, analyticsEventNames } from '../../src/db/schema.js';
import { refreshAnalyticsCatalog, runEventNameDeletions } from '../../src/services/analytics-catalog.js';
import { resetAnalyticsIngestState } from '../../src/services/analytics-ingest.js';
import { querySlots, resetAnalyticsQueryState, resolveEventNames } from '../../src/services/analytics-query.js';
import { startAnalyticsWorker } from '../../src/services/analytics-worker.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, withKey } from '../setup/api.js';

/**
 * The catalog and the Lexicon (UX Analytics 6.5, PRD 12 "Catalog and Lexicon"): the list and
 * its refresh, descriptions through the API and MCP, hiding, blocking, deletion and its worker
 * job, filter values and the catalog export, with events stored by piece 3's ingest route.
 */

const uuid = () => randomUUID();

async function setup(h: Harness) {
  const projectId = await createProject(h);
  const key = (await createCredential(h, projectId, 'publishable')).secret;
  const secret = (await createCredential(h, projectId, 'secret')).secret;
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone: 'UTC' });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
  return { projectId, key, secret, id, databaseKey: row!.key };
}
type Db = Awaited<ReturnType<typeof setup>>;

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: uuid(),
  timestamp: new Date().toISOString(),
  name: 'checkout_completed',
  installationId: uuid(),
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

async function send(h: Harness, db: Db, events: unknown[]) {
  const response = await withKey(h.app, db.key, 'POST', `/v1/analytics-databases/${db.id}/batch`, { sentAt: new Date().toISOString(), events });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { accepted: number; rejected: { index: number; code: string }[] };
}

type Entry = { name: string; category: string | null; description: string | null; hidden: boolean; blocked: boolean; standard: boolean; lastSeen: string | null; last24h: { events: number; installations: number; users: number }; computedAt: string | null; params?: { key: string; description: string | null }[] };

async function catalog(h: Harness, db: Db, query = ''): Promise<{ events: Entry[]; nextCursor: string | null; total: number }> {
  const response = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/events${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

const names = (list: { events: Entry[] }) => list.events.map((entry) => entry.name);

async function trendTotal(h: Harness, db: Db, eventName: string): Promise<number> {
  const response = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, { range: { preset: 'today' }, series: [{ event: eventName, metric: 'events' }] });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json().series[0].points as { value: number }[]).reduce((sum, point) => sum + point.value, 0);
}

/** An MCP tool call as an agent's client makes it, through the API's own endpoint. */
async function tool(app: FastifyInstance, key: string, name: string, args: Record<string, unknown>): Promise<string> {
  const rpc = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/v1/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, payload });
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  const response = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  const message = JSON.parse(response.body) as { result?: { content?: { text?: string }[] } };
  return (message.result?.content ?? []).map((part) => part.text ?? '').join('');
}

async function eventStoreRows(h: Harness, db: Db, table: string, eventNameId: number): Promise<number> {
  const [row] = await h.ctx.eventStore!.query<{ n: string }>(`SELECT count() AS n FROM ${table} WHERE database_key = {k:UInt32} AND event_name_id = {id:UInt32}`, { k: db.databaseKey, id: eventNameId });
  return Number(row!.n);
}

async function nameId(h: Harness, db: Db, name: string): Promise<number> {
  const [row] = await h.ctx.db.select({ id: analyticsEventNames.id }).from(analyticsEventNames).where(and(eq(analyticsEventNames.databaseKey, db.databaseKey), eq(analyticsEventNames.name, name)));
  return Number(row!.id);
}

/** Runs the deletion pass until no deletion is left open; ClickHouse applies the deletes in the background. */
async function finishDeletions(h: Harness, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await runEventNameDeletions(h.ctx);
    const open = await h.ctx.db.select().from(analyticsEventNameDeletions).where(isNull(analyticsEventNameDeletions.completedAt));
    if (open.length === 0) return;
    if (Date.now() > until) throw new Error('the event-name deletion did not complete');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('the catalog and the Lexicon', () => {
  let h: Harness;
  let db: Db;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    db = await setup(h);
  });

  describe('the list and its refresh (AN-050, AN-051, AN-055)', () => {
    it('lists every name with its category, last seen and 24-hour figures with the time computed, filters by category, and finds checkout_completed from CHECKOUT', async () => {
      const a = uuid();
      await send(h, db, [
        // The latest category is that of the latest event.
        event({ installationId: a, userId: 'u-1', category: 'checkout', timestamp: new Date(Date.now() - 3_000).toISOString() }),
        event({ installationId: a, userId: 'u-1', category: 'purchase', timestamp: new Date(Date.now() - 2_000).toISOString() }),
        event({ userId: 'u-2', category: 'purchase', timestamp: new Date(Date.now() - 1_000).toISOString() }),
        event({ name: 'cart_viewed', category: 'cart' }),
        event({ name: 'app_started', category: 'standard', params: { trigger: 'launch' } }),
      ]);
      const before = await catalog(h, db);
      expect(before.events.find((entry) => entry.name === 'checkout_completed')).toMatchObject({ computedAt: null, lastSeen: null, last24h: { events: 0 } });

      expect(await refreshAnalyticsCatalog(h.ctx)).toBe(1);
      const list = await catalog(h, db);
      expect(names(list)).toEqual(['app_started', 'cart_viewed', 'checkout_completed']);
      const checkout = list.events.find((entry) => entry.name === 'checkout_completed')!;
      expect(checkout).toMatchObject({ category: 'purchase', last24h: { events: 3, installations: 2, users: 2 }, hidden: false, blocked: false, standard: false });
      expect(Date.parse(checkout.lastSeen!)).toBeGreaterThan(Date.now() - 60_000);
      expect(Date.parse(checkout.computedAt!)).toBeGreaterThan(Date.now() - 60_000);
      // AN-055: the platform describes the standard events.
      expect(list.events.find((entry) => entry.name === 'app_started')).toMatchObject({ standard: true, description: expect.stringContaining('A session began') });

      expect(names(await catalog(h, db, '?q=CHECKOUT'))).toEqual(['checkout_completed']);
      expect(names(await catalog(h, db, '?q=session%20BEGAN'))).toEqual(['app_started']);
      expect(names(await catalog(h, db, '?category=checkout'))).toEqual(['checkout_completed']);
      expect(names(await catalog(h, db, '?category=cart'))).toEqual(['cart_viewed']);
      expect(names(await catalog(h, db, '?sort=events24h'))).toEqual(['checkout_completed', 'app_started', 'cart_viewed']);
      const paged = await catalog(h, db, '?limit=2');
      expect(paged).toMatchObject({ total: 3, nextCursor: expect.any(String) });
      expect(names(await catalog(h, db, `?limit=2&cursor=${paged.nextCursor}`))).toEqual(['checkout_completed']);
    });

    it('is refreshed by the worker, and takes no query slot', async () => {
      await send(h, db, [event()]);
      const release = await querySlots.acquire({ id: 'user:somebody', user: true }, 'query');
      const stop = startAnalyticsWorker(h.ctx, { catalogIntervalMs: 50, countersIntervalMs: 60_000, deletionsIntervalMs: 60_000 });
      try {
        const until = Date.now() + 5_000;
        while ((await catalog(h, db)).events[0]!.computedAt === null) {
          if (Date.now() > until) throw new Error('the catalog was not refreshed');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        await stop();
        release();
      }
      expect((await catalog(h, db)).events[0]!.last24h.events).toBe(1);
    });

    it('needs no event store to list, and refuses a publishable key', async () => {
      const refused = await withKey(h.app, db.key, 'GET', `/v1/analytics-databases/${db.id}/events`);
      expect(refused.statusCode).toBe(403);
      const byKey = await withKey(h.app, db.secret, 'GET', `/v1/analytics-databases/${db.id}/events`);
      expect(byKey.statusCode).toBe(200);
    });
  });

  describe('descriptions and hiding (AN-053, AN-054)', () => {
    it('lets a Creator describe an event and a param, and returns both through the API and list_analytics_events', async () => {
      await send(h, db, [event({ params: { plan: 'pro' } })]);
      const described = await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/checkout_completed`, { description: 'A <b>paid</b> order.' });
      expect(described.statusCode, described.body).toBe(200);
      expect(described.json().description).toBe('A <b>paid</b> order.');
      const param = await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/checkout_completed/params/plan`, { description: 'The plan bought.' });
      expect(param.json()).toMatchObject({ key: 'plan', types: ['string'], description: 'The plan bought.' });
      expect((await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/checkout_completed/params/nope`, { description: 'x' })).json().error.code).toBe('event_not_found');
      expect((await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/checkout_completed`, { description: 'x'.repeat(501) })).statusCode).toBe(400);
      expect((await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/never_seen`, { hidden: true })).json().error.code).toBe('event_not_found');

      const listed = JSON.parse(await tool(h.app, db.secret, 'list_analytics_events', { analyticsDatabaseId: db.id })) as { events: Entry[] };
      expect(listed.events[0]).toMatchObject({ name: 'checkout_completed', description: 'A <b>paid</b> order.', params: [{ key: 'plan', description: 'The plan bought.' }] });

      const detail = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/events/checkout_completed`);
      expect(detail.json()).toMatchObject({ description: 'A <b>paid</b> order.', params: [{ key: 'plan', description: 'The plan bought.', topValues: [{ value: 'pro', events: 1 }] }] });
      const agent = JSON.parse(await tool(h.app, db.secret, 'get_analytics_event', { analyticsDatabaseId: db.id, name: 'checkout_completed' }));
      expect(agent.params[0].description).toBe('The plan bought.');
      const cleared = await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/checkout_completed`, { description: null });
      expect(cleared.json().description).toBeNull();
    });

    it('refuses a Viewer’s description, a Creator’s block and delete, and lets a Viewer read', async () => {
      await send(h, db, [event()]);
      const member = async (email: string, role: 'viewer' | 'creator') => {
        const invitation = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/invitations`, { role });
        expect(invitation.statusCode, invitation.body).toBe(201);
        const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
        expect(redeemed.statusCode, redeemed.body).toBe(200);
        const cookie = await signIn(h.app, email, 'a-long-enough-password');
        return (method: 'GET' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => h.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
      };
      const viewer = await member('viewer@example.com', 'viewer');
      const base = `/v1/analytics-databases/${db.id}/events`;
      expect((await viewer('PATCH', `${base}/checkout_completed`, { hidden: true })).statusCode).toBe(403);
      expect((await viewer('GET', base)).statusCode).toBe(200);
      expect((await viewer('GET', `${base}/checkout_completed`)).statusCode).toBe(200);
      const creator = await member('creator@example.com', 'creator');
      expect((await creator('PATCH', `${base}/checkout_completed`, { description: 'Paid.' })).statusCode).toBe(200);
      expect((await creator('PUT', `${base}/checkout_completed/blocked`, { blocked: true })).statusCode).toBe(403);
      expect((await creator('DELETE', `${base}/checkout_completed?confirm=checkout_completed`)).statusCode).toBe(403);
    });

    it('leaves a hidden event out of the list unless asked, and keeps it queryable by name', async () => {
      await send(h, db, [event(), event({ name: 'cart_viewed' })]);
      const hidden = await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/cart_viewed`, { hidden: true });
      expect(hidden.json().hidden).toBe(true);
      expect(names(await catalog(h, db))).toEqual(['checkout_completed']);
      expect(names(await catalog(h, db, '?includeHidden=true'))).toEqual(['cart_viewed', 'checkout_completed']);
      expect(await trendTotal(h, db, 'cart_viewed')).toBe(1);
      expect(await trendTotal(h, db, '*')).toBe(2);
      expect((await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/events/cart_viewed`)).statusCode).toBe(200);
    });
  });

  describe('blocking (AN-059, AN-055)', () => {
    it('refuses a blocked name’s events at once and keeps its entry; unblocking lets them in again', async () => {
      await send(h, db, [event({ name: 'spam_event' })]);
      const blocked = await asAdmin(h, 'PUT', `/v1/analytics-databases/${db.id}/events/spam_event/blocked`, { blocked: true });
      expect(blocked.statusCode, blocked.body).toBe(200);
      expect(blocked.json().blocked).toBe(true);
      expect((await send(h, db, [event({ name: 'spam_event' }), event()])).rejected).toEqual([{ index: 0, code: 'event_blocked' }]);
      expect(names(await catalog(h, db))).toContain('spam_event');
      await asAdmin(h, 'PUT', `/v1/analytics-databases/${db.id}/events/spam_event/blocked`, { blocked: false });
      expect((await send(h, db, [event({ name: 'spam_event' })])).accepted).toBe(1);
      expect(await trendTotal(h, db, 'spam_event')).toBe(2);
    });

    it('refuses to block or delete a standard event, and needs an Admin', async () => {
      await send(h, db, [event({ name: 'app_started', category: 'standard' })]);
      const block = await asAdmin(h, 'PUT', `/v1/analytics-databases/${db.id}/events/app_started/blocked`, { blocked: true });
      expect(block.statusCode).toBe(409);
      expect(block.json().error.code).toBe('standard_event_undeletable');
      const remove = await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/app_started?confirm=app_started`);
      expect(remove.statusCode).toBe(409);
      expect(remove.json().error.code).toBe('standard_event_undeletable');
      const agent = await tool(h.app, db.secret, 'block_analytics_event', { analyticsDatabaseId: db.id, name: 'app_started', blocked: true });
      expect(agent).toContain('standard_event_undeletable');
    });
  });

  describe('deletion (AN-056)', () => {
    it('demands the exact name, makes the data unreadable at once, frees the slot, and the worker removes the rows', async () => {
      const kept = uuid();
      await send(h, db, [event({ name: 'old_flow', installationId: kept, userId: 'u-1' }), event({ name: 'old_flow' }), event({ installationId: kept })]);
      const id = await nameId(h, db, 'old_flow');
      expect(await trendTotal(h, db, 'old_flow')).toBe(2);
      expect(await trendTotal(h, db, '*')).toBe(3);

      const mismatch = await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/old_flow?confirm=old-flow`);
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json().error.code).toBe('confirmation_mismatch');
      expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/nope?confirm=nope`)).json().error.code).toBe('event_not_found');

      // The slot: with the limit reached, a new name is refused until one is deleted.
      const limit = h.ctx.env.limits.analyticsEventNamesMax;
      h.ctx.env.limits.analyticsEventNamesMax = 2;
      try {
        expect((await send(h, db, [event({ name: 'third_name' })])).rejected).toEqual([{ index: 0, code: 'event_name_limit' }]);
        const deleted = await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/old_flow?confirm=old_flow`);
        expect(deleted.statusCode, deleted.body).toBe(200);
        expect(deleted.json()).toEqual({ deleted: true });
        // Unreadable at once, the rows still in the event store.
        expect(await eventStoreRows(h, db, 'events', id)).toBe(2);
        expect(await trendTotal(h, db, 'old_flow')).toBe(0);
        expect(await trendTotal(h, db, '*')).toBe(1);
        expect(names(await catalog(h, db, '?includeHidden=true'))).toEqual(['checkout_completed']);
        expect((await resolveEventNames(h.ctx.db, db.databaseKey, ['old_flow'])).get('old_flow')).toEqual({ status: 'deleted' });
        expect((await send(h, db, [event({ name: 'third_name' })])).accepted).toBe(1);
      } finally {
        h.ctx.env.limits.analyticsEventNamesMax = limit;
      }

      await finishDeletions(h);
      for (const table of ['events', 'installation_first', 'user_first']) expect(await eventStoreRows(h, db, table, id), table).toBe(0);
      const [record] = await h.ctx.db.select().from(analyticsEventNameDeletions).where(eq(analyticsEventNameDeletions.eventNameId, id));
      expect(record).toMatchObject({ name: 'old_flow', attempts: 1, completedAt: expect.any(Date) });

      // The name may come back, under a new ID, readable from then on.
      await send(h, db, [event({ name: 'old_flow' })]);
      expect(await nameId(h, db, 'old_flow')).not.toBe(id);
      expect(await trendTotal(h, db, 'old_flow')).toBe(1);
      expect((await resolveEventNames(h.ctx.db, db.databaseKey, ['old_flow'])).get('old_flow')).toMatchObject({ status: 'current' });
    });

    it('finishes after a restart: a deletion recorded but never submitted, then one submitted and interrupted', async () => {
      await send(h, db, [event({ name: 'gone_one' }), event({ name: 'gone_two' }), event()]);
      const one = await nameId(h, db, 'gone_one');
      const two = await nameId(h, db, 'gone_two');
      await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/gone_one?confirm=gone_one`);
      // The process stops before its worker ran: a restart loses every in-memory state.
      resetAnalyticsIngestState();
      resetAnalyticsQueryState();
      expect(await trendTotal(h, db, '*')).toBe(2);
      await finishDeletions(h);
      expect(await eventStoreRows(h, db, 'events', one)).toBe(0);

      await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/gone_two?confirm=gone_two`);
      await runEventNameDeletions(h.ctx);
      // A batch that raced the deletion stored a row under the retired ID after the delete was
      // submitted; the next passes find it and delete it too.
      await h.ctx.eventStore!.insert('events_ingest', [
        {
          database_key: db.databaseKey,
          local_day: new Date().toISOString().slice(0, 10),
          effective_time: new Date().toISOString().replace('T', ' ').slice(0, 23),
          received_time: new Date().toISOString().replace('T', ' ').slice(0, 23),
          event_id: uuid(),
          event_name_id: two,
          installation_id: uuid(),
          installation_kind: 'device',
          app_version: '1',
          environment: 'production',
          is_replay: false,
        },
      ]);
      resetAnalyticsIngestState();
      resetAnalyticsQueryState();
      expect(await trendTotal(h, db, '*')).toBe(1);
      await finishDeletions(h);
      expect(await eventStoreRows(h, db, 'events', two)).toBe(0);
      expect(await trendTotal(h, db, '*')).toBe(1);
    });

    it('asks an agent to echo the name', async () => {
      await send(h, db, [event({ name: 'old_flow' })]);
      expect(await tool(h.app, db.secret, 'delete_analytics_event', { analyticsDatabaseId: db.id, name: 'old_flow', confirm: 'old flow' })).toContain('confirmation_mismatch');
      expect(JSON.parse(await tool(h.app, db.secret, 'delete_analytics_event', { analyticsDatabaseId: db.id, name: 'old_flow', confirm: 'old_flow' }))).toEqual({ deleted: true });
    });
  });

  describe('filter values (AN-057)', () => {
    it('lists the distinct values of a dimension, an experiment and an event’s param, without counts', async () => {
      await send(h, db, [
        event({ app: { version: '1.4.0' }, experiments: { checkout: 'B' }, params: { plan: 'pro' }, attribution: 'spring' }),
        event({ app: { version: '1.3.2' }, experiments: { checkout: 'A', onboarding: 'x' }, params: { plan: 'free' } }),
        event({ name: 'cart_viewed', app: { version: '2.0.0' }, params: { plan: 'other' } }),
      ]);
      const values = async (query: string) => {
        const response = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/filters?${query}`);
        expect(response.statusCode, response.body).toBe(200);
        return response.json() as { values: string[]; truncated: boolean };
      };
      expect(await values('dimension=appVersion')).toEqual({ values: ['1.3.2', '1.4.0', '2.0.0'], truncated: false });
      expect((await values('dimension=experiment')).values).toEqual(['checkout', 'onboarding']);
      expect((await values('dimension=experiment&key=checkout')).values).toEqual(['A', 'B']);
      expect((await values('dimension=installAttribution')).values).toEqual(['spring']);
      expect((await values('dimension=country')).values).toEqual([]);
      expect((await values('param=plan&event=checkout_completed')).values).toEqual(['free', 'pro']);
      expect((await values('param=plan&event=never_seen')).values).toEqual([]);
      expect((await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/filters?dimension=userId`)).statusCode).toBe(400);
      expect((await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/filters?param=plan`)).statusCode).toBe(400);
      const agent = JSON.parse(await tool(h.app, db.secret, 'list_analytics_filter_values', { analyticsDatabaseId: db.id, dimension: 'appVersion' }));
      expect(agent.values).toEqual(['1.3.2', '1.4.0', '2.0.0']);
    });

    it('stops at 1,000 values and says so', async () => {
      for (let batch = 0; batch < 11; batch += 1) {
        await send(h, db, Array.from({ length: 100 }, (_, i) => event({ params: { code: `c${String(batch * 100 + i).padStart(5, '0')}` } })));
      }
      const response = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/filters?param=code&event=checkout_completed`);
      expect(response.json().values).toHaveLength(1_000);
      expect(response.json().truncated).toBe(true);
    });
  });

  describe('the catalog export (AN-211)', () => {
    it('exports every name with its Lexicon as JSON and CSV, hidden ones included; export_analytics_catalog pages it', async () => {
      await send(h, db, [event({ params: { plan: 'pro', items: 2 } }), event({ name: 'cart_viewed' })]);
      await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/cart_viewed`, { hidden: true, description: 'Cart, "opened"' });
      await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/checkout_completed/params/plan`, { description: 'The plan.' });
      const json = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/exports/catalog?format=json`);
      expect(json.headers['content-disposition']).toMatch(/inlet-adb_[a-z0-9]+-catalog-\d{4}-\d{2}-\d{2}\.json/);
      const exported = json.json().events as { name: string; hidden: boolean; params: { key: string; types: string[]; description: string | null }[] }[];
      expect(exported.map((entry) => [entry.name, entry.hidden])).toEqual([
        ['cart_viewed', true],
        ['checkout_completed', false],
      ]);
      expect(exported[1]!.params).toEqual([
        { key: 'items', types: ['number'], description: null, firstSeen: expect.any(String) },
        { key: 'plan', types: ['string'], description: 'The plan.', firstSeen: expect.any(String) },
      ]);
      const csv = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/exports/catalog?format=csv`);
      const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0]).toBe('name,category,description,hidden,blocked,standard,firstSeen,lastSeen,events24h,installations24h,users24h,computedAt,params');
      expect(lines[1]).toContain('cart_viewed,,"Cart, ""opened""",true');
      expect(lines[2]).toContain('items (number); plan (string): The plan.');
      const page = JSON.parse(await tool(h.app, db.secret, 'export_analytics_catalog', { analyticsDatabaseId: db.id }));
      expect(page).toMatchObject({ total: 2, nextCursor: null });
      expect(page.events).toHaveLength(2);
    });
  });
});
