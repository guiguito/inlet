import type { ErrorDetail, FormDefinition, Role, StoredAnswer } from '@inlet/shared';

/**
 * The typed API client.
 *
 * Management requests carry the session cookie, so nothing here handles tokens. The
 * one exception is the reference renderer, which authenticates with a project key and
 * an intent token and therefore passes them explicitly.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: ErrorDetail[];

  constructor(status: number, code: string, message: string, details: ErrorDetail[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** The message for a specific question, when the failure was about an answer. */
  detailFor(questionId: string): string | undefined {
    return this.details.find((detail) => detail.questionId === questionId)?.message;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, signal } = options;

  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? safeJson(text) : null;

  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string; details?: ErrorDetail[] } })
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'internal_error',
      error?.message ?? `The request failed with status ${response.status}.`,
      error?.details ?? [],
    );
  }

  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// --- Types mirroring the API responses --------------------------------------

export type CurrentUser = { id: string; email: string; displayName: string };

export type Project = {
  id: string;
  name: string;
  role: Role;
  feedbackDatabaseCount: number;
  createdAt: string;
  updatedAt: string;
};

export type FeedbackDatabase = {
  id: string;
  projectId: string;
  name: string;
  activeFormVersion: number | null;
  submissionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type Draft = {
  feedbackDatabaseId: string;
  definition: FormDefinition;
  revision: number;
  updatedAt: string;
  problems: { path?: string; code: string; message: string }[];
};

export type FormVersion = {
  id: string;
  feedbackDatabaseId: string;
  version: number;
  definition: FormDefinition;
  sourceRevision: number;
  publishedAt: string;
  active: boolean;
};

export type Credential = {
  id: string;
  type: 'publishable' | 'secret';
  label: string;
  key: string | null;
  prefix: string;
  lastFour: string;
  createdAt: string;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
};

export type CredentialWithSecret = Credential & { secret: string };

export type SubmissionSummary = {
  id: string;
  formVersion: number;
  createdAt: string;
  observedIp: string | null;
  answers: Record<string, StoredAnswer>;
  clientContext: unknown;
  attachmentCount: number;
};

export type SubmissionAttachment = {
  id: string;
  questionId: string;
  url: string;
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
  originalMediaType: string;
  originalFilename: string | null;
  createdAt: string;
};

export type SubmissionDetail = SubmissionSummary & {
  formDefinition: FormDefinition;
  attachments: SubmissionAttachment[];
};

export type SubmissionList = {
  submissions: SubmissionSummary[];
  nextCursor: string | null;
  total: number;
};

export type DeletionImpact = { submissions: number; attachments: number; notice: string };

export type ClientForm = {
  feedbackDatabaseId: string;
  formVersionId: string;
  formVersion: number;
  publishedAt: string;
  pages: { id: string; elements: Record<string, unknown>[] }[];
};

export type SubmissionIntent = {
  intentId: string;
  token: string;
  formVersion: number;
  expiresAt: string;
};

export type UploadedAttachment = {
  attachmentId: string;
  status: 'uploaded';
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
};

export type FinalizeResult = {
  submissionId: string;
  status: 'accepted' | 'duplicate';
  formVersion: number;
  createdAt: string;
};

// --- Management operations ---------------------------------------------------

export const api = {
  signIn: (email: string, password: string) =>
    request<CurrentUser>('/v1/auth/sign-in', { method: 'POST', body: { email, password } }),
  signOut: () => request<{ ok: true }>('/v1/auth/sign-out', { method: 'POST' }),
  me: (signal?: AbortSignal) => request<CurrentUser>('/v1/auth/me', signal ? { signal } : {}),

  listProjects: () => request<Project[]>('/v1/projects'),
  createProject: (name: string) =>
    request<Project>('/v1/projects', { method: 'POST', body: { name } }),
  getProject: (projectId: string) => request<Project>(`/v1/projects/${projectId}`),
  renameProject: (projectId: string, name: string) =>
    request<Project>(`/v1/projects/${projectId}`, { method: 'PATCH', body: { name } }),
  deleteProject: (projectId: string) =>
    request<{ deleted: true; purgedKeys: number }>(`/v1/projects/${projectId}`, {
      method: 'DELETE',
    }),

  listDatabases: (projectId: string) =>
    request<FeedbackDatabase[]>(`/v1/projects/${projectId}/feedback-databases`),
  createDatabase: (projectId: string, name: string) =>
    request<FeedbackDatabase>(`/v1/projects/${projectId}/feedback-databases`, {
      method: 'POST',
      body: { name },
    }),
  getDatabase: (databaseId: string) =>
    request<FeedbackDatabase>(`/v1/feedback-databases/${databaseId}`),
  renameDatabase: (databaseId: string, name: string) =>
    request<FeedbackDatabase>(`/v1/feedback-databases/${databaseId}`, {
      method: 'PATCH',
      body: { name },
    }),
  deleteDatabase: (databaseId: string) =>
    request<{ deleted: true; purgedKeys: number }>(`/v1/feedback-databases/${databaseId}`, {
      method: 'DELETE',
    }),
  deletionImpact: (databaseId: string) =>
    request<DeletionImpact>(`/v1/feedback-databases/${databaseId}/deletion-impact`),

  getDraft: (databaseId: string) =>
    request<Draft>(`/v1/feedback-databases/${databaseId}/form/draft`),
  saveDraft: (databaseId: string, definition: FormDefinition) =>
    request<Draft>(`/v1/feedback-databases/${databaseId}/form/draft`, {
      method: 'PUT',
      body: { definition },
    }),
  listVersions: (databaseId: string) =>
    request<FormVersion[]>(`/v1/feedback-databases/${databaseId}/form/versions`),
  publish: (databaseId: string, expectedRevision: number) =>
    request<FormVersion>(`/v1/feedback-databases/${databaseId}/form/publish`, {
      method: 'POST',
      body: { expectedRevision },
    }),
  unpublish: (databaseId: string) =>
    request<{ ok: true }>(`/v1/feedback-databases/${databaseId}/form/unpublish`, {
      method: 'POST',
    }),
  rollback: (databaseId: string, version?: number) =>
    request<FormVersion>(`/v1/feedback-databases/${databaseId}/form/rollback`, {
      method: 'POST',
      body: version === undefined ? {} : { version },
    }),

  listCredentials: (projectId: string) =>
    request<Credential[]>(`/v1/projects/${projectId}/credentials`),
  createCredential: (projectId: string, type: 'publishable' | 'secret', label: string) =>
    request<CredentialWithSecret>(`/v1/projects/${projectId}/credentials`, {
      method: 'POST',
      body: { type, label },
    }),
  relabelCredential: (projectId: string, credentialId: string, label: string) =>
    request<Credential>(`/v1/projects/${projectId}/credentials/${credentialId}`, {
      method: 'PATCH',
      body: { label },
    }),
  rotateCredential: (projectId: string, credentialId: string) =>
    request<CredentialWithSecret>(
      `/v1/projects/${projectId}/credentials/${credentialId}/rotate`,
      { method: 'POST' },
    ),
  revokeCredential: (projectId: string, credentialId: string) =>
    request<Credential>(`/v1/projects/${projectId}/credentials/${credentialId}/revoke`, {
      method: 'POST',
    }),

  listSubmissions: (databaseId: string, options: { limit?: number; cursor?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.cursor) params.set('cursor', options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return request<SubmissionList>(`/v1/feedback-databases/${databaseId}/submissions${query}`);
  },
  getSubmission: (databaseId: string, submissionId: string) =>
    request<SubmissionDetail>(
      `/v1/feedback-databases/${databaseId}/submissions/${submissionId}`,
    ),
  deleteSubmission: (databaseId: string, submissionId: string) =>
    request<{ deleted: true; purgedKeys: number }>(
      `/v1/feedback-databases/${databaseId}/submissions/${submissionId}`,
      { method: 'DELETE' },
    ),
  exportUrl: (databaseId: string, format: 'json' | 'csv') =>
    `/v1/feedback-databases/${databaseId}/submissions/export?format=${format}`,

  /**
   * The same-origin path for an attachment.
   *
   * The API returns an absolute URL built from INLET_PUBLIC_URL, which is what an
   * export or a server-side consumer needs. A browser must use a relative path
   * instead: the session cookie belongs to the origin the page was served from, so an
   * absolute URL naming a different hostname is fetched without credentials and the
   * image fails to load.
   */
  attachmentPath: (attachmentId: string) => `/v1/attachments/${attachmentId}`,
};

// --- The client feedback flow, used by the reference renderer ---------------

export const clientApi = {
  getForm: (databaseId: string, key: string) =>
    request<ClientForm>(`/v1/feedback-databases/${databaseId}/form`, {
      headers: { authorization: `Bearer ${key}` },
    }),

  createIntent: (databaseId: string, key: string, formVersion?: number) =>
    request<SubmissionIntent>(`/v1/feedback-databases/${databaseId}/submission-intents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: formVersion === undefined ? {} : { formVersion },
    }),

  /** Multipart, so it bypasses the JSON helper. */
  uploadAttachment: async (
    databaseId: string,
    key: string,
    intent: SubmissionIntent,
    questionId: string,
    file: File,
  ): Promise<UploadedAttachment> => {
    const form = new FormData();
    form.set('questionId', questionId);
    form.set('file', file, file.name);

    const response = await fetch(
      `/v1/feedback-databases/${databaseId}/submission-intents/${intent.intentId}/attachments`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'x-inlet-intent-token': intent.token },
        body: form,
      },
    );

    const text = await response.text();
    const parsed = text.length > 0 ? safeJson(text) : null;
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } })?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'upload_failed',
        error?.message ?? 'That screenshot could not be uploaded.',
      );
    }
    return parsed as UploadedAttachment;
  },

  discardAttachment: (
    databaseId: string,
    key: string,
    intent: SubmissionIntent,
    attachmentId: string,
  ) =>
    request<{ ok: true }>(
      `/v1/feedback-databases/${databaseId}/submission-intents/${intent.intentId}/attachments/${attachmentId}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${key}`, 'x-inlet-intent-token': intent.token },
      },
    ),

  finalize: (
    databaseId: string,
    key: string,
    intent: SubmissionIntent,
    payload: { formVersion: number; answers: Record<string, unknown>; clientContext?: unknown },
  ) =>
    request<FinalizeResult>(
      `/v1/feedback-databases/${databaseId}/submission-intents/${intent.intentId}/submit`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'x-inlet-intent-token': intent.token },
        body: payload,
      },
    ),
};
