import type { FastifyInstance } from 'fastify';
import type { FormDefinition } from '@inlet/shared';
import type { Harness } from './harness.js';

/**
 * Thin wrappers over app.inject for the calls tests make constantly. They keep the
 * assertions about behaviour rather than about request plumbing.
 */

type Json = Record<string, unknown>;

export async function asAdmin(
  h: Harness,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return h.app.inject({
    method,
    url,
    headers: { cookie: h.cookie },
    ...(payload === undefined ? {} : { payload }),
  });
}

export async function withKey(
  app: FastifyInstance,
  key: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}`, ...extraHeaders },
    ...(payload === undefined ? {} : { payload }),
  });
}

function body<T = Json>(response: { statusCode: number; body: string }, expected: number): T {
  if (response.statusCode !== expected) {
    throw new Error(`expected ${expected}, got ${response.statusCode}: ${response.body}`);
  }
  return JSON.parse(response.body) as T;
}

export async function createProject(h: Harness, name = 'Project'): Promise<string> {
  const response = await asAdmin(h, 'POST', '/v1/projects', { name });
  return body<{ id: string }>(response, 201).id;
}

export async function createDatabase(
  h: Harness,
  projectId: string,
  name = 'Feedback',
): Promise<string> {
  const response = await asAdmin(h, 'POST', `/v1/projects/${projectId}/feedback-databases`, {
    name,
  });
  return body<{ id: string }>(response, 201).id;
}

export async function saveDraft(
  h: Harness,
  databaseId: string,
  definition: FormDefinition,
): Promise<number> {
  const response = await asAdmin(h, 'PUT', `/v1/feedback-databases/${databaseId}/form/draft`, {
    definition,
  });
  return body<{ revision: number }>(response, 200).revision;
}

export async function publish(
  h: Harness,
  databaseId: string,
  expectedRevision?: number,
): Promise<number> {
  const response = await asAdmin(
    h,
    'POST',
    `/v1/feedback-databases/${databaseId}/form/publish`,
    expectedRevision === undefined ? {} : { expectedRevision },
  );
  return body<{ version: number }>(response, 201).version;
}

export async function createCredential(
  h: Harness,
  projectId: string,
  type: 'publishable' | 'secret',
  label = type,
): Promise<{ id: string; secret: string }> {
  const response = await asAdmin(h, 'POST', `/v1/projects/${projectId}/credentials`, {
    type,
    label,
  });
  return body<{ id: string; secret: string }>(response, 201);
}

export async function createIntent(
  h: Harness,
  key: string,
  databaseId: string,
  formVersion?: number,
): Promise<{ intentId: string; token: string; formVersion: number; expiresAt: string }> {
  const response = await withKey(
    h.app,
    key,
    'POST',
    `/v1/feedback-databases/${databaseId}/submission-intents`,
    formVersion === undefined ? {} : { formVersion },
  );
  return body<{ intentId: string; token: string; formVersion: number; expiresAt: string }>(
    response,
    201,
  );
}

export async function finalize(
  h: Harness,
  key: string,
  databaseId: string,
  intent: { intentId: string; token: string },
  payload: unknown,
) {
  return withKey(
    h.app,
    key,
    'POST',
    `/v1/feedback-databases/${databaseId}/submission-intents/${intent.intentId}/submit`,
    payload,
    { 'x-inlet-intent-token': intent.token },
  );
}

export async function uploadScreenshot(
  h: Harness,
  key: string,
  databaseId: string,
  intent: { intentId: string; token: string },
  questionId: string,
  file: Buffer,
  filename = 'screenshot.png',
  contentType = 'image/png',
) {
  const boundary = '----inlettest';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="questionId"\r\n\r\n${questionId}\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return h.app.inject({
    method: 'POST',
    url: `/v1/feedback-databases/${databaseId}/submission-intents/${intent.intentId}/attachments`,
    headers: {
      authorization: `Bearer ${key}`,
      'x-inlet-intent-token': intent.token,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
}

/** Full setup: project, database, published reference form, both credential types. */
export async function setupPublishedForm(
  h: Harness,
  definition: FormDefinition,
): Promise<{
  projectId: string;
  databaseId: string;
  version: number;
  publishableKey: string;
  secretKey: string;
}> {
  const projectId = await createProject(h);
  const databaseId = await createDatabase(h, projectId);
  await saveDraft(h, databaseId, definition);
  const version = await publish(h, databaseId);
  const publishable = await createCredential(h, projectId, 'publishable');
  const secret = await createCredential(h, projectId, 'secret');
  return {
    projectId,
    databaseId,
    version,
    publishableKey: publishable.secret,
    secretKey: secret.secret,
  };
}

export function errorCode(response: { body: string }): string {
  return (JSON.parse(response.body) as { error: { code: string } }).error.code;
}

export function errorDetails(response: { body: string }): {
  questionId?: string;
  path?: string;
  code: string;
  message: string;
}[] {
  const parsed = JSON.parse(response.body) as {
    error: { details?: { questionId?: string; path?: string; code: string; message: string }[] };
  };
  return parsed.error.details ?? [];
}

// --- The hosted form -------------------------------------------------------

/** The hosted form, enabled and ready to collect at its generated address. */
export async function enableHostedForm(
  h: Harness,
  databaseId: string,
): Promise<{ slug: string; url: string }> {
  const response = await asAdmin(h, 'PATCH', `/v1/feedback-databases/${databaseId}/hosted-form`, {
    enabled: true,
  });
  return body<{ slug: string; url: string }>(response, 200);
}

export async function hostedIntent(
  h: Harness,
  slug: string,
): Promise<{ intentId: string; token: string; formVersion: number }> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/v1/hosted/${slug}/submission-intents`,
  });
  return body<{ intentId: string; token: string; formVersion: number }>(response, 201);
}

export async function hostedSubmit(
  h: Harness,
  slug: string,
  intent: { intentId: string; token: string },
  payload: unknown,
) {
  return h.app.inject({
    method: 'POST',
    url: `/v1/hosted/${slug}/submission-intents/${intent.intentId}/submit`,
    headers: { 'x-inlet-intent-token': intent.token },
    payload: payload as never,
  });
}

export async function hostedUpload(
  h: Harness,
  slug: string,
  intent: { intentId: string; token: string },
  questionId: string,
  file: Buffer,
  filename = 'screenshot.png',
  contentType = 'image/png',
) {
  const boundary = '----inlethosted';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="questionId"\r\n\r\n${questionId}\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return h.app.inject({
    method: 'POST',
    url: `/v1/hosted/${slug}/submission-intents/${intent.intentId}/attachments`,
    headers: {
      'x-inlet-intent-token': intent.token,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
}

/** Multipart logo upload, which is the one management call that is not JSON. */
export async function uploadLogo(
  h: Harness,
  databaseId: string,
  file: Buffer,
  alt?: string,
  filename = 'logo.png',
  contentType = 'image/png',
) {
  const boundary = '----inletlogo';
  const parts: Buffer[] = [];
  if (alt !== undefined) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="alt"\r\n\r\n${alt}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );

  return h.app.inject({
    method: 'POST',
    url: `/v1/feedback-databases/${databaseId}/hosted-form/logo`,
    headers: {
      cookie: h.cookie,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat(parts),
  });
}
