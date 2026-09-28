import type {
  AnalyticsFilter,
  AnalyticsInterval,
  AnalyticsMetric,
  AnalyticsRange,
  AnalyticsSplit,
  ColorScheme,
  ConfigCondition,
  ConfigContextBody,
  ConfigExplanation,
  ConfigMatchCondition,
  ConfigSplitCondition,
  ConfigParameter,
  ConfigProblem,
  ConfigPublishWarning,
  ConfigTemplate,
  ConfigTemplateDiff,
  ConfigChangeSummary,
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

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
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
  /** FR-062: the SDK identity, when the client supplied it. */
  installationId: string | null;
  sessionId: string | null;
  userId: string | null;
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
  scope: 'project' | 'feedback_database' | 'crash_database' | 'analytics_database' | 'config_database';
  projectId: string | null;
  feedbackDatabaseId: string | null;
  crashDatabaseId: string | null;
  analyticsDatabaseId: string | null;
  configDatabaseId: string | null;
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
  scope: 'project' | 'feedback_database' | 'crash_database' | 'analytics_database' | 'config_database';
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

/**
 * FD-002: members, invitations and Slack settings are shared by both database types and
 * live under each type's own routes. The ID prefix says which.
 */
function databaseBase(databaseId: string): string {
  if (databaseId.startsWith('cdb_')) return `/v1/crash-databases/${databaseId}`;
  if (databaseId.startsWith('adb_')) return `/v1/analytics-databases/${databaseId}`;
  if (databaseId.startsWith('cfg_')) return `/v1/config-databases/${databaseId}`;
  return `/v1/feedback-databases/${databaseId}`;
}

// --- Remote Config (Release 9) ---------------------------------------------------

export type ConfigDatabase = {
  id: string;
  projectId: string;
  name: string;
  type: 'config';
  refreshIntervalMinutes: number;
  refreshIntervalBounds: { min: number; max: number };
  deriveCountry: boolean;
  activeVersion: number | null;
  createdAt: string;
  updatedAt: string;
};

/** RC-003, FD-008: versions and parameters, and the history export to offer first. */
export type ConfigDeletionImpact = {
  versions: number;
  draftParameters: number;
  activeParameters: number | null;
  exportPath: string;
  notice: string;
};

type ConfigActor = { kind: 'user' | 'key'; id: string; name: string | null } | null;

/** The draft read without its template (RC-050, RC-053, RC-019, RC-028, RC-029): what the header and the problems show. */
export type ConfigDraftState = {
  configDatabaseId: string;
  revision: number;
  updatedAt: string;
  updatedBy: ConfigActor;
  activeVersion: number | null;
  problems: ConfigProblem[];
  warnings: ConfigPublishWarning[];
  differsFromActive: boolean;
  changes: number;
  conditionUsage: Array<{ condition: string; parameters: string[] }>;
};
export type ConfigDraft = ConfigDraftState & { template: ConfigTemplate };
/** A condition as the editor sends it: the server draws or keeps the salt (RC-020). */
export type ConfigConditionBody = Omit<ConfigMatchCondition, 'salt'> | Omit<ConfigSplitCondition, 'salt'>;
/** RC-051: a per-part change answers the state and the part as stored. */
export type ConfigDraftChange = ConfigDraftState & { parameter?: ConfigParameter; condition?: ConfigCondition; affectedParameters?: string[] };

export type ConfigVersion = {
  number: number;
  publishedAt: string;
  publishedBy: ConfigActor;
  note: string | null;
  draftRevision: number;
  rolledBackFrom: number | null;
  active: boolean;
  /** RC-052: what changed against the version active before it. */
  changeSummary: ConfigChangeSummary;
};
/** RC-058: a publish, rollback or unpublish; `version` is what it made active, null for an unpublish. */
export type ConfigActivity = { id: number; kind: 'publish' | 'rollback' | 'unpublish'; actor: ConfigActor; at: string; note: string | null; version: number | null };
export type ConfigLifecycle = { version: ConfigVersion; created: boolean; warnings: ConfigPublishWarning[] };
/** RC-057: the difference between two of the draft, the active version and a version. */
export type ConfigDiff = ConfigTemplateDiff & { fromVersion: number | null; toVersion: number | null; warnings: ConfigPublishWarning[] };
export type ConfigSource = 'draft' | 'active' | number;
/** RC-061, RC-063: what the export route downloads; `defaults` is the defaults as JSON. */
export const configExportPath = (databaseId: string, source: ConfigSource, format: 'json' | 'ts' | 'defaults' = 'json') =>
  `/v1/config-databases/${databaseId}/export?source=${source}&format=${format}`;

/** RC-060: piece 1's explanation of one context, answered by `POST …/preview` (piece 5). */
export type ConfigPreview = ConfigExplanation & {
  source: ConfigSource;
  version: number | null;
  live: string[];
  warnings: Array<{ path: string; code: string }>;
};

/**
 * RC-070: a count from 1 to 9 is never returned exactly, and carries no share; nor is one of 10 or more
 * that would reveal such a count by subtraction (`withheld`, DECISIONS 34.5).
 */
export type ConfigReachCount = { count: number } | { count: null; fewerThan: 10 } | { count: null; withheld: true };
/**
 * RC-070 to RC-072: the reach route (piece 5). The Conditions view reads `summary.lastDay`;
 * the series and the other summaries are History's and Integrate's (piece 8). Shares are
 * fractions (0.1 is 10%).
 */
export type ConfigReach = {
  unit: 'fetches';
  notice: string;
  summary: {
    /** RC-072: History's share per version and Integrate's figures. Version counts are exact. */
    last24Hours: {
      from: string;
      fetches: number;
      notModified: number;
      versions: Array<{ version: number; fetches: number; share: number | null }>;
      activeVersion: number | null;
      activeVersionShare: number | null;
    };
    lastDay: {
      from: string;
      fetches: number;
      conditions: Array<{ id: string; name: string; fetches: ConfigReachCount; share: number | null; matchedNone: boolean }>;
    };
  };
};
export type ConfigConditionReach = ConfigReach['summary']['lastDay']['conditions'][number];

// --- UX Analytics (Release 8) ----------------------------------------------------

export type AnalyticsDatabase = {
  id: string;
  projectId: string;
  name: string;
  type: 'analytics';
  timezone: string;
  countryDerivation: boolean;
  storage: { maxAgeDays: number; maxEvents: number; latenessDays: number };
  limits: { eventNames: number; newEventNamesPerHour: number; paramKeysPerEventName: number; categoriesPerEventName: number };
  createdAt: string;
  updatedAt: string;
};

/** The single read also says whether the event store answers now (UX Analytics 8.1). */
export type AnalyticsDatabaseRead = AnalyticsDatabase & { eventStore: 'available' | 'unavailable' };

export type AnalyticsDeletionImpact = {
  events: number | null;
  installations: number | null;
  users: number | null;
  eventStore: 'available' | 'unavailable';
  funnels: number;
  cohorts: number;
  notice: string;
};

/** AN-018, Appendix E: what a batch, or the test event, was answered. */
export type AnalyticsBatchAnswer = {
  accepted: number;
  duplicates: number;
  rejected: { index: number; code: string; field?: string }[];
  warnings: { index: number; code: string; field?: string }[];
};

/** AN-058: one event of the live feed. */
export type AnalyticsLiveEvent = { name: string; time: string; installationId: string; platform: string; appVersion: string };

/** AN-050, Appendix E "Catalog entry". */
export type AnalyticsCatalogEntry = {
  name: string;
  category: string | null;
  description: string | null;
  hidden: boolean;
  blocked: boolean;
  standard: boolean;
  firstSeen: string;
  lastSeen: string | null;
  last24h: { events: number; installations: number; users: number };
  computedAt: string | null;
};

export type AnalyticsEventParam = { key: string; types: string[]; description: string | null; firstSeen: string };

/** AN-052: an event with its params and their top values over the last seven days. */
export type AnalyticsEventDetail = AnalyticsCatalogEntry & {
  categories: string[];
  params: (AnalyticsEventParam & { topValues: { value: string; events: number }[] })[];
  topValuesFrom: string;
  topValuesTo: string;
};

/** Section 9.2: a trend definition as the interface sends it. */
export type AnalyticsTrendDefinition = {
  range: AnalyticsRange;
  interval: AnalyticsInterval;
  series: { event: string; metric: AnalyticsMetric; label?: string; filters: AnalyticsFilter[] }[];
  filters: AnalyticsFilter[];
  split?: AnalyticsSplit;
};

/** AN-060 to AN-067, Appendix E "Trend". */
export type AnalyticsTrendPoint = { start: string; label: string; value: number; incomplete: boolean };
export type AnalyticsTrendAnswer = {
  range: { from: string; to: string };
  interval: AnalyticsInterval;
  timezone: string;
  keptFrom: string | null;
  series: {
    label: string;
    event: string;
    metric: AnalyticsMetric;
    value?: string | null;
    group?: 'value' | 'other' | 'none';
    covered: { from: string; to: string } | null;
    notice: 'range_outside_retention' | null;
    points: AnalyticsTrendPoint[];
  }[];
};

/** AN-140 to AN-144, Appendix E "Overview". */
export type AnalyticsOverviewQuery = {
  range: AnalyticsRange;
  apps: string[];
  platforms: string[];
  unit: 'installation' | 'user';
};
export type AnalyticsFigure = { value: number | null; previous: number | null; covered: { from: string; to: string } | null };
export type AnalyticsCrashFree = { rate: number | null; sessions: number; measured: boolean; lowConfidence: boolean };
export type AnalyticsShare = { value: string; share: number; installations: number; other?: true };
export type AnalyticsOverview = {
  range: { from: string; to: string };
  unit: 'installation' | 'user';
  timezone: string;
  keptFrom: string | null;
  filters: { apps: string[]; platforms: string[] };
  figures: {
    activeLastHour: AnalyticsFigure;
    dailyActiveLastDay: AnalyticsFigure;
    dailyActiveToday: AnalyticsFigure;
    weeklyActive: AnalyticsFigure;
    monthlyActive: AnalyticsFigure;
    stickiness: AnalyticsFigure;
    newInstallations: AnalyticsFigure & { perDay: { day: string; value: number }[] };
    sessions: AnalyticsFigure & { perDay: { day: string; value: number }[] };
    d1: AnalyticsFigure & { installations: number };
    d7: AnalyticsFigure & { installations: number };
    d30: AnalyticsFigure & { installations: number };
  };
  crashFree: { covered: { from: string; to: string } | null; overall: AnalyticsCrashFree & { previous: number | null }; versions: (AnalyticsCrashFree & { version: string })[] };
  shares: { covered: { from: string; to: string } | null; appVersion: AnalyticsShare[]; platform: AnalyticsShare[]; country: AnalyticsShare[] };
  topEvents: { computedAt: string | null; events: { name: string; events: number }[] };
  dailyActive: { covered: { from: string; to: string } | null; points: AnalyticsTrendPoint[] };
  versionsFirstSeen: { version: string; day: string }[];
  notices: { code: 'no_events' | 'no_app_started'; message: string }[];
};

// --- Crash Reports (Release 6) -------------------------------------------------

export type CrashDatabase = {
  id: string;
  projectId: string;
  name: string;
  type: 'crash';
  groupingVersion: number;
  retention: { maxReports: number; maxAgeDays: number | null };
  groupCount: number;
  reportCount: number;
  dropped24h: { rateLimited: number; evicted: number };
  createdAt: string;
  updatedAt: string;
};

export type CrashGroupState = 'open' | 'resolved' | 'ignored';

export type CrashGroup = {
  id: string;
  kind: string;
  exceptionType: string | null;
  topFrame: string | null;
  module: string | null;
  sampleMessage: string | null;
  state: CrashGroupState;
  regressed: boolean;
  resolvedInRelease: string | null;
  stateChangedAt: string | null;
  count: number;
  affectedUsers: number;
  firstSeenAt: string;
  lastSeenAt: string;
  firstRelease: string | null;
  lastRelease: string | null;
  latestReportId: string | null;
  sparkline: number[];
};

export type CrashTimeline = {
  days: { day: string; reports: number; newGroups: number }[];
  releases: { version: string; day: string }[];
  /** Present when `by` was release, os or kind (CR-046). */
  breakdown?: { by: 'release' | 'os' | 'kind'; rows: { key: string; reports: number; groups: number }[] };
};

export type CrashGroupDetail = Omit<CrashGroup, 'sparkline'> & {
  byRelease: { version: string; count: number }[];
  byOs: { os: string; count: number }[];
  timeline: CrashTimeline;
};

export type CrashReport = {
  id: string;
  groupId: string;
  eventId: string;
  receivedAt: string;
  effectiveAt: string;
  clockSkew: boolean;
  kind: string;
  release: string;
  os: { name: string | null; version: string | null; arch: string | null };
  userId: string | null;
  /** CR-118: the shared SDK identity. */
  installationId: string | null;
  sessionId: string | null;
  envelope: CrashEnvelopeView;
};

/** The envelope as the interface reads it. Every field is optional on the way out. */
export type CrashEnvelopeView = {
  eventId?: string;
  timestamp?: string;
  sdk?: { name: string; version: string };
  platform?: string;
  kind?: string;
  release?: { version: string; build?: string; channel?: string };
  exception?: {
    type: string;
    message: string;
    handled: boolean;
    frames: { function?: string; file?: string; line?: number; col?: number; inApp: boolean }[];
  };
  native?: { process: string; fault: string; module: string; dumpBytes?: number };
  exit?: { code?: number; signal?: string; reason?: string; name?: string; lastUptimeMs?: number };
  os?: { name: string; version?: string; arch?: string };
  runtime?: { name: string; version?: string };
  user?: { id: string };
  installationId?: string;
  sessionId?: string;
  tags?: Record<string, string>;
  context?: Record<string, unknown>;
  fingerprint?: string[];
};

export type CrashRelease = {
  version: string;
  build: string;
  channel: string;
  order: number;
  firstSeenAt: string;
  reports: number;
  groups: number;
  newGroups: number;
};

export type CrashRetention = {
  maxReports: number;
  maxAgeDays: number | null;
  bounds: {
    maxReports: { min: number; max: number; default: number };
    maxAgeDays: { min: number; max: number; default: number };
  };
};

export type CrashGroupFilters = {
  state?: CrashGroupState;
  kind?: string;
  release?: string;
  os?: string;
  userId?: string;
  installationId?: string;
  sessionId?: string;
  q?: string;
};

export type CrashGroupSort = 'lastSeen' | 'firstSeen' | 'count' | 'affectedUsers';

export type CrashStateChange =
  | { state: 'resolved'; resolvedInRelease?: string }
  | { state: 'ignored' }
  | { state: 'open' };

function crashQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  // --- Config databases (RC-001 to RC-004) ---
  listConfigDatabases: (projectId: string) => request<ConfigDatabase[]>(`/v1/projects/${projectId}/config-databases`),
  createConfigDatabase: (projectId: string, name: string) =>
    request<ConfigDatabase>(`/v1/projects/${projectId}/config-databases`, { method: 'POST', body: { name } }),
  getConfigDatabase: (databaseId: string) => request<ConfigDatabase>(`/v1/config-databases/${databaseId}`),
  updateConfigDatabase: (databaseId: string, patch: { name?: string; refreshIntervalMinutes?: number; deriveCountry?: boolean }) =>
    request<ConfigDatabase>(`/v1/config-databases/${databaseId}`, { method: 'PATCH', body: patch }),
  deleteConfigDatabase: (databaseId: string) => request<{ deleted: true }>(`/v1/config-databases/${databaseId}`, { method: 'DELETE' }),
  configDeletionImpact: (databaseId: string) => request<ConfigDeletionImpact>(`/v1/config-databases/${databaseId}/deletion-impact`),

  // --- Config draft, publishing, preview and reach (RC-050 to RC-060, RC-072) ---
  getConfigDraft: (databaseId: string) => request<ConfigDraft>(`/v1/config-databases/${databaseId}/draft`),
  setConfigParameter: (databaseId: string, parameter: ConfigParameter) =>
    request<ConfigDraftChange>(`/v1/config-databases/${databaseId}/draft/parameters/${encodeURIComponent(parameter.key)}`, { method: 'PUT', body: parameter }),
  deleteConfigParameter: (databaseId: string, key: string) =>
    request<ConfigDraftChange>(`/v1/config-databases/${databaseId}/draft/parameters/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  setConfigCondition: (databaseId: string, condition: ConfigConditionBody) =>
    request<ConfigDraftChange>(`/v1/config-databases/${databaseId}/draft/conditions/${condition.id}`, { method: 'PUT', body: condition }),
  deleteConfigCondition: (databaseId: string, conditionId: string) =>
    request<ConfigDraftChange>(`/v1/config-databases/${databaseId}/draft/conditions/${conditionId}`, { method: 'DELETE' }),
  reorderConfigConditions: (databaseId: string, order: string[]) =>
    request<ConfigDraftChange>(`/v1/config-databases/${databaseId}/draft/conditions/order`, { method: 'PUT', body: { order } }),
  reshuffleConfigCondition: (databaseId: string, conditionId: string) =>
    request<ConfigDraftChange>(`/v1/config-databases/${databaseId}/draft/conditions/${conditionId}/reshuffle`, { method: 'POST' }),
  diffConfig: (databaseId: string, from: ConfigSource = 'active', to: ConfigSource = 'draft') =>
    request<ConfigDiff>(`/v1/config-databases/${databaseId}/diff?from=${from}&to=${to}`),
  listConfigVersions: (databaseId: string, limit = 50, cursor?: string) =>
    request<{ versions: ConfigVersion[]; nextCursor: string | null }>(`/v1/config-databases/${databaseId}/versions?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`),
  getConfigVersion: (databaseId: string, number: number) =>
    request<ConfigVersion & { template: ConfigTemplate }>(`/v1/config-databases/${databaseId}/versions/${number}`),
  publishConfig: (databaseId: string, revision: number, note?: string) =>
    request<ConfigLifecycle>(`/v1/config-databases/${databaseId}/publish`, { method: 'POST', body: { revision, ...(note ? { note } : {}) } }),
  previewConfig: (databaseId: string, context: ConfigContextBody, source: ConfigSource) =>
    request<ConfigPreview>(`/v1/config-databases/${databaseId}/preview`, { method: 'POST', body: { context, source } }),
  getConfigReach: (databaseId: string) => request<ConfigReach>(`/v1/config-databases/${databaseId}/reach`),

  // --- Config history (RC-054 to RC-058, RC-063, RC-064) ---
  listConfigActivity: (databaseId: string, cursor?: string) =>
    request<{ activity: ConfigActivity[]; nextCursor: string | null }>(`/v1/config-databases/${databaseId}/activity?limit=50${cursor ? `&cursor=${cursor}` : ''}`),
  rollbackConfig: (databaseId: string, version: number, note?: string) =>
    request<ConfigLifecycle>(`/v1/config-databases/${databaseId}/rollback`, { method: 'POST', body: { version, ...(note ? { note } : {}) } }),
  unpublishConfig: (databaseId: string, confirm: string) =>
    request<{ activeVersion: null; unpublishedVersion: number }>(`/v1/config-databases/${databaseId}/unpublish`, { method: 'POST', body: { confirm } }),
  copyConfigVersionToDraft: (databaseId: string, version: number) =>
    request<ConfigDraft>(`/v1/config-databases/${databaseId}/draft/copy`, { method: 'POST', body: { version } }),
  /** The export route as text: the template (`json`) or the defaults as TypeScript (`ts`). */
  exportConfig: (databaseId: string, source: ConfigSource, format: 'json' | 'ts') =>
    request<string | object>(configExportPath(databaseId, source, format)).then((body) => (typeof body === 'string' ? body : JSON.stringify(body, null, 2))),

  // --- Analytics databases (AN-001 to AN-005) ---
  listAnalyticsDatabases: (projectId: string) =>
    request<AnalyticsDatabase[]>(`/v1/projects/${projectId}/analytics-databases`),
  createAnalyticsDatabase: (projectId: string, name: string, timezone: string) =>
    request<AnalyticsDatabase>(`/v1/projects/${projectId}/analytics-databases`, { method: 'POST', body: { name, timezone } }),
  getAnalyticsDatabase: (databaseId: string) => request<AnalyticsDatabaseRead>(`/v1/analytics-databases/${databaseId}`),
  updateAnalyticsDatabase: (databaseId: string, patch: { name?: string; countryDerivation?: boolean }) =>
    request<AnalyticsDatabase>(`/v1/analytics-databases/${databaseId}`, { method: 'PATCH', body: patch }),
  deleteAnalyticsDatabase: (databaseId: string) =>
    request<{ deleted: true }>(`/v1/analytics-databases/${databaseId}`, { method: 'DELETE' }),
  analyticsDeletionImpact: (databaseId: string) =>
    request<AnalyticsDeletionImpact>(`/v1/analytics-databases/${databaseId}/deletion-impact`),
  // --- Collect (AN-025, AN-058) ---
  sendAnalyticsTestEvent: (databaseId: string) =>
    request<AnalyticsBatchAnswer & { eventId: string }>(`/v1/analytics-databases/${databaseId}/test-event`, { method: 'POST' }),
  analyticsLiveFeed: (databaseId: string, after?: string) =>
    request<{ events: AnalyticsLiveEvent[]; cursor: string }>(
      `/v1/analytics-databases/${databaseId}/live${after ? `?after=${encodeURIComponent(after)}` : ''}`,
    ),
  // --- Catalog, Lexicon and trends (AN-050 to AN-069) ---
  /**
   * The whole catalog, every page: the API answers 1,000 names a page (AN-204) and an operator
   * may allow 5,000 names, so this follows `nextCursor` until the last page.
   */
  listAnalyticsEvents: async (databaseId: string, query: { q?: string; category?: string; includeHidden?: boolean; sort?: 'name' | 'lastSeen' | 'events24h' } = {}) => {
    const events: AnalyticsCatalogEntry[] = [];
    let cursor: string | undefined;
    let total = 0;
    do {
      const page = await request<{ events: AnalyticsCatalogEntry[]; nextCursor: string | null; total: number }>(
        `/v1/analytics-databases/${databaseId}/events${crashQuery({ q: query.q, category: query.category, includeHidden: query.includeHidden ? 'true' : undefined, sort: query.sort, cursor })}`,
      );
      events.push(...page.events);
      total = page.total;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { events, total };
  },
  getAnalyticsEvent: (databaseId: string, name: string) =>
    request<AnalyticsEventDetail>(`/v1/analytics-databases/${databaseId}/events/${encodeURIComponent(name)}`),
  updateAnalyticsEvent: (databaseId: string, name: string, patch: { description?: string | null; hidden?: boolean }) =>
    request<AnalyticsCatalogEntry>(`/v1/analytics-databases/${databaseId}/events/${encodeURIComponent(name)}`, { method: 'PATCH', body: patch }),
  updateAnalyticsEventParam: (databaseId: string, name: string, key: string, description: string | null) =>
    request<AnalyticsEventParam>(`/v1/analytics-databases/${databaseId}/events/${encodeURIComponent(name)}/params/${encodeURIComponent(key)}`, { method: 'PATCH', body: { description } }),
  blockAnalyticsEvent: (databaseId: string, name: string, blocked: boolean) =>
    request<AnalyticsCatalogEntry>(`/v1/analytics-databases/${databaseId}/events/${encodeURIComponent(name)}/blocked`, { method: 'PUT', body: { blocked } }),
  deleteAnalyticsEvent: (databaseId: string, name: string, confirm: string) =>
    request<{ deleted: true }>(`/v1/analytics-databases/${databaseId}/events/${encodeURIComponent(name)}?confirm=${encodeURIComponent(confirm)}`, { method: 'DELETE' }),
  analyticsFilterValues: (databaseId: string, query: { dimension?: string; key?: string; param?: string; event?: string }) =>
    request<{ values: string[]; truncated: boolean }>(`/v1/analytics-databases/${databaseId}/filters${crashQuery(query)}`),
  analyticsTrend: (databaseId: string, definition: AnalyticsTrendDefinition, signal?: AbortSignal) =>
    request<AnalyticsTrendAnswer>(`/v1/analytics-databases/${databaseId}/queries/trends`, { method: 'POST', body: definition, ...(signal ? { signal } : {}) }),
  /** AN-140 to AN-144: the Overview; a filter with several values repeats its parameter. */
  analyticsOverview: (databaseId: string, query: AnalyticsOverviewQuery, signal?: AbortSignal) => {
    const search = new URLSearchParams();
    if ('preset' in query.range) search.set('preset', query.range.preset);
    else {
      search.set('from', query.range.from);
      search.set('to', query.range.to);
    }
    for (const app of query.apps) search.append('app', app);
    for (const platform of query.platforms) search.append('platform', platform);
    search.set('unit', query.unit);
    return request<AnalyticsOverview>(`/v1/analytics-databases/${databaseId}/overview?${search.toString()}`, signal ? { signal } : {});
  },
  /** AN-069: the export is a POST (the definition does not fit an address), so it is fetched and saved as a file. */
  downloadAnalyticsTrend: async (databaseId: string, definition: AnalyticsTrendDefinition, format: 'csv' | 'json') => {
    const response = await fetch(`/v1/analytics-databases/${databaseId}/queries/trends?format=${format}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(definition),
    });
    if (!response.ok) {
      const body = safeJson(await response.text()) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(response.status, body?.error?.code ?? 'internal_error', body?.error?.message ?? 'The export failed.');
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `trend.${format}`;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
  analyticsCatalogExportUrl: (databaseId: string, format: 'csv' | 'json') => `/v1/analytics-databases/${databaseId}/exports/catalog?format=${format}`,

  // --- Crash databases ---
  listCrashDatabases: (projectId: string) =>
    request<CrashDatabase[]>(`/v1/projects/${projectId}/crash-databases`),
  createCrashDatabase: (projectId: string, name: string) =>
    request<CrashDatabase>(`/v1/projects/${projectId}/crash-databases`, { method: 'POST', body: { name } }),
  getCrashDatabase: (databaseId: string) => request<CrashDatabase>(`/v1/crash-databases/${databaseId}`),
  renameCrashDatabase: (databaseId: string, name: string) =>
    request<CrashDatabase>(`/v1/crash-databases/${databaseId}`, { method: 'PATCH', body: { name } }),
  deleteCrashDatabase: (databaseId: string) =>
    request<{ deleted: true }>(`/v1/crash-databases/${databaseId}`, { method: 'DELETE' }),
  crashDeletionImpact: (databaseId: string) =>
    request<{ groups: number; reports: number; notice: string }>(`/v1/crash-databases/${databaseId}/deletion-impact`),
  getCrashRetention: (databaseId: string) => request<CrashRetention>(`/v1/crash-databases/${databaseId}/retention`),
  updateCrashRetention: (databaseId: string, patch: { maxReports?: number; maxAgeDays?: number | null }) =>
    request<CrashRetention>(`/v1/crash-databases/${databaseId}/retention`, { method: 'PATCH', body: patch }),
  listCrashGroups: (
    databaseId: string,
    options: CrashGroupFilters & { sort?: CrashGroupSort; limit?: number; offset?: number; days?: number },
  ) => request<{ groups: CrashGroup[]; total: number }>(`/v1/crash-databases/${databaseId}/groups${crashQuery(options)}`),
  getCrashGroup: (databaseId: string, groupId: string, days: number) =>
    request<CrashGroupDetail>(`/v1/crash-databases/${databaseId}/groups/${groupId}${crashQuery({ days })}`),
  setCrashGroupState: (databaseId: string, groupId: string, change: CrashStateChange) =>
    request<Omit<CrashGroup, 'sparkline'>>(`/v1/crash-databases/${databaseId}/groups/${groupId}/state`, { method: 'POST', body: change }),
  setCrashGroupsState: (databaseId: string, groupIds: string[], change: CrashStateChange) =>
    request<{ updated: number }>(`/v1/crash-databases/${databaseId}/groups/state`, { method: 'POST', body: { groupIds, change } }),
  deleteCrashGroup: (databaseId: string, groupId: string) =>
    request<{ deleted: true }>(`/v1/crash-databases/${databaseId}/groups/${groupId}`, { method: 'DELETE' }),
  listCrashGroupReports: (databaseId: string, groupId: string, limit = 20) =>
    request<{ reports: CrashReport[] }>(`/v1/crash-databases/${databaseId}/groups/${groupId}/reports${crashQuery({ limit })}`),
  getCrashReport: (databaseId: string, reportId: string) =>
    request<CrashReport>(`/v1/crash-databases/${databaseId}/reports/${reportId}`),
  listCrashReleases: (databaseId: string) =>
    request<{ releases: CrashRelease[] }>(`/v1/crash-databases/${databaseId}/releases`),
  /** Section 8.1: the values the Groups tab's selects offer, without the stats breakdown's cost. */
  getCrashFilters: (databaseId: string) =>
    request<{ kinds: string[]; operatingSystems: string[] }>(
      `/v1/crash-databases/${databaseId}/filters`,
    ),
  getCrashStats: (databaseId: string, options: CrashGroupFilters & { days: number; by?: 'day' | 'release' | 'os' | 'kind' }) =>
    request<CrashTimeline>(`/v1/crash-databases/${databaseId}/stats${crashQuery(options)}`),
  crashGroupsExportUrl: (databaseId: string, format: 'json' | 'csv', filters: CrashGroupFilters) =>
    `/v1/crash-databases/${databaseId}/groups/export${crashQuery({ ...filters, format })}`,
  crashReportsExportUrl: (databaseId: string, filters: CrashGroupFilters) =>
    `/v1/crash-databases/${databaseId}/reports/export${crashQuery(filters)}`,
  /**
   * The Collect tab's "send a test report": one envelope of kind `message`, posted the way
   * an application would, with the project's publishable key rather than the session.
   */
  sendCrashTestReport: (databaseId: string, publishableKey: string) =>
    request<{ reportId: string; groupId: string; isNewGroup: boolean; isRegression: boolean }>(
      `/v1/crash-databases/${databaseId}/reports`,
      {
        method: 'POST',
        credentials: 'omit',
        headers: { authorization: `Bearer ${publishableKey}` },
        body: {
          eventId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          sdk: { name: 'inlet-web', version: '0.1.0' },
          platform: 'browser',
          kind: 'message',
          release: { version: 'test' },
          exception: { type: 'TestReport', message: 'Test report from the Collect tab', handled: true, frames: [] },
        },
      },
    ),

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
    request<SlackNotifications>(`${databaseBase(databaseId)}/slack-notifications`),
  updateSlackNotifications: (databaseId: string, patch: SlackNotificationsPatch) =>
    request<SlackNotifications>(`${databaseBase(databaseId)}/slack-notifications`, {
      method: 'PATCH',
      body: patch,
    }),
  sendSlackTestMessage: (databaseId: string) =>
    request<{ delivered: true }>(
      `${databaseBase(databaseId)}/slack-notifications/test`,
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
    request<Member[]>(`${databaseBase(databaseId)}/members`),
  setDatabaseRole: (databaseId: string, userId: string, role: Role) =>
    request<Member>(`${databaseBase(databaseId)}/members/${userId}`, {
      method: 'PUT',
      body: { role },
    }),
  clearDatabaseRole: (databaseId: string, userId: string) =>
    request<{ ok: true }>(`${databaseBase(databaseId)}/members/${userId}`, {
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
    request<Invitation[]>(`${databaseBase(databaseId)}/invitations`),
  inviteToDatabase: (databaseId: string, role: Role) =>
    request<InvitationWithLink>(`${databaseBase(databaseId)}/invitations`, {
      method: 'POST',
      body: { role },
    }),
  revokeDatabaseInvitation: (databaseId: string, invitationId: string) =>
    request<Invitation>(
      `${databaseBase(databaseId)}/invitations/${invitationId}/revoke`,
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
