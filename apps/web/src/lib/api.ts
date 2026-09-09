import type {
  ColorScheme,
  CornerRadius,
  EmbeddingMode,
  ErrorDetail,
  FormDefinition,
  Role,
  SlackContentLevel,
  StoredAnswer,
  Typeface,
} from '@inlet/shared';

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
  /** Hosted form requests omit credentials, so the page needs no cookie (FR-136). */
  credentials?: RequestCredentials;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, signal, credentials = 'same-origin' } = options;

  const response = await fetch(path, {
    method,
    credentials,
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
  firstAttachmentId: string | null;
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

/** The detail hands back every attachment, so it carries no list thumbnail ID. */
export type SubmissionDetail = Omit<SubmissionSummary, 'firstAttachmentId'> & {
  formDefinition: FormDefinition;
  attachments: SubmissionAttachment[];
};

export type SubmissionList = {
  submissions: SubmissionSummary[];
  nextCursor: string | null;
  total: number;
  /** Null `since` means this reader has no marker yet, so nothing counts as unread. */
  unread: { since: string | null; count: number };
};

export type SubmissionFilter = 'all' | 'unread' | 'screenshots';

export type DeletionImpact = { submissions: number; attachments: number; notice: string };

export type Member = {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  effectiveRole: Role;
  inherited: boolean;
  createdAt: string;
};

export type Invitation = {
  id: string;
  role: Role;
  scope: 'project' | 'feedback_database';
  projectId: string | null;
  feedbackDatabaseId: string | null;
  scopeName: string;
  status: 'pending' | 'redeemed' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedByEmail: string | null;
  revokedAt: string | null;
};

export type InvitationWithLink = Invitation & { token: string; url: string };

export type InvitationPreview = {
  role: Role;
  scope: 'project' | 'feedback_database';
  scopeName: string;
  projectName: string;
  expiresAt: string;
  requiresAccount: boolean;
};

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

export type HostedFormPublic = {
  slug: string;
  open: boolean;
  form: {
    feedbackDatabaseId: string;
    formVersion: number;
    pages: { id: string; elements: Record<string, unknown>[] }[];
  } | null;
  closedMessage: string;
  branding: {
    logoUrl: string | null;
    logoAlt: string | null;
    logoWidth: number | null;
    logoHeight: number | null;
    accentColor: string;
    colorScheme: ColorScheme;
    cornerRadius: CornerRadius;
    typeface: Typeface;
  };
  copy: { submitLabel: string; thankYouTitle: string; thankYouBody: string };
  behaviour: { redirectUrl: string | null; showProgress: boolean };
};

/** What an operator reads and edits on the Share tab. */
export type HostedForm = {
  feedbackDatabaseId: string;
  slug: string;
  url: string;
  enabled: boolean;
  accentColor: string;
  colorScheme: ColorScheme;
  cornerRadius: CornerRadius;
  typeface: Typeface;
  logoUrl: string | null;
  logoAlt: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
  submitLabel: string;
  thankYouTitle: string;
  thankYouBody: string;
  closedMessage: string;
  redirectUrl: string | null;
  showProgress: boolean;
  embedding: EmbeddingMode;
  allowedOrigins: string[];
  updatedAt: string;
};

export type HostedFormPatch = Partial<
  Pick<
    HostedForm,
    | 'enabled'
    | 'slug'
    | 'accentColor'
    | 'colorScheme'
    | 'cornerRadius'
    | 'typeface'
    | 'logoAlt'
    | 'submitLabel'
    | 'thankYouTitle'
    | 'thankYouBody'
    | 'closedMessage'
    | 'redirectUrl'
    | 'showProgress'
    | 'embedding'
    | 'allowedOrigins'
  >
>;

/** Slack notification settings. The webhook URL is write-only and never comes back. */
export type SlackNotifications = {
  feedbackDatabaseId: string;
  enabled: boolean;
  webhookConfigured: boolean;
  webhookUrlMasked: string | null;
  contentLevel: SlackContentLevel;
  messageTitle: string | null;
  channel: string | null;
  username: string | null;
  iconEmoji: string | null;
  lastDeliveryAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  failedCount: number;
  updatedAt: string;
};

export type SlackNotificationsPatch = {
  enabled?: boolean;
  /** Write-only. Null clears it and switches notifications off. */
  webhookUrl?: string | null;
  contentLevel?: SlackContentLevel;
  messageTitle?: string | null;
  channel?: string | null;
  username?: string | null;
  iconEmoji?: string | null;
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

  getHostedForm: (databaseId: string) =>
    request<HostedForm>(`/v1/feedback-databases/${databaseId}/hosted-form`),
  updateHostedForm: (databaseId: string, patch: HostedFormPatch) =>
    request<HostedForm>(`/v1/feedback-databases/${databaseId}/hosted-form`, {
      method: 'PATCH',
      body: patch,
    }),
  rotateHostedSlug: (databaseId: string) =>
    request<HostedForm>(`/v1/feedback-databases/${databaseId}/hosted-form/rotate-slug`, {
      method: 'POST',
    }),
  uploadHostedLogo: async (databaseId: string, file: File, alt: string) => {
    const form = new FormData();
    form.set('file', file, file.name);
    if (alt.trim() !== '') form.set('alt', alt.trim());
    const response = await fetch(`/v1/feedback-databases/${databaseId}/hosted-form/logo`, {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    const text = await response.text();
    const parsed = text.length > 0 ? safeJson(text) : null;
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } })?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'upload_failed',
        error?.message ?? 'That logo could not be uploaded.',
      );
    }
    return parsed as HostedForm;
  },
  removeHostedLogo: (databaseId: string) =>
    request<HostedForm>(`/v1/feedback-databases/${databaseId}/hosted-form/logo`, {
      method: 'DELETE',
    }),

  getSlackNotifications: (databaseId: string) =>
    request<SlackNotifications>(`/v1/feedback-databases/${databaseId}/slack-notifications`),
  updateSlackNotifications: (databaseId: string, patch: SlackNotificationsPatch) =>
    request<SlackNotifications>(`/v1/feedback-databases/${databaseId}/slack-notifications`, {
      method: 'PATCH',
      body: patch,
    }),
  sendSlackTestMessage: (databaseId: string) =>
    request<{ delivered: true }>(
      `/v1/feedback-databases/${databaseId}/slack-notifications/test`,
      { method: 'POST' },
    ),

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

  listSubmissions: (
    databaseId: string,
    options: {
      limit?: number;
      cursor?: string;
      filter?: SubmissionFilter;
      formVersion?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.filter && options.filter !== 'all') params.set('filter', options.filter);
    if (options.formVersion !== undefined) params.set('formVersion', String(options.formVersion));
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return request<SubmissionList>(`/v1/feedback-databases/${databaseId}/submissions${query}`);
  },
  markSubmissionsSeen: (databaseId: string) =>
    request<{ seenAt: string }>(`/v1/feedback-databases/${databaseId}/submissions/seen`, {
      method: 'POST',
    }),
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

  // --- Access: members and invitations --------------------------------------

  listProjectMembers: (projectId: string) =>
    request<Member[]>(`/v1/projects/${projectId}/members`),
  setProjectRole: (projectId: string, userId: string, role: Role) =>
    request<Member>(`/v1/projects/${projectId}/members/${userId}`, {
      method: 'PATCH',
      body: { role },
    }),
  removeProjectMember: (projectId: string, userId: string) =>
    request<{ ok: true }>(`/v1/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),

  listDatabaseMembers: (databaseId: string) =>
    request<Member[]>(`/v1/feedback-databases/${databaseId}/members`),
  setDatabaseRole: (databaseId: string, userId: string, role: Role) =>
    request<Member>(`/v1/feedback-databases/${databaseId}/members/${userId}`, {
      method: 'PUT',
      body: { role },
    }),
  clearDatabaseRole: (databaseId: string, userId: string) =>
    request<{ ok: true }>(`/v1/feedback-databases/${databaseId}/members/${userId}`, {
      method: 'DELETE',
    }),

  listProjectInvitations: (projectId: string) =>
    request<Invitation[]>(`/v1/projects/${projectId}/invitations`),
  inviteToProject: (projectId: string, role: Role) =>
    request<InvitationWithLink>(`/v1/projects/${projectId}/invitations`, {
      method: 'POST',
      body: { role },
    }),
  revokeProjectInvitation: (projectId: string, invitationId: string) =>
    request<Invitation>(`/v1/projects/${projectId}/invitations/${invitationId}/revoke`, {
      method: 'POST',
    }),

  listDatabaseInvitations: (databaseId: string) =>
    request<Invitation[]>(`/v1/feedback-databases/${databaseId}/invitations`),
  inviteToDatabase: (databaseId: string, role: Role) =>
    request<InvitationWithLink>(`/v1/feedback-databases/${databaseId}/invitations`, {
      method: 'POST',
      body: { role },
    }),
  revokeDatabaseInvitation: (databaseId: string, invitationId: string) =>
    request<Invitation>(
      `/v1/feedback-databases/${databaseId}/invitations/${invitationId}/revoke`,
      { method: 'POST' },
    ),

  previewInvitation: (token: string) =>
    request<InvitationPreview>(`/v1/invitations/${encodeURIComponent(token)}`),
  redeemInvitation: (
    token: string,
    account?: { email: string; password: string; displayName?: string },
  ) =>
    request<CurrentUser>(`/v1/invitations/${encodeURIComponent(token)}/redeem`, {
      method: 'POST',
      ...(account ? { body: account } : { body: {} }),
    }),

  /**
   * The same-origin path for an attachment.
   *
   * The API returns an absolute URL built from INLET_PUBLIC_URL, which is what an
   * export or a server-side consumer needs. A browser must use a relative path
   * instead: the session cookie belongs to the origin the page was served from, so an
   * absolute URL naming a different hostname is fetched without credentials and the
   * image fails to load.
   */
  /** A width asks the server to resize on the way out, for a list thumbnail. */
  attachmentPath: (attachmentId: string, width?: number) =>
    width === undefined
      ? `/v1/attachments/${attachmentId}`
      : `/v1/attachments/${attachmentId}?width=${width}`,
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

// --- The hosted form, the second collection path ----------------------------

/**
 * The public hosted form's client (FR-134, FR-136).
 *
 * Authorized by the slug in the path and nothing else: no key, no cookie, no stored
 * token. Credentials are omitted explicitly rather than left to the default, because
 * this page runs inside third-party frames and webviews where sending a cookie would
 * be both useless and a privacy surprise.
 */
export const hostedApi = {
  getForm: (slug: string, signal?: AbortSignal) =>
    request<HostedFormPublic>(`/v1/hosted/${encodeURIComponent(slug)}`, {
      credentials: 'omit',
      ...(signal ? { signal } : {}),
    }),

  createIntent: (slug: string) =>
    request<SubmissionIntent>(`/v1/hosted/${encodeURIComponent(slug)}/submission-intents`, {
      method: 'POST',
      credentials: 'omit',
    }),

  uploadAttachment: async (
    slug: string,
    intent: SubmissionIntent,
    questionId: string,
    file: File,
  ): Promise<UploadedAttachment> => {
    const form = new FormData();
    form.set('questionId', questionId);
    form.set('file', file, file.name);

    const response = await fetch(
      `/v1/hosted/${encodeURIComponent(slug)}/submission-intents/${intent.intentId}/attachments`,
      {
        method: 'POST',
        credentials: 'omit',
        headers: { 'x-inlet-intent-token': intent.token },
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

  discardAttachment: (slug: string, intent: SubmissionIntent, attachmentId: string) =>
    request<{ ok: true }>(
      `/v1/hosted/${encodeURIComponent(slug)}/submission-intents/${intent.intentId}/attachments/${attachmentId}`,
      {
        method: 'DELETE',
        credentials: 'omit',
        headers: { 'x-inlet-intent-token': intent.token },
      },
    ),

  submit: (
    slug: string,
    intent: SubmissionIntent,
    payload: {
      formVersion: number;
      answers: Record<string, unknown>;
      context?: Record<string, string>;
    },
  ) =>
    request<FinalizeResult>(
      `/v1/hosted/${encodeURIComponent(slug)}/submission-intents/${intent.intentId}/submit`,
      {
        method: 'POST',
        credentials: 'omit',
        headers: { 'x-inlet-intent-token': intent.token },
        body: payload,
      },
    ),
};
