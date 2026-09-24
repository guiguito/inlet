import type {
  AnswersInput,
  ClientFormElement,
  ClientFormPage,
  ErrorDetail,
} from '@inlet/shared/feedback-core';
import type { QueueStore } from '../store.js';

/**
 * The public types of `inlet-sdk/feedback` (Feedback Collection PRD section 25).
 *
 * Everything describing a form or an answer is re-exported from `@inlet/shared`, which
 * the package bundles at build (FR-195), so a client's types and the server's are the
 * same declarations rather than two copies that agree today.
 */

export type {
  AnswerInput,
  AnswersInput,
  ChoiceOption,
  ChoiceQuestion,
  ClientFormElement,
  ClientFormPage,
  ClientScreenshotQuestion,
  EmailQuestion,
  ErrorDetail,
  QuestionElement,
  ScreenshotQuestion,
  TextQuestion,
} from '@inlet/shared/feedback-core';
export type { QueueStore } from '../store.js';

/**
 * Why a call did not succeed.
 *
 * `code` is the server's own error code (section 9.5) wherever the server answered, so
 * `form_not_published`, `feedback_database_inaccessible` and `intent_expired` reach a
 * client unchanged. Three codes are the SDK's own, for failures that never reach the
 * server, and are the only ones an integrator has to learn:
 *
 * - `network_unavailable` — the request did not complete. Nothing was decided.
 * - `client_context_too_large` — refused locally against FR-062A's 16 KiB (FR-205).
 * - `submission_already_pending` — a different payload was offered for an intent whose
 *   finalization is already queued (FR-203).
 */
export type FeedbackError = {
  code:
    | 'network_unavailable'
    | 'client_context_too_large'
    | 'submission_already_pending'
    | (string & {});
  message: string;
  /** Question- or field-level detail, as section 9.5 returns it. */
  details?: ErrorDetail[];
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: FeedbackError };

/** The active published form, as `getForm` returns it (FR-192). */
export type PublishedForm = {
  feedbackDatabaseId: string;
  formVersionId: string;
  formVersion: number;
  publishedAt: string;
  pages: ClientFormPage[];
};

/** A submission intent, as the server issues it. The token never leaves the SDK. */
export type SubmissionIntent = {
  intentId: string;
  token: string;
  formVersion: number;
  expiresAt: string;
};

/** One screenshot the server has stored, described as the server stored it (FR-198). */
export type UploadedAttachment = {
  attachmentId: string;
  mediaType: string;
  originalMediaType: string;
  width: number;
  height: number;
  bytes: number;
  originalBytes: number;
};

/** What the module puts on the wire at finalization, and nothing else (FR-204). */
export type FinalizePayload = {
  formVersion: number;
  answers: AnswersInput;
  clientContext?: Record<string, unknown>;
};

/**
 * The outcome of `submit` (FR-199, FR-201).
 *
 * `duplicate` is a success: the intent had already been finalized with this payload, so
 * the submission exists and this is its original result. `pending` means the request did
 * not complete and the finalization is queued; the session stays `submitting` and the
 * snapshot settles when the server answers, on this page or a later one.
 */
export type SubmitOutcome =
  | { status: 'accepted' | 'duplicate'; submissionId: string; formVersion: number; createdAt: string }
  | { status: 'pending' }
  | { status: 'invalid'; details: ErrorDetail[] }
  | { status: 'failed'; error: FeedbackError };

export type SessionStatus =
  | 'editing'
  | 'uploading'
  | 'submitting'
  | 'submitted'
  | 'failed'
  | 'expired';

/** Per-question validation on the current page, as the shared rules decided it (FR-195). */
export type QuestionValidation = {
  /** False only once the question has been checked and failed. */
  valid: boolean;
  code?: string;
  message?: string;
};

/** A screenshot still on its way up. `progress` is 0 to 1. */
export type ScreenshotUpload = { uploadId: string; filename?: string; progress: number };

/** FR-194: everything an interface needs to draw one screenshot question. */
export type ScreenshotState = {
  attachments: UploadedAttachment[];
  uploads: ScreenshotUpload[];
  /** How many further attachments this question accepts, uploads in flight counted. */
  remaining: number;
  /**
   * FR-200: attachments that were lost when the intent was renewed because their bytes
   * were no longer held. The interface asks the respondent to attach them again.
   */
  lost: number;
};

/**
 * FR-194: an immutable description of what to show now. A new object on every change,
 * so a subscriber can compare by identity and a React binding needs no deep equality.
 */
export type FeedbackSnapshot = {
  status: SessionStatus;
  /** The version this session pinned at creation and will submit against (FR-193). */
  formVersion: number;
  pageIndex: number;
  pageCount: number;
  page: { id: string; elements: ClientFormElement[] };
  isFirstPage: boolean;
  isLastPage: boolean;
  answers: AnswersInput;
  /** Keyed by question ID, for the questions on the current page only. */
  validation: Record<string, QuestionValidation>;
  /** Keyed by question ID, for every screenshot question in the form. */
  screenshots: Record<string, ScreenshotState>;
  /** The stored submission, once there is one. */
  result: { submissionId: string; formVersion: number; createdAt: string } | null;
  /** Why the session is `failed` or `expired`, or the last refusal that did not change the status. */
  error: FeedbackError | null;
};

/**
 * What may be handed to `addScreenshot`.
 *
 * A `Blob` or `File` carries its own media type, which is the browser case. Node has
 * neither, so FR-207 accepts a `Buffer` — any `Uint8Array` — whose media type is read
 * from its first bytes, and the explicit form for anything those bytes do not identify.
 */
export type ScreenshotSource =
  | Blob
  | Uint8Array
  | { data: Uint8Array | ArrayBuffer; filename?: string; mediaType: string }
  | ReactNativeFile;

/**
 * FR-198, FR-211: a file on a React Native device, as an image picker returns it. React
 * Native's `FormData` uploads it from `uri`. Without `size` the local size check is
 * skipped and the server's limit decides.
 */
export type ReactNativeFile = { uri: string; name: string; type: string; size?: number };

export type FeedbackInitOptions = {
  /** The Inlet deployment, for example https://inlet.example.com */
  baseUrl: string;
  /** A publishable client key (`ipk_…`). A secret key is refused (FR-191). */
  publishableKey: string;
  /** The feedback database, like fdb_9rdayr4rstbv. */
  feedbackDatabaseId: string;
  /**
   * Merged into the `clientContext` of every submission (FR-191). A session may add its
   * own; the session's keys win. Measured against 16 KiB before anything is queued.
   */
  clientContext?: Record<string, unknown>;
  /** Runs on the finalization payload before it is queued. Return null to drop it (FR-205). */
  beforeSend?: (payload: FinalizePayload) => FinalizePayload | null | Promise<FinalizePayload | null>;
  /** Receives warnings and transport events. Silent by default. */
  debug?: (message: string, detail?: unknown) => void;
  /** Where pending submissions live across restarts. Adapters supply one; the default is memory. */
  store?: QueueStore;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Tests inject a clock. */
  now?: () => number;
  /**
   * FR-204: attach the SDK identity of Foundations FD-016 to each submission — the session
   * ID, the user ID when one is set, and the installation ID while an analytics client is
   * enabled. Default true; `false` sends no identity field at all.
   */
  identity?: boolean;
  /** Fills a buffer with random bytes, for runtimes without `crypto.getRandomValues` (FR-211). */
  random?: (bytes: Uint8Array) => void;
  /** Per-request timeout in milliseconds, uploads excepted. Default 20000. */
  timeoutMs?: number;
};

/**
 * FR-204: the identity fields a finalization carries, fixed when `submit` is called and
 * never part of the payload a retry is compared on.
 */
export type SubmissionIdentity = { installationId?: string; sessionId?: string; userId?: string };

/** The five network steps of the client flow, so a renderer can perform them elsewhere (FR-208). */
export type FeedbackGateway = {
  getForm(): Promise<Result<PublishedForm>>;
  createIntent(formVersion: number): Promise<Result<SubmissionIntent>>;
  upload(
    intent: SubmissionIntent,
    questionId: string,
    file: ScreenshotSource,
    onProgress?: (fraction: number) => void,
  ): Promise<Result<UploadedAttachment>>;
  /** Best effort, per FR-198: an unreleased upload expires with its intent. */
  release(intent: SubmissionIntent, attachmentId: string): Promise<void>;
  /**
   * `onSettled` hears the server's real answer whenever it arrives, which may be long
   * after the returned promise resolved `pending` (FR-201).
   */
  finalize(
    intent: SubmissionIntent,
    payload: FinalizePayload,
    onSettled?: (outcome: SubmitOutcome) => void,
  ): Promise<SubmitOutcome>;
};

export type CreateSessionOptions = {
  /** The version to pin. Defaults to the active one (FR-193). */
  formVersion?: number;
  /** Merged over the client's `clientContext` for this session's submission. */
  clientContext?: Record<string, unknown>;
  /**
   * Whether uploaded screenshots keep their bytes in memory so the session can re-upload
   * them if the intent expires (FR-200). Default true. Turn it off to bound memory and
   * accept that an expired intent asks the respondent to attach them again.
   */
  retainScreenshotBytes?: boolean;
};
