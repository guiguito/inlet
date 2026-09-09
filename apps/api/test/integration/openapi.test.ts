import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_STATUS } from '@inlet/shared';
import { createHarness, type Harness } from '../setup/harness.js';

/**
 * FR-095, FR-097: consistent responses and a versioned, documented API.
 *
 * The document is generated from the same Zod schemas the routes validate against,
 * so these assertions also prove the published contract matches the server.
 */
type Operation = { summary?: string; description?: string; responses: Record<string, unknown> };
type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  components: { securitySchemes: Record<string, unknown> };
  paths: Record<string, Record<string, Operation>>;
};

describe('the OpenAPI document', () => {
  let h: Harness;
  let document: OpenApiDocument;

  beforeAll(async () => {
    h = await createHarness();
    const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    document = JSON.parse(response.body) as OpenApiDocument;
  });
  afterAll(async () => {
    await h.close();
  });

  it('is OpenAPI 3.1 and names this deployment as its server', () => {
    expect(document.openapi.startsWith('3.1')).toBe(true);
    expect(document.info.title).toBe('Inlet API');
    expect(document.servers[0]?.url).toBe('http://inlet.test');
  });

  it('documents both authentication schemes', () => {
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
      'projectKey',
      'session',
    ]);
  });

  it('covers every route the product exposes', () => {
    const expected = [
      '/v1/auth/sign-in',
      '/v1/auth/sign-out',
      '/v1/auth/me',
      '/v1/projects',
      '/v1/projects/{projectId}',
      '/v1/projects/{projectId}/feedback-databases',
      '/v1/projects/{projectId}/credentials',
      '/v1/projects/{projectId}/credentials/{credentialId}',
      '/v1/projects/{projectId}/credentials/{credentialId}/rotate',
      '/v1/projects/{projectId}/credentials/{credentialId}/revoke',
      '/v1/feedback-databases/{databaseId}',
      '/v1/feedback-databases/{databaseId}/deletion-impact',
      '/v1/feedback-databases/{databaseId}/form',
      '/v1/feedback-databases/{databaseId}/form/draft',
      '/v1/feedback-databases/{databaseId}/form/versions',
      '/v1/feedback-databases/{databaseId}/form/publish',
      '/v1/feedback-databases/{databaseId}/form/unpublish',
      '/v1/feedback-databases/{databaseId}/form/rollback',
      '/v1/feedback-databases/{databaseId}/submission-intents',
      '/v1/feedback-databases/{databaseId}/submission-intents/{intentId}/submit',
      '/v1/feedback-databases/{databaseId}/submission-intents/{intentId}/attachments',
      '/v1/feedback-databases/{databaseId}/submissions',
      '/v1/feedback-databases/{databaseId}/submissions/export',
      '/v1/feedback-databases/{databaseId}/submissions/{submissionId}',
      '/v1/feedback-databases/{databaseId}/slack-notifications',
      '/v1/feedback-databases/{databaseId}/slack-notifications/test',
      '/v1/attachments/{attachmentId}',
    ];
    for (const path of expected) expect(Object.keys(document.paths)).toContain(path);
  });

  it('hides the health check and the document itself', () => {
    expect(Object.keys(document.paths)).not.toContain('/v1/health');
    expect(Object.keys(document.paths)).not.toContain('/openapi.json');
  });

  it('gives every operation a summary and at least one documented response', () => {
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.summary, `${method} ${path}`).toBeTruthy();
        expect(Object.keys(operation.responses).length, `${method} ${path}`).toBeGreaterThan(0);
      }
    }
  });

  it('explains the retry contract where a client needs it', () => {
    const submit =
      document.paths['/v1/feedback-databases/{databaseId}/submission-intents/{intentId}/submit'];
    const serialized = JSON.stringify(submit?.post ?? {});
    expect(serialized).toContain('duplicate');
    expect(serialized).toContain('intent_payload_conflict');
    expect(serialized).toContain('submission_deleted');
  });

  it('gets a client started with a worked example and the answer shapes', () => {
    const { description } = document.info;
    expect(description).toContain('submission-intents');
    expect(description).toContain('Authorization: Bearer');
    expect(description).toContain('optionIds');
    expect(description).toContain('attachmentIds');
    expect(description).toContain('clientContext');
  });

  it('keeps every documented error code in the shared contract', () => {
    const serialized = JSON.stringify(document);
    for (const code of ['validation_failed', 'intent_payload_conflict', 'submission_deleted']) {
      expect(serialized).toContain(code);
      expect(Object.keys(ERROR_STATUS)).toContain(code);
    }
  });

  it('serves rendered documentation', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/docs' });
    expect([200, 302]).toContain(response.statusCode);
  });
});
