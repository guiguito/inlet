import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import {
  asAdmin,
  createCredential,
  createIntent,
  createProject,
  setupPublishedForm,
  withKey,
} from '../setup/api.js';

/**
 * The cross-origin collection surface (FD-015).
 *
 * The browser adapters of `inlet-sdk` run on the integrator's own origin, so the health
 * probe, crash ingest and the four feedback collection routes answer cross-origin, and
 * everything else does not. What is worth pinning here is the boundary, in both
 * directions: the paths that must work from a browser, and a list of near neighbours —
 * including the route that returns collected responses — that must not.
 *
 * `inject` does not enforce CORS the way a browser does; it lets us observe exactly what
 * the server granted, which is the stronger assertion. The browser half is
 * `e2e/api/sdk-browser.spec.ts` and `e2e/api/sdk-feedback-browser.spec.ts`, which drive
 * real Chromium from a real second origin.
 */
describe('cross-origin collection', () => {
  let h: Harness;
  let projectId: string;
  let crashDatabaseId: string;
  let publishable: string;
  let feedback: Awaited<ReturnType<typeof setupPublishedForm>>;

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
    crashDatabaseId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Desktop app' })).json().id;
    publishable = (await createCredential(h, projectId, 'publishable')).secret;
    feedback = await setupPublishedForm(h, referenceDefinition(ids()));
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
  const preflight = (url: string, method = 'POST', requestHeaders = 'authorization,content-type') =>
    h.app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': method,
        'access-control-request-headers': requestHeaders,
      },
    });

  it('answers the ingest preflight, so a browser on another origin may report at all', async () => {
    for (const url of [`/v1/crash-databases/${crashDatabaseId}/reports`, `/v1/crash-databases/${crashDatabaseId}/reports/batch`]) {
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

  /**
   * FD-015: the four feedback collection routes, each with the method the SDK uses.
   *
   * The intent token is the one header the crash routes never needed, and a preflight
   * that does not name it fails in the browser without ever reaching a handler, so it is
   * asserted on every route that carries one.
   */
  it('answers the preflight on each of the four feedback collection routes', async () => {
    const db = `/v1/feedback-databases/${feedback.databaseId}`;
    const intent = await createIntent(h, feedback.publishableKey, feedback.databaseId);
    const routes: [string, string][] = [
      [`${db}/form`, 'GET'],
      [`${db}/submission-intents`, 'POST'],
      [`${db}/submission-intents/${intent.intentId}/attachments`, 'POST'],
      [`${db}/submission-intents/${intent.intentId}/attachments/att_whatever`, 'DELETE'],
      [`${db}/submission-intents/${intent.intentId}/submit`, 'POST'],
    ];
    for (const [url, method] of routes) {
      const response = await preflight(url, method, 'authorization,content-type,x-inlet-intent-token');
      expect(response.statusCode, `${method} ${url}`).toBe(204);
      expect(response.headers['access-control-allow-origin'], url).toBe('*');
      expect(response.headers['access-control-allow-headers'], url).toContain('x-inlet-intent-token');
      expect(response.headers['access-control-allow-methods'], url).toContain(method);
      expect(response.headers['access-control-allow-credentials'], url).toBeUndefined();
    }
  });

  it('carries the origin on the answer, on a refusal, and on the health probe', async () => {
    const accepted = await withKey(h.app, publishable, 'POST', `/v1/crash-databases/${crashDatabaseId}/reports`, envelope());
    expect(accepted.statusCode).toBe(201);
    expect(accepted.headers['access-control-allow-origin']).toBe('*');
    // CR-016: Retry-After is not CORS-safelisted, so a cross-origin client cannot read it
    // unless it is exposed, and would back off on a guess instead of the server's number.
    expect(accepted.headers['access-control-expose-headers']).toContain('retry-after');
    expect(accepted.headers['access-control-allow-credentials']).toBeUndefined();

    // A cross-origin error response without the header is an opaque network failure to
    // fetch, and the SDK would requeue for ever a report the server has already refused.
    const refused = await withKey(h.app, 'ipk_not_a_real_key', 'POST', `/v1/crash-databases/${crashDatabaseId}/reports`, envelope());
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['access-control-allow-origin']).toBe('*');

    // The same on the feedback side, on the answer and on the refusal.
    const form = await withKey(h.app, feedback.publishableKey, 'GET', `/v1/feedback-databases/${feedback.databaseId}/form`);
    expect(form.statusCode).toBe(200);
    expect(form.headers['access-control-allow-origin']).toBe('*');
    const wrongKey = await withKey(h.app, 'ipk_not_a_real_key', 'GET', `/v1/feedback-databases/${feedback.databaseId}/form`);
    expect(wrongKey.statusCode).toBe(401);
    expect(wrongKey.headers['access-control-allow-origin']).toBe('*');

    // FD-013: the SDK reads this before its first send to tell an old deployment from an
    // unreachable one, so it has to be readable cross-origin too.
    const health = await h.app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.headers['access-control-allow-origin']).toBe('*');
    // FR-210: and it has to say that this deployment answers feedback cross-origin.
    expect(health.json().capabilities).toContain('feedback-cross-origin');
  });

  it('leaves every other route same-origin', async () => {
    const closed = [
      `/v1/crash-databases/${crashDatabaseId}`,
      `/v1/projects/${projectId}/crash-databases`,
      // The nearest misses to the pattern: crash routes under the same prefix.
      `/v1/crash-databases/${crashDatabaseId}/reports/crp_whatever`,
      `/v1/crash-databases/${crashDatabaseId}/groups`,
      '/v1/feedback-databases',
      // And the feedback ones. The first of these is the whole point of the boundary:
      // collecting a response is open, reading collected responses is not.
      `/v1/feedback-databases/${feedback.databaseId}/submissions`,
      `/v1/feedback-databases/${feedback.databaseId}/submissions/sub_whatever`,
      `/v1/feedback-databases/${feedback.databaseId}`,
      `/v1/feedback-databases/${feedback.databaseId}/versions`,
      `/v1/feedback-databases/${feedback.databaseId}/form/draft`,
      `/v1/feedback-databases/${feedback.databaseId}/hosted-form`,
      `/v1/feedback-databases/${feedback.databaseId}/submission-intents/si_whatever`,
      '/v1/attachments/att_whatever',
      // The hosted form is served by Inlet itself and stays closed (FD-015).
      '/v1/hosted/some-slug/form',
      '/v1/hosted/some-slug/submission-intents',
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
    const managed = await asAdmin(h, 'GET', `/v1/crash-databases/${crashDatabaseId}`);
    expect(managed.statusCode).toBe(200);
    expect(managed.headers['access-control-allow-origin']).toBeUndefined();
    const responses = await asAdmin(h, 'GET', `/v1/feedback-databases/${feedback.databaseId}/submissions`);
    expect(responses.statusCode).toBe(200);
    expect(responses.headers['access-control-allow-origin']).toBeUndefined();
    const session = await asAdmin(h, 'GET', '/v1/auth/me');
    expect(session.headers['access-control-allow-origin']).toBeUndefined();
  });
});
