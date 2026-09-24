import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { crashReports, submissions } from '../../src/db/schema.js';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createIntent, createProject, errorCode, finalize, setupPublishedForm, withKey } from '../setup/api.js';

/**
 * The server half of the shared SDK identity and the platform amendments that came with
 * it: Foundations FD-015, FD-016, FD-032, §12.2; Crash Reports CR-011, CR-015, CR-040,
 * CR-118; Feedback Collection FR-062, FR-062B, FR-111, FR-204.
 */

const INSTALLATION = '0190A1B2C3D44E5F8A6B7C8D9E0F1A2B'; // upper case, no dashes: any form is accepted
const INSTALLATION_STORED = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const SESSION = '0190a1b2-c3d4-7e5f-8a6b-000000000001';

describe('the SDK identity on the server', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    resetCrashRateLimits();
  });

  it('health lists identity, so an SDK knows it may send the fields (FD-015, FD-016)', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.json().capabilities).toContain('identity');
  });

  describe('crash reports (CR-118, CR-040, CR-011)', () => {
    let databaseId: string;
    let key: string;

    beforeEach(async () => {
      const projectId = await createProject(h);
      databaseId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'App' })).json().id;
      key = (await createCredential(h, projectId, 'publishable')).secret;
    });

    const envelope = (overrides: Record<string, unknown> = {}) => ({
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sdk: { name: 'inlet-sdk', version: '0.2.0' },
      kind: 'exception',
      release: { version: '1.0.0' },
      exception: { type: 'TypeError', message: 'boom', handled: false, frames: [{ function: 'run', file: 'main.js', inApp: true }] },
      ...overrides,
    });
    const report = (body: unknown) => withKey(h.app, key, 'POST', `/v1/crash-databases/${databaseId}/reports`, body);

    it('stores both IDs lowercase and dashed, returns them, and filters groups and reports by them', async () => {
      const stored = await report(envelope({ installationId: INSTALLATION, sessionId: SESSION.toUpperCase() }));
      expect(stored.statusCode).toBe(201);
      await report(envelope({ exception: { type: 'RangeError', message: 'other', handled: false, frames: [] } }));

      const [row] = await h.ctx.db.select().from(crashReports).where(eq(crashReports.id, stored.json().reportId));
      expect(row).toMatchObject({ installationId: INSTALLATION_STORED, sessionId: SESSION });
      expect(row!.envelope).toMatchObject({ installationId: INSTALLATION_STORED, sessionId: SESSION });

      const read = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/reports/${stored.json().reportId}`);
      expect(read.json()).toMatchObject({ installationId: INSTALLATION_STORED, sessionId: SESSION });

      // Searched in any form too.
      const groups = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/groups?installationId=${INSTALLATION}`);
      expect(groups.statusCode).toBe(200);
      expect(groups.json().groups.map((g: { id: string }) => g.id)).toEqual([stored.json().groupId]);
      const bySession = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/groups?sessionId=${SESSION}`);
      expect(bySession.json().total).toBe(1);

      const reports = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/groups/${stored.json().groupId}/reports?sessionId=${SESSION}`);
      expect(reports.json().reports).toHaveLength(1);

      const exported = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/reports/export?installationId=${INSTALLATION_STORED}`);
      const lines = exported.body.split('\n').filter(Boolean).map((line: string) => JSON.parse(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ installationId: INSTALLATION_STORED, sessionId: SESSION });
    });

    it('refuses an identity that is not a UUID, naming the field, and a filter that is not one', async () => {
      const refused = await report(envelope({ sessionId: 'not-a-uuid' }));
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.details[0].path).toBe('sessionId');
      const filter = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/groups?sessionId=nope`);
      expect(filter.statusCode).toBe(400);
    });

    it('stores a report whose strings carry U+0000 or a lone surrogate, cleaned', async () => {
      const stored = await report(
        envelope({
          exception: { type: 'Type\u0000Error', message: 'bad \uD800 half and a \uDC00 tail', handled: false, frames: [] },
          context: { 'key\u0000': 'value \uDBFF' },
          user: { id: 'u\u0000ser' },
        }),
      );
      expect(stored.statusCode).toBe(201);
      const [row] = await h.ctx.db.select().from(crashReports).where(eq(crashReports.id, stored.json().reportId));
      expect(row!.envelope.exception).toMatchObject({ type: 'TypeError', message: 'bad � half and a � tail' });
      expect(row!.envelope.context).toEqual({ key: 'value �' });
      expect(row!.userId).toBe('user');
    });
  });

  describe('submissions (FR-062, FR-062B, FR-111, FR-204)', () => {
    let f = ids();
    let form: Awaited<ReturnType<typeof setupPublishedForm>>;

    beforeEach(async () => {
      f = ids();
      form = await setupPublishedForm(h, referenceDefinition(f));
    });

    const answers = () => ({
      [f.mood]: { optionId: f.moodOptions[0] },
      [f.areas]: { optionIds: [f.areaOptions[0]] },
      [f.detail]: { value: 'Fine.' },
    });

    it('stores the IDs, reads and exports them, and keeps them out of the retry comparison', async () => {
      const intent = await createIntent(h, form.publishableKey, form.databaseId);
      const body = { formVersion: 1, answers: answers(), installationId: INSTALLATION, sessionId: SESSION, userId: 'user-7' };
      const created = await finalize(h, form.publishableKey, form.databaseId, intent, body);
      expect(created.statusCode).toBe(201);
      const submissionId = created.json().submissionId;

      const [row] = await h.ctx.db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(row).toMatchObject({ installationId: INSTALLATION_STORED, sessionId: SESSION, userId: 'user-7' });

      // A replay whose identity differs, as a new session on the next launch would give,
      // is the same payload (FR-092C): the identity is not compared.
      const replay = await finalize(h, form.publishableKey, form.databaseId, intent, { ...body, sessionId: crypto.randomUUID() });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ status: 'duplicate', submissionId });

      const read = await asAdmin(h, 'GET', `/v1/feedback-databases/${form.databaseId}/submissions/${submissionId}`);
      expect(read.json()).toMatchObject({ installationId: INSTALLATION_STORED, sessionId: SESSION, userId: 'user-7' });

      const json = await asAdmin(h, 'GET', `/v1/feedback-databases/${form.databaseId}/submissions/export?format=json`);
      expect(JSON.parse(json.body).submissions[0]).toMatchObject({ installationId: INSTALLATION_STORED, sessionId: SESSION, userId: 'user-7' });
      const csv = await asAdmin(h, 'GET', `/v1/feedback-databases/${form.databaseId}/submissions/export?format=csv`);
      const [header, first] = csv.body.replace(/^﻿/, '').split('\r\n');
      expect(header!.split(',').slice(-3)).toEqual(['installation_id', 'session_id', 'user_id']);
      expect(first!.endsWith(`${INSTALLATION_STORED},${SESSION},user-7`)).toBe(true);
    });

    it('stores a submission without identity with the fields null, as before', async () => {
      const intent = await createIntent(h, form.publishableKey, form.databaseId);
      const created = await finalize(h, form.publishableKey, form.databaseId, intent, { formVersion: 1, answers: answers() });
      const [row] = await h.ctx.db.select().from(submissions).where(eq(submissions.id, created.json().submissionId));
      expect(row).toMatchObject({ installationId: null, sessionId: null, userId: null });
    });

    it('refuses an installation ID that is not a UUID', async () => {
      const intent = await createIntent(h, form.publishableKey, form.databaseId);
      const refused = await finalize(h, form.publishableKey, form.databaseId, intent, { formVersion: 1, answers: answers(), installationId: 'device-42' });
      expect(refused.statusCode).toBe(400);
      expect(errorCode(refused)).toBe('validation_failed');
    });

    it('stores answers and clientContext carrying U+0000 or a lone surrogate, cleaned (FR-062B)', async () => {
      const intent = await createIntent(h, form.publishableKey, form.databaseId);
      const created = await finalize(h, form.publishableKey, form.databaseId, intent, {
        formVersion: 1,
        answers: { ...answers(), [f.detail]: { value: 'nul\u0000 and \uD83D half' } },
        clientContext: { 'build\u0000': ['\uDE00'] },
      });
      expect(created.statusCode).toBe(201);
      const [row] = await h.ctx.db.select().from(submissions).where(eq(submissions.id, created.json().submissionId));
      expect(row!.answers[f.detail]).toEqual({ type: 'text', value: 'nul and � half' });
      expect(row!.clientContext).toEqual({ build: ['�'] });
    });
  });

  it('logs every request by its route pattern, with no address, port or identifier (§12.2, CR-015, AN-019)', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
    const app = await buildApp({ ...h.ctx, log });
    await app.ready();
    try {
      const projectId = await createProject(h);
      const databaseId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'App' })).json().id;
      await app.inject({ method: 'GET', url: `/v1/crash-databases/${databaseId}/groups?installationId=${INSTALLATION_STORED}`, remoteAddress: '203.0.113.9' });
      await app.inject({ method: 'POST', url: `/v1/crash-databases/${databaseId}/reports`, remoteAddress: '203.0.113.9', payload: {} });
      const text = lines.join('');
      const requests = lines.map((line) => JSON.parse(line) as { req?: Record<string, unknown> }).filter((entry) => entry.req);
      expect(requests.map((entry) => entry.req)).toEqual([
        { method: 'GET', route: '/v1/crash-databases/:databaseId/groups' },
        { method: 'POST', route: '/v1/crash-databases/:databaseId/reports' },
      ]);
      for (const secret of ['203.0.113.9', INSTALLATION_STORED, databaseId, 'remotePort']) expect(text).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
});

describe('operator overrides (FD-032)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({
      INLET_DISABLE_RATE_LIMITS: 'false',
      INLET_LIMIT_CRASH_PER_KEY_5M: '10',
      INLET_CRASH_RETENTION_REPORTS_MIN: '500',
      INLET_CRASH_RETENTION_REPORTS_DEFAULT: '2000',
      INLET_CRASH_RETENTION_REPORTS_MAX: '5000',
      INLET_LIMIT_FEEDBACK_INTENTS_PER_HOUR: '2',
    });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    resetCrashRateLimits();
  });

  it('moves the crash retention bounds and default, and refuses a value outside them', async () => {
    const projectId = await createProject(h);
    const databaseId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'App' })).json().id;
    const read = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/retention`);
    expect(read.json()).toMatchObject({ maxReports: 2000, bounds: { maxReports: { min: 500, max: 5000, default: 2000 } } });
    expect((await asAdmin(h, 'PATCH', `/v1/crash-databases/${databaseId}/retention`, { maxReports: 600 })).statusCode).toBe(200);
    expect((await asAdmin(h, 'PATCH', `/v1/crash-databases/${databaseId}/retention`, { maxReports: 6000 })).statusCode).toBe(400);
  });

  it('applies the operator’s crash ingest limit', async () => {
    const projectId = await createProject(h);
    const databaseId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'App' })).json().id;
    const key = (await createCredential(h, projectId, 'publishable')).secret;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const response = await withKey(h.app, key, 'POST', `/v1/crash-databases/${databaseId}/reports`, {
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sdk: { name: 'inlet-sdk', version: '0.2.0' },
        kind: 'message',
        release: { version: '1.0.0' },
        exception: { type: 'Message', message: `m${i}`, handled: true, frames: [] },
        fingerprint: [`distinct-${i}`],
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([...Array(10).fill(201), 429]);
  });

  it('applies the operator’s feedback intent limit', async () => {
    const f = ids();
    const form = await setupPublishedForm(h, referenceDefinition(f));
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await withKey(h.app, form.publishableKey, 'POST', `/v1/feedback-databases/${form.databaseId}/submission-intents`, {})).statusCode);
    }
    expect(statuses).toEqual([201, 201, 429]);
  });

  it('refuses at startup a value outside the hard limits, or bounds that disagree', async () => {
    await expect(createHarness({ INLET_LIMIT_CRASH_PER_KEY_5M: '5' })).rejects.toThrow(/INLET_LIMIT_CRASH_PER_KEY_5M: must be an integer from 10/);
    await expect(createHarness({ INLET_CRASH_RETENTION_DAYS_MIN: '30', INLET_CRASH_RETENTION_DAYS_DEFAULT: '20' })).rejects.toThrow(/MIN ≤ DEFAULT ≤ MAX/);
  });
});
