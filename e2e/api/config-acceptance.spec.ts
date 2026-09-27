import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { E2E } from '../env';
import { startFakeSlack, type FakeSlack } from '../slack-fake';

/**
 * Remote Config's acceptance through the real HTTP server and `/v1/mcp` (piece 11a): one agent
 * session over MCP doing everything section 12 lists, a template moved between two projects
 * that keeps every unit's bucket, and the user journeys of PRD section 5 that are not bound to
 * the interface (5.2, 5.3, 5.6, 5.7, 5.8), walked once each with the calls an integrator or an
 * agent makes. The interface's journeys are in `e2e/ui/config-acceptance.spec.ts`.
 */

type Playwright = PlaywrightWorkerArgs['playwright'];
type Fixture = { projectId: string; id: string; base: string; secret: string; publishable: string };

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
}

async function signIn(request: APIRequestContext): Promise<void> {
  expect((await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } })).status()).toBe(200);
}

async function project(request: APIRequestContext, name: string, databaseName = 'Mobile app'): Promise<Fixture> {
  const projectId = (await (await request.post('/v1/projects', { data: { name: `${name} ${Date.now()}` } })).json()).id as string;
  const key = async (type: 'secret' | 'publishable') => (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type, label: type } })).json()).secret as string;
  const created = await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: databaseName } });
  expect(created.status(), await created.text()).toBe(201);
  const id = (await created.json()).id as string;
  return { projectId, id, base: `/v1/config-databases/${id}`, secret: await key('secret'), publishable: await key('publishable') };
}

async function publishDraft(request: APIRequestContext, base: string, note?: string): Promise<number> {
  const revision = (await (await request.get(`${base}/draft`)).json()).revision as number;
  const published = await request.post(`${base}/publish`, { data: { revision, ...(note ? { note } : {}) } });
  expect(published.status(), await published.text()).toBe(201);
  return (await published.json()).version.number as number;
}

async function put(request: APIRequestContext, url: string, data: unknown): Promise<void> {
  const response = await request.put(url, { data });
  expect(response.status(), await response.text()).toBe(200);
}

/** A fetch as an application makes it: its publishable key, no session. */
async function fetcher(playwright: Playwright, fx: Fixture) {
  const app = await playwright.request.newContext({ baseURL: E2E.baseUrl, extraHTTPHeaders: { authorization: `Bearer ${fx.publishable}` } });
  const fetchFor = async (body: Record<string, unknown>) => {
    const response = await app.post(`${fx.base}/fetch`, { data: body });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as { version: number | null; values: Record<string, unknown>; experiments: Record<string, string>; live: string[]; etag: string; refreshIntervalSeconds: number };
  };
  return { fetchFor, dispose: () => app.dispose() };
}

const installations = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());

/** `map` 25 at a time: a burst of hundreds of connections at once overflows the listen backlog of a laptop, not the server. */
async function mapInBatches<T, R>(items: T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += 25) out.push(...(await Promise.all(items.slice(i, i + 25).map(map))));
  return out;
}

async function mcp(secret: string): Promise<{ call: (name: string, args: Record<string, unknown>, ok?: boolean) => Promise<string>; close: () => Promise<void> }> {
  const client = new Client({ name: 'inlet-config-acceptance', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${E2E.baseUrl}/v1/mcp`), { requestInit: { headers: { authorization: `Bearer ${secret}` } } }));
  return {
    call: async (name, args, ok = true) => {
      const result = await client.callTool({ name, arguments: args });
      expect((result as { isError?: boolean }).isError === true, `${name}: ${textOf(result)}`).toBe(!ok);
      return textOf(result);
    },
    close: () => client.close(),
  };
}

test('an MCP client with the project’s secret key reads, edits per parameter, previews, validates, publishes, rolls back and exports; a wrong name does not delete (PRD 12)', async ({ request }) => {
  await signIn(request);
  const fx = await project(request, 'Config agent');
  const agent = await mcp(fx.secret);
  try {
    const { call } = agent;
    // Read.
    expect(JSON.parse(await call('list_config_databases', { projectId: fx.projectId })).map((d: { id: string }) => d.id)).toEqual([fx.id]);
    expect(JSON.parse(await call('get_config_database', { configDatabaseId: fx.id }))).toMatchObject({ id: fx.id, name: 'Mobile app', refreshIntervalMinutes: 60, deriveCountry: true, activeVersion: null });
    expect(JSON.parse(await call('get_config_draft', { configDatabaseId: fx.id }))).toMatchObject({ revision: 0, template: { parameters: [], conditions: [] } });

    // Edit per part: a condition, then a parameter holding a value under it.
    await call('set_config_condition', { configDatabaseId: fx.id, conditionId: 'cnd_beta', name: 'Beta testers', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: ['u-1', 'u-2'] }] });
    const edited = JSON.parse(await call('set_config_parameter', { configDatabaseId: fx.id, key: 'new_checkout', type: 'boolean', default: false, live: true, conditional: [{ condition: 'cnd_beta', value: true }] }));
    expect(edited).toMatchObject({ revision: 2, problems: [] });
    await call('set_config_parameter', { configDatabaseId: fx.id, key: 'limit', type: 'number', default: 5 });

    // Preview the draft: the value and where it came from.
    const beta = JSON.parse(await call('preview_config', { configDatabaseId: fx.id, context: { userId: 'u-1' } }));
    expect(beta).toMatchObject({ source: 'draft', version: null, values: { new_checkout: true, limit: 5 } });
    expect(beta.parameters).toEqual(expect.arrayContaining([{ key: 'new_checkout', value: true, source: { kind: 'condition', condition: 'cnd_beta', name: 'Beta testers' } }, { key: 'limit', value: 5, source: { kind: 'default' } }]));
    const outsider = JSON.parse(await call('preview_config', { configDatabaseId: fx.id, context: { userId: 'u-9' } }));
    expect(outsider.values).toEqual({ new_checkout: false, limit: 5 });
    expect(outsider.conditions).toEqual([expect.objectContaining({ id: 'cnd_beta', result: false, firstFalseRule: 0 })]);

    // Validate, publish, publish again (harmless), change, publish, roll back.
    const validated = JSON.parse(await call('validate_config_draft', { configDatabaseId: fx.id }));
    expect(validated).toEqual({ revision: 3, problems: [], warnings: [] });
    expect(JSON.parse(await call('publish_config', { configDatabaseId: fx.id, revision: 3, note: 'Beta first.' }))).toMatchObject({ created: true, version: { number: 1, note: 'Beta first.', publishedBy: { kind: 'key' } } });
    expect(JSON.parse(await call('publish_config', { configDatabaseId: fx.id, revision: 3 }))).toMatchObject({ created: false, version: { number: 1 } });
    // A stale revision is refused with its code.
    await call('set_config_parameter', { configDatabaseId: fx.id, key: 'limit', type: 'number', default: 10 });
    expect(await call('publish_config', { configDatabaseId: fx.id, revision: 2 }, false)).toContain('stale_draft_revision');
    expect(JSON.parse(await call('publish_config', { configDatabaseId: fx.id, revision: 4, note: 'Limit 10.' })).version.number).toBe(2);
    expect(JSON.parse(await call('diff_config', { configDatabaseId: fx.id, from: 'active', to: 1 })).parameters).toEqual([expect.objectContaining({ key: 'limit', change: 'changed', before: expect.objectContaining({ default: 10 }), after: expect.objectContaining({ default: 5 }) })]);
    const rolled = JSON.parse(await call('rollback_config', { configDatabaseId: fx.id, version: 1, note: 'Back to 5.' }));
    expect(rolled).toMatchObject({ created: true, version: { number: 3, rolledBackFrom: 1 } });
    expect(JSON.parse(await call('preview_config', { configDatabaseId: fx.id, source: 'active', context: {} })).values).toEqual({ new_checkout: false, limit: 5 });

    // Export: the active template, the defaults as TypeScript and JSON, the whole history.
    const template = JSON.parse(await call('export_config_template', { configDatabaseId: fx.id, source: 'active' }));
    expect(template).toMatchObject({ format: 1, parameters: [expect.objectContaining({ key: 'new_checkout' }), expect.objectContaining({ key: 'limit', default: 5 })], conditions: [expect.objectContaining({ id: 'cnd_beta' })] });
    const ts = await call('export_config_defaults', { configDatabaseId: fx.id, source: 'active', format: 'ts' });
    expect(ts).toContain('export const configDefaults: ConfigDefaults = {');
    expect(ts).toContain('new_checkout: false,');
    expect(ts).toContain('limit: 5,');
    expect(JSON.parse(await call('export_config_defaults', { configDatabaseId: fx.id, source: 2, format: 'json' }))).toEqual({ new_checkout: false, limit: 10 });
    const history = JSON.parse(await call('export_config_history', { configDatabaseId: fx.id }));
    expect(history.versions.map((v: { number: number }) => v.number)).toEqual([1, 2, 3]);
    expect(history.activity.map((a: { kind: string }) => a.kind)).toEqual(['publish', 'publish', 'rollback']);
    expect(history.draft.revision).toBe(4);

    // Destructive: a wrong name deletes nothing.
    expect(await call('delete_config_database', { configDatabaseId: fx.id, confirm: 'Mobile' }, false)).toContain('confirmation_mismatch');
    expect(await call('delete_config_database', { configDatabaseId: fx.id, confirm: 'mobile app' }, false)).toContain('confirmation_mismatch');
    expect(JSON.parse(await call('get_config_database', { configDatabaseId: fx.id }))).toMatchObject({ id: fx.id, activeVersion: 3 });
    expect((await request.get(fx.base)).status()).toBe(200);
  } finally {
    await agent.close();
  }
});

test.describe('the PRD’s user journeys through the API and MCP', () => {
  let slack: FakeSlack;
  test.beforeAll(async () => {
    slack = await startFakeSlack();
  });
  test.afterAll(async () => {
    await slack.close();
  });
  test.beforeEach(() => {
    slack.reset();
  });

  /** Every string the Slack message holds, for "no value, rule or list" checks. */
  const strings = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

  test('5.2 and 5.3: a 10% rollout previewed, published and announced, raised to 50 and 100 keeping everyone, then an incident switch at the top and a shorter interval', async ({ request, playwright }) => {
    await signIn(request);
    const fx = await project(request, 'Journey rollout');
    const app = await fetcher(playwright, fx);
    try {
      const slackOn = await request.patch(`${fx.base}/slack-notifications`, { data: { webhookUrl: slack.webhookUrl, enabled: true } });
      expect(slackOn.status(), await slackOn.text()).toBe(200);
      // This database's messages only: the worker paces deliveries, so a previous test's later publishes can still arrive.
      const mine = () => slack.received.filter((message) => message.raw.includes(`/config-databases/${fx.id}?tab=history`));

      // 5.1's version 1: new_checkout, default false.
      await put(request, `${fx.base}/draft/parameters/new_checkout`, { type: 'boolean', default: false, live: true });
      expect(await publishDraft(request, fx.base)).toBe(1);
      await expect.poll(() => mine().length, { timeout: 30_000 }).toBe(1);

      // 5.2.1: "Early rollout", percentage 10 by installation, new_checkout true under it.
      const rollout = (value: number) => ({ name: 'Early rollout', kind: 'match', rules: [{ attribute: 'percentage', operator: 'lt', value, unit: 'installation' }] });
      await put(request, `${fx.base}/draft/conditions/cnd_rollout`, rollout(1000));
      await put(request, `${fx.base}/draft/parameters/new_checkout`, { type: 'boolean', default: false, live: true, conditional: [{ condition: 'cnd_rollout', value: true }] });

      // 5.2.2: Preview as one installation ID, and see which value it receives and why.
      const ids = installations(400);
      const previews = await Promise.all(ids.slice(0, 40).map(async (installationId) => ({ installationId, preview: await (await request.post(`${fx.base}/preview`, { data: { context: { installationId } } })).json() })));
      const inside = previews.find(({ preview }) => preview.values.new_checkout === true)!;
      expect(inside, 'one of 40 installations falls in the first tenth').toBeDefined();
      expect(inside.preview.parameters).toEqual([{ key: 'new_checkout', value: true, source: { kind: 'condition', condition: 'cnd_rollout', name: 'Early rollout' } }]);
      const outside = previews.find(({ preview }) => preview.values.new_checkout === false)!;
      expect(outside.preview.conditions).toEqual([expect.objectContaining({ id: 'cnd_rollout', result: false, firstFalseRule: 0 })]);

      // 5.2.3: version 2, "10% rollout"; Slack names the changed key, and no value or rule.
      expect(await publishDraft(request, fx.base, '10% rollout')).toBe(2);
      await expect.poll(() => mine().length, { timeout: 30_000 }).toBe(2);
      const announced = strings(mine()[1]!.body).join('\n');
      expect(announced).toContain('version 2 published by');
      expect(announced).toContain('10% rollout');
      expect(announced).toContain('new_checkout');
      expect(announced).toContain('Conditions: 1 added');
      for (const leak of ['true', 'false', 'percentage', '1000', 'installation', 'cnd_rollout']) expect(announced, leak).not.toContain(leak);

      // 5.2.4: the first tenth of the buckets receive true; 50 then 100 keep every one of them.
      const receiving = async () => new Set((await mapInBatches(ids, async (installationId) => ((await app.fetchFor({ installationId })).values.new_checkout ? installationId : null))).filter((id): id is string => id !== null));
      const at10 = await receiving();
      expect(at10.size).toBeGreaterThan(15);
      expect(at10.size).toBeLessThan(70);
      expect(at10.has(inside.installationId)).toBe(true);
      await put(request, `${fx.base}/draft/conditions/cnd_rollout`, rollout(5000));
      expect(await publishDraft(request, fx.base, '50%')).toBe(3);
      const at50 = await receiving();
      expect([...at10].filter((id) => !at50.has(id))).toEqual([]);
      expect(at50.size).toBeGreaterThan(140);
      expect(at50.size).toBeLessThan(260);
      await put(request, `${fx.base}/draft/conditions/cnd_rollout`, rollout(10000));
      expect(await publishDraft(request, fx.base, '100%')).toBe(4);
      expect((await receiving()).size).toBe(ids.length);

      // 5.3.2: the condition "1.5.0" at the top, new_checkout false under it, live.
      await put(request, `${fx.base}/draft/conditions/cnd_v150`, { name: '1.5.0', kind: 'match', rules: [{ attribute: 'appVersion', operator: 'versionEquals', value: '1.5.0' }] });
      await put(request, `${fx.base}/draft/conditions/order`, { order: ['cnd_v150', 'cnd_rollout'] });
      await put(request, `${fx.base}/draft/parameters/new_checkout`, { type: 'boolean', default: false, live: true, conditional: [{ condition: 'cnd_v150', value: false }, { condition: 'cnd_rollout', value: true }] });
      expect(await publishDraft(request, fx.base, 'Regression on 1.5.0')).toBe(5);
      const onBroken = await app.fetchFor({ installationId: ids[0], app: { version: '1.5.0' } });
      expect(onBroken).toMatchObject({ version: 5, values: { new_checkout: false }, live: ['new_checkout'], refreshIntervalSeconds: 3600 });
      expect((await app.fetchFor({ installationId: ids[0], app: { version: '1.5.1' } })).values.new_checkout).toBe(true);

      // 5.3.3: an Admin shortens the refresh interval to five minutes; the next fetch carries it.
      const shortened = await request.patch(fx.base, { data: { refreshIntervalMinutes: 5 } });
      expect(shortened.status(), await shortened.text()).toBe(200);
      await expect.poll(async () => (await app.fetchFor({ installationId: ids[0], app: { version: '1.5.0' } })).refreshIntervalSeconds, { timeout: 11_000 }).toBe(300);
      // The ETag is of the values, so an application that holds them is answered "not modified", with the new interval.
      expect(await app.fetchFor({ installationId: ids[0], app: { version: '1.5.0' }, etag: onBroken.etag })).toEqual({ notModified: true, refreshIntervalSeconds: 300 });
    } finally {
      await app.dispose();
    }
  });

  test('5.6 and section 12: a template exported from staging and imported into production’s draft is reviewed, publishes to the same values, and every unit falls in the same buckets in both', async ({ request, playwright }) => {
    await signIn(request);
    const staging = await project(request, 'Journey staging', 'Mobile app (staging)');
    const production = await project(request, 'Journey production', 'Mobile app');
    const template = {
      parameters: [
        { key: 'new_checkout', type: 'boolean', default: false, conditional: [{ condition: 'cnd_rollout', value: true }] },
        { key: 'paywall', type: 'json', default: { headline: 'Go Pro' }, conditional: [{ condition: 'cnd_paywall', variant: 'annual_first', value: { headline: 'Save 40%' } }] },
      ],
      conditions: [
        { id: 'cnd_rollout', name: 'Early rollout', kind: 'match', rules: [{ attribute: 'percentage', operator: 'lt', value: 3000, unit: 'installation' }] },
        { id: 'cnd_paywall', name: 'Paywall copy', kind: 'split', experiment: 'paywall_copy', unit: 'installation', rules: [], variants: [{ key: 'control', weight: 5000 }, { key: 'annual_first', weight: 5000 }] },
      ],
    };
    await put(request, `${staging.base}/draft`, { template });
    expect(await publishDraft(request, staging.base, 'Staging')).toBe(1);
    // Production already runs something else.
    await put(request, `${production.base}/draft/parameters/new_checkout`, { type: 'boolean', default: false });
    expect(await publishDraft(request, production.base)).toBe(1);

    // 5.6.2: export staging's active version as JSON and import it into production's draft.
    const exported = await request.get(`${staging.base}/export?source=active&format=json`);
    expect(exported.status()).toBe(200);
    const file = await exported.json();
    expect(file).toMatchObject({ format: 1 });
    const imported = await request.post(`${production.base}/draft/import`, { data: file });
    expect(imported.status(), await imported.text()).toBe(200);
    // RC-062: the IDs and salts are kept.
    const stagingSalts = (await (await request.get(`${staging.base}/versions/1`)).json()).template.conditions.map((c: { id: string; salt: string }) => [c.id, c.salt]);
    const productionDraft = await (await request.get(`${production.base}/draft`)).json();
    expect(productionDraft.template.conditions.map((c: { id: string; salt: string }) => [c.id, c.salt])).toEqual(stagingSalts);
    expect(productionDraft.differsFromActive).toBe(true);

    // Review the difference against production's active version, then publish.
    const diff = await (await request.get(`${production.base}/diff?from=active&to=draft`)).json();
    expect(diff).toMatchObject({ fromVersion: 1, toVersion: null });
    expect(diff.parameters.map((p: { key: string; change: string }) => [p.key, p.change])).toEqual([['new_checkout', 'changed'], ['paywall', 'added']]);
    expect(diff.conditions.map((c: { id: string; change: string }) => [c.id, c.change])).toEqual([['cnd_rollout', 'added'], ['cnd_paywall', 'added']]);
    expect(await publishDraft(request, production.base, 'From staging')).toBe(2);

    // The same installation IDs receive the same values and variants from both.
    const [a, b] = [await fetcher(playwright, staging), await fetcher(playwright, production)];
    try {
      const ids = installations(200);
      const answers = await mapInBatches(ids, async (installationId) => [await a.fetchFor({ installationId }), await b.fetchFor({ installationId })] as const);
      const mismatches = answers.filter(([x, y]) => JSON.stringify([x.values, x.experiments]) !== JSON.stringify([y.values, y.experiments]));
      expect(mismatches).toEqual([]);
      const inRollout = answers.filter(([x]) => x.values.new_checkout === true).length;
      const annual = answers.filter(([x]) => x.experiments.paywall_copy === 'annual_first').length;
      // Both groups are non-trivial: some in, some out.
      expect(inRollout).toBeGreaterThan(20);
      expect(inRollout).toBeLessThan(120);
      expect(annual).toBeGreaterThan(50);
      expect(annual).toBeLessThan(150);
      expect(answers.every(([x]) => x.experiments.paywall_copy === 'annual_first' || x.experiments.paywall_copy === 'control')).toBe(true);
      expect(answers.every(([x]) => (x.experiments.paywall_copy === 'annual_first') === ((x.values.paywall as { headline: string }).headline === 'Save 40%'))).toBe(true);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  test('5.7: an agent reads a crash group, adds an Android 14 condition, previews it, publishes citing the group, and removes it after the fix', async ({ request, playwright }) => {
    await signIn(request);
    const fx = await project(request, 'Journey agent');
    const crashId = (await (await request.post(`/v1/projects/${fx.projectId}/crash-databases`, { data: { name: 'Crashes' } })).json()).id as string;
    const reporter = await playwright.request.newContext({ baseURL: E2E.baseUrl, extraHTTPHeaders: { authorization: `Bearer ${fx.publishable}` } });
    const report = await reporter.post(`/v1/crash-databases/${crashId}/reports`, {
      data: {
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sdk: { name: 'inlet-sdk', version: '0.4.0' },
        platform: 'other',
        kind: 'exception',
        release: { version: '1.5.0' },
        os: { name: 'Android', version: '14' },
        exception: { type: 'IllegalStateException', message: 'Checkout sheet detached', handled: false, frames: [{ function: 'openCheckout', file: 'Checkout.kt', inApp: true }] },
      },
    });
    expect(report.status(), await report.text()).toBe(201);
    await reporter.dispose();
    await put(request, `${fx.base}/draft/parameters/new_checkout`, { type: 'boolean', default: true, live: true });
    expect(await publishDraft(request, fx.base)).toBe(1);

    const agent = await mcp(fx.secret);
    const app = await fetcher(playwright, fx);
    try {
      const { call } = agent;
      // 5.7.1: the crash group that only occurs on Android 14 with the new checkout.
      const groups = JSON.parse(await call('list_crash_groups', { crashDatabaseId: crashId }));
      const groupId = groups.groups[0].id as string;
      const group = JSON.parse(await call('get_crash_group', { crashDatabaseId: crashId, groupId }));
      expect(group).toMatchObject({ id: groupId, exceptionType: 'IllegalStateException', byRelease: [{ version: '1.5.0', count: 1 }] });
      expect(group.byOs).toEqual([{ os: 'Android', count: 1 }]);

      // 5.7.2: read the draft, add the condition with new_checkout false, preview, publish citing the group.
      const draft = JSON.parse(await call('get_config_draft', { configDatabaseId: fx.id }));
      expect(draft.template.parameters).toEqual([expect.objectContaining({ key: 'new_checkout', default: true })]);
      await call('set_config_condition', { configDatabaseId: fx.id, conditionId: 'cnd_android14', name: 'Android 14', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['android'] }, { attribute: 'osVersion', operator: 'versionEquals', value: '14' }] });
      const set = JSON.parse(await call('set_config_parameter', { configDatabaseId: fx.id, key: 'new_checkout', type: 'boolean', default: true, live: true, conditional: [{ condition: 'cnd_android14', value: false }] }));
      const preview = JSON.parse(await call('preview_config', { configDatabaseId: fx.id, context: { platform: 'android', os: { version: '14' } } }));
      expect(preview.parameters).toEqual([{ key: 'new_checkout', value: false, source: { kind: 'condition', condition: 'cnd_android14', name: 'Android 14' } }]);
      expect(JSON.parse(await call('preview_config', { configDatabaseId: fx.id, context: { platform: 'android', os: { version: '13' } } })).values).toEqual({ new_checkout: true });
      const note = `Off on Android 14: crash group ${groupId}.`;
      expect(JSON.parse(await call('publish_config', { configDatabaseId: fx.id, revision: set.revision, note }))).toMatchObject({ created: true, version: { number: 2, note } });
      expect((await app.fetchFor({ platform: 'android', os: { name: 'Android', version: '14' } })).values).toEqual({ new_checkout: false });
      expect((await app.fetchFor({ platform: 'ios', os: { name: 'iOS', version: '14' } })).values).toEqual({ new_checkout: true });

      // 5.7.3: after the fix ships in 1.5.1, it removes the condition and publishes again.
      const removed = JSON.parse(await call('delete_config_condition', { configDatabaseId: fx.id, conditionId: 'cnd_android14' }));
      expect(removed.affectedParameters).toEqual(['new_checkout']);
      const after = JSON.parse(await call('get_config_draft', { configDatabaseId: fx.id }));
      expect(after.template).toMatchObject({ conditions: [], parameters: [expect.objectContaining({ key: 'new_checkout', conditional: [] })] });
      expect(JSON.parse(await call('publish_config', { configDatabaseId: fx.id, revision: after.revision, note: 'Fixed in 1.5.1.' })).version.number).toBe(3);
      expect((await app.fetchFor({ platform: 'android', os: { name: 'Android', version: '14' } })).values).toEqual({ new_checkout: true });
      expect(JSON.parse(await call('list_config_activity', { configDatabaseId: fx.id })).activity.map((a: { version: number; note: string | null }) => [a.version, a.note])).toEqual([[3, 'Fixed in 1.5.1.'], [2, note], [1, null]]);
    } finally {
      await agent.close();
      await app.dispose();
    }
  });

  test('5.8: compare the active version with the one before, roll back, the draft still holds the change and says so until the restored version is copied into it', async ({ request, playwright }) => {
    await signIn(request);
    const fx = await project(request, 'Journey rollback');
    const onboarding = (headline: string) => ({ type: 'json', default: { headline, steps: ['welcome', 'plans'] }, schema: { type: 'object', required: ['headline', 'steps'] } });
    await put(request, `${fx.base}/draft/parameters/onboarding`, onboarding('Welcome to the shop'));
    expect(await publishDraft(request, fx.base, 'Onboarding')).toBe(1);
    await put(request, `${fx.base}/draft/parameters/onboarding`, onboarding('Welcom to teh shop'));
    expect(await publishDraft(request, fx.base, 'New copy')).toBe(2);
    const app = await fetcher(playwright, fx);
    try {
      const before = await app.fetchFor({});
      expect(before.values.onboarding).toMatchObject({ headline: 'Welcom to teh shop' });

      // 5.8.2: compare the active version with the one before: the difference the rollback makes.
      const compare = await (await request.get(`${fx.base}/diff?from=active&to=1`)).json();
      expect(compare).toMatchObject({ fromVersion: 2, toVersion: 1, warnings: [] });
      expect(compare.parameters).toEqual([expect.objectContaining({ key: 'onboarding', change: 'changed', before: expect.objectContaining({ default: expect.objectContaining({ headline: 'Welcom to teh shop' }) }), after: expect.objectContaining({ default: expect.objectContaining({ headline: 'Welcome to the shop' }) }) })]);
      const draftBefore = await (await request.get(`${fx.base}/draft`)).json();
      const rolled = await request.post(`${fx.base}/rollback`, { data: { version: 1, note: 'Typo in the copy.' } });
      expect(rolled.status(), await rolled.text()).toBe(201);
      expect(await rolled.json()).toMatchObject({ created: true, version: { number: 3, rolledBackFrom: 1, note: 'Rolled back to version 1. Typo in the copy.' } });
      // A new version equal to the old one, picked up like any other.
      expect((await (await request.get(`${fx.base}/versions/3`)).json()).template).toEqual((await (await request.get(`${fx.base}/versions/1`)).json()).template);
      const afterRollback = await app.fetchFor({ etag: before.etag });
      expect(afterRollback).toMatchObject({ version: 3, values: { onboarding: { headline: 'Welcome to the shop' } } });

      // 5.8.3: the draft still holds the wrong copy, and differs from the active version.
      const draftAfter = await (await request.get(`${fx.base}/draft`)).json();
      expect(draftAfter).toMatchObject({ revision: draftBefore.revision, differsFromActive: true, template: draftBefore.template });
      const copied = await request.post(`${fx.base}/draft/copy`, { data: { version: 3 } });
      expect(copied.status(), await copied.text()).toBe(200);
      const restored = await (await request.get(`${fx.base}/draft`)).json();
      expect(restored).toMatchObject({ revision: draftBefore.revision + 1, differsFromActive: false });
      expect(restored.template.parameters[0].default.headline).toBe('Welcome to the shop');
    } finally {
      await app.dispose();
    }
  });
});
