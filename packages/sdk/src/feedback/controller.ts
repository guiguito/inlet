import { LIMITS, validateAnswers, type ClientFormElement, type ClientFormPage, type ClientQuestionElement, type ErrorDetail, type FormDefinition } from '@inlet/shared/feedback-core';
import type {
  AnswerInput,
  AnswersInput,
  CreateSessionOptions,
  FeedbackError,
  FeedbackGateway,
  FeedbackSnapshot,
  FinalizePayload,
  PublishedForm,
  QuestionValidation,
  Result,
  ReactNativeFile,
  ScreenshotSource,
  ScreenshotState,
  SessionStatus,
  SubmissionIntent,
  SubmitOutcome,
  UploadedAttachment,
} from './types.js';

/**
 * One respondent's pass through one form (section 25.2, FR-193 to FR-200).
 *
 * The controller renders nothing. It owns the session — the pinned version, the intent
 * once there is one, the answers, the uploads and the outcome — exposes it as an
 * immutable snapshot, and notifies subscribers when that snapshot changes. React, Vue,
 * Svelte, a web component and a terminal all bind to it the same way.
 *
 * Everything that decides whether an answer is acceptable comes from
 * `@inlet/shared/feedback-core`, which is the same function the server runs (FR-195), so
 * the controller cannot be stricter or laxer than the finalization it is preparing.
 */

/** Renew an intent this long before it actually expires, so a slow upload is not caught out. */
const EXPIRY_SKEW_MS = 30_000;

export type ControllerOptions = CreateSessionOptions & {
  form: PublishedForm;
  gateway: FeedbackGateway;
  beforeSend?: (payload: FinalizePayload) => FinalizePayload | null | Promise<FinalizePayload | null>;
  debug: (message: string, detail?: unknown) => void;
  now: () => number;
};

type Retained = { questionId: string; source: ScreenshotSource };

export class FeedbackController {
  private readonly form: PublishedForm;
  private readonly gateway: FeedbackGateway;
  private readonly debug: (message: string, detail?: unknown) => void;
  private readonly now: () => number;
  private readonly retain: boolean;
  private readonly clientContext: Record<string, unknown> | undefined;

  private pageIndex = 0;
  private status: SessionStatus = 'editing';
  private answers: AnswersInput = {};
  private validation: Record<string, QuestionValidation> = {};
  private screenshots = new Map<string, { attachments: UploadedAttachment[]; uploads: Map<string, { filename?: string; progress: number }>; lost: number }>();
  private retained = new Map<string, Retained>();
  private intent: SubmissionIntent | null = null;
  private intentPromise: Promise<Result<SubmissionIntent>> | null = null;
  private result: FeedbackSnapshot['result'] = null;
  private error: FeedbackError | null = null;
  private abandoned = false;
  private uploadSeq = 0;

  private readonly listeners = new Set<(snapshot: FeedbackSnapshot) => void>();
  private snapshot: FeedbackSnapshot;

  constructor(private readonly options: ControllerOptions) {
    this.form = options.form;
    this.gateway = options.gateway;
    this.debug = options.debug;
    this.now = options.now;
    this.retain = options.retainScreenshotBytes ?? true;
    this.clientContext = options.clientContext;
    for (const question of this.questions()) {
      if (question.type === 'screenshot') {
        this.screenshots.set(question.id, { attachments: [], uploads: new Map(), lost: 0 });
      }
    }
    this.snapshot = this.build();
  }

  // --- Reading -------------------------------------------------------------------

  getSnapshot(): FeedbackSnapshot {
    return this.snapshot;
  }

  /** Subscribes to snapshot changes. Returns the unsubscriber. */
  subscribe(listener: (snapshot: FeedbackSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The version this session pinned at creation (FR-193). */
  get formVersion(): number {
    return this.form.formVersion;
  }

  // --- Answers and navigation (FR-197) --------------------------------------------

  /** Records an answer, or clears it when `answer` is undefined. */
  setAnswer(questionId: string, answer: AnswerInput | undefined): void {
    if (this.settled()) return;
    const next = { ...this.answers };
    if (answer === undefined) delete next[questionId];
    else next[questionId] = answer;
    this.answers = next;
    // A question the respondent is correcting stops being marked wrong as they type.
    if (this.validation[questionId] && !this.validation[questionId]!.valid) {
      const validation = { ...this.validation };
      delete validation[questionId];
      this.validation = validation;
    }
    this.emit();
  }

  /**
   * Validates the current page and advances if it passes. No server call: the rules are
   * the server's own, bundled (FR-195, FR-197).
   */
  next(): boolean {
    if (this.settled()) return false;
    const failed = this.checkCurrentPage();
    if (failed || this.pageIndex >= this.form.pages.length - 1) {
      this.emit();
      return false;
    }
    this.pageIndex += 1;
    this.validation = {};
    this.emit();
    return true;
  }

  back(): boolean {
    if (this.settled() || this.pageIndex === 0) return false;
    this.pageIndex -= 1;
    this.validation = {};
    this.emit();
    return true;
  }

  /** Checks the current page's questions and writes the result into the snapshot. */
  validatePage(): boolean {
    const failed = this.checkCurrentPage();
    this.emit();
    return !failed;
  }

  /** The check itself, without an emission, so `next` produces one snapshot rather than two. */
  private checkCurrentPage(): boolean {
    const page = this.form.pages[this.pageIndex];
    if (!page) {
      this.validation = {};
      return false;
    }
    const details = this.check([page]);
    this.validation = validationFor(page, details);
    return details.length > 0;
  }

  /**
   * Runs the shared rules over some pages of the pinned definition.
   *
   * Only the answers belonging to those pages are passed, so a question on a page the
   * respondent has not reached cannot report itself unanswered.
   */
  private check(pages: ClientFormPage[]): ErrorDetail[] {
    const definition = { pages: pages.map(stripClientLimits) } as FormDefinition;
    const ids = new Set(pages.flatMap((page) => page.elements.map((element) => element.id)));
    const scoped: AnswersInput = {};
    for (const [questionId, answer] of Object.entries(this.answers)) {
      if (ids.has(questionId)) scoped[questionId] = answer;
    }
    const outcome = validateAnswers(definition, scoped);
    return outcome.ok ? [] : outcome.details;
  }

  // --- Screenshots (FR-198) --------------------------------------------------------

  /**
   * Checks the file against the question's own limits, uploads it under the intent, and
   * records the attachment as the server stored it — at its stored dimensions and size,
   * not the source's.
   */
  async addScreenshot(questionId: string, file: ScreenshotSource): Promise<Result<UploadedAttachment>> {
    if (this.settled()) {
      return this.fail({ code: 'session_closed', message: 'This session is no longer accepting changes.' });
    }
    const question = this.questions().find((q) => q.id === questionId);
    if (!question || question.type !== 'screenshot') {
      return this.fail({ code: 'unknown_question', message: `This form has no screenshot question ${questionId}.` });
    }
    const state = this.screenshots.get(questionId)!;

    if (state.attachments.length + state.uploads.size >= question.maxCount) {
      return this.fail({
        code: 'too_many_attachments',
        message: `"${question.label}" accepts at most ${question.maxCount} ${question.maxCount === 1 ? 'screenshot' : 'screenshots'}.`,
        details: [{ questionId, code: 'too_many_attachments', message: 'No further screenshots.' }],
      });
    }

    const described = describe(file);
    if (!question.acceptedMediaTypes.includes(described.mediaType)) {
      return this.fail({
        code: 'unsupported_image_format',
        message: `A screenshot must be one of ${question.acceptedMediaTypes.join(', ')}.`,
        details: [{ questionId, code: 'unsupported_image_format', message: described.mediaType || 'unknown type' }],
      });
    }
    if (described.bytes > question.maxFileBytes) {
      return this.fail({
        code: 'file_too_large',
        message: `A screenshot may be at most ${Math.floor(question.maxFileBytes / (1024 * 1024))} MB.`,
        details: [{ questionId, code: 'file_too_large', message: `${described.bytes} bytes` }],
      });
    }

    const intent = await this.ensureIntent();
    if (!intent.ok) return this.fail(intent.error);

    const uploadId = `up_${++this.uploadSeq}`;
    state.uploads.set(uploadId, { ...(described.filename ? { filename: described.filename } : {}), progress: 0 });
    this.status = 'uploading';
    this.emit();

    const uploaded = await this.gateway.upload(intent.value, questionId, file, (fraction) => {
      const entry = state.uploads.get(uploadId);
      if (!entry) return;
      entry.progress = Math.max(0, Math.min(1, fraction));
      this.emit();
    });

    state.uploads.delete(uploadId);
    if (this.status === 'uploading' && !this.anyUploading()) this.status = 'editing';

    if (!uploaded.ok) {
      this.emit();
      return this.fail(uploaded.error);
    }

    state.attachments = [...state.attachments, uploaded.value];
    if (this.retain) this.retained.set(uploaded.value.attachmentId, { questionId, source: file });
    this.writeScreenshotAnswer(questionId);
    this.emit();
    return uploaded;
  }

  /** FR-198: drops the reference and releases the upload on a best-effort basis. */
  async removeScreenshot(questionId: string, attachmentId: string): Promise<void> {
    const state = this.screenshots.get(questionId);
    if (!state) return;
    state.attachments = state.attachments.filter((a) => a.attachmentId !== attachmentId);
    this.retained.delete(attachmentId);
    this.writeScreenshotAnswer(questionId);
    this.emit();
    if (this.intent) await this.gateway.release(this.intent, attachmentId);
  }

  private writeScreenshotAnswer(questionId: string): void {
    const state = this.screenshots.get(questionId)!;
    const next = { ...this.answers };
    if (state.attachments.length === 0) delete next[questionId];
    else next[questionId] = { attachmentIds: state.attachments.map((a) => a.attachmentId) };
    this.answers = next;
  }

  private anyUploading(): boolean {
    for (const state of this.screenshots.values()) if (state.uploads.size > 0) return true;
    return false;
  }

  // --- The intent (FR-193, FR-200) -------------------------------------------------

  /**
   * FR-193: an intent is obtained when one is about to be used, never at creation, so a
   * form abandoned on the first page costs no intent and no rate-limit budget.
   *
   * FR-200: an intent that has expired, or is about to, is replaced without the interface
   * hearing about it. Screenshots whose bytes are still held are uploaded again under the
   * new intent; the rest are counted as lost, which is what tells the interface to ask
   * for them again.
   */
  private async ensureIntent(): Promise<Result<SubmissionIntent>> {
    if (this.intent && !this.expiring(this.intent)) return { ok: true, value: this.intent };
    if (this.intentPromise) return this.intentPromise;

    const stale = this.intent;
    this.intentPromise = (async () => {
      const created = await this.gateway.createIntent(this.form.formVersion);
      if (!created.ok) return created;
      this.intent = created.value;
      if (stale) await this.reattach(created.value);
      return created;
    })().finally(() => {
      this.intentPromise = null;
    });
    return this.intentPromise;
  }

  private expiring(intent: SubmissionIntent): boolean {
    const expiresAt = Date.parse(intent.expiresAt);
    return Number.isFinite(expiresAt) && this.now() >= expiresAt - EXPIRY_SKEW_MS;
  }

  /** Re-uploads what is still in memory under a fresh intent; counts the rest as lost. */
  private async reattach(intent: SubmissionIntent): Promise<void> {
    this.debug('The submission intent expired mid-session; a new one was obtained.');
    for (const [questionId, state] of this.screenshots) {
      const carried = state.attachments;
      state.attachments = [];
      for (const attachment of carried) {
        const held = this.retained.get(attachment.attachmentId);
        this.retained.delete(attachment.attachmentId);
        if (!held) {
          state.lost += 1;
          continue;
        }
        const uploaded = await this.gateway.upload(intent, questionId, held.source);
        if (uploaded.ok) {
          state.attachments = [...state.attachments, uploaded.value];
          this.retained.set(uploaded.value.attachmentId, held);
        } else {
          state.lost += 1;
          this.debug('A screenshot could not be attached to the new intent.', uploaded.error);
        }
      }
      this.writeScreenshotAnswer(questionId);
    }
    this.emit();
  }

  // --- Submitting (FR-199, FR-196, FR-205) -----------------------------------------

  /**
   * Finalizes once, with every answer and the merged `clientContext`.
   *
   * A `duplicate` is a success: it is the original result of a finalization this session
   * already made, which is exactly what a retry is supposed to return.
   */
  async submit(): Promise<SubmitOutcome> {
    if (this.abandoned) {
      return { status: 'failed', error: { code: 'session_abandoned', message: 'This session was abandoned.' } };
    }
    /*
     * A finalization is already in flight for this session. Returning here is not a
     * nicety: `ensureIntent` below would renew an intent that had expired meanwhile, and
     * a second intent carrying the same answers is a second submission. The queue is
     * still trying with the first one, and the snapshot is where the answer will appear.
     */
    if (this.status === 'submitting') return { status: 'pending' };
    // FR-199: a session that has already submitted answers from memory, without a request.
    if (this.status === 'submitted' && this.result) {
      return { status: 'duplicate', submissionId: this.result.submissionId, formVersion: this.result.formVersion, createdAt: this.result.createdAt };
    }

    const details = this.check(this.form.pages);
    if (details.length > 0) {
      this.goToFirstFailure(details);
      return { status: 'invalid', details };
    }

    /*
     * FR-205, before the intent: an oversized `clientContext` cannot be fixed by anything
     * that happens below, and burning an intent on it would spend a rate-limit slot the
     * respondent may need to actually submit.
     */
    const oversized = this.tooLarge(this.clientContext);
    if (oversized) return this.failSubmit(oversized);

    /*
     * The intent comes before the payload, and the order is load-bearing.
     *
     * `ensureIntent` may renew an expired intent, and renewing re-uploads every screenshot
     * under the new one (FR-200), which changes the attachment IDs in `this.answers`. A
     * payload built before this line would name the attachments of the intent that expired,
     * and the server would refuse it with `attachment_reference_invalid` — a failure the
     * respondent could do nothing about and would never understand.
     */
    const intent = await this.ensureIntent();
    if (!intent.ok) return this.failSubmit(intent.error);

    // And a renewal that lost a screenshot may have made a required question unanswered.
    const afterRenewal = this.check(this.form.pages);
    if (afterRenewal.length > 0) {
      this.goToFirstFailure(afterRenewal);
      return { status: 'invalid', details: afterRenewal };
    }

    let payload: FinalizePayload = {
      formVersion: this.form.formVersion,
      answers: this.answers,
      ...(this.clientContext && Object.keys(this.clientContext).length > 0
        ? { clientContext: this.clientContext }
        : {}),
    };

    if (this.options.beforeSend) {
      let hooked: FinalizePayload | null;
      try {
        hooked = await this.options.beforeSend(payload);
      } catch (error) {
        this.debug('beforeSend threw; the submission was not sent.', error);
        return this.failSubmit({ code: 'before_send_failed', message: 'beforeSend threw.' });
      }
      if (!hooked) {
        this.debug('beforeSend returned null; the submission was dropped.');
        return this.failSubmit({ code: 'dropped_by_before_send', message: 'beforeSend dropped this submission.' });
      }
      payload = hooked;
      // The hook may have replaced the context with a larger one.
      const grown = this.tooLarge(payload.clientContext);
      if (grown) return this.failSubmit(grown);
    }

    this.status = 'submitting';
    this.error = null;
    this.emit();

    const outcome = await this.gateway.finalize(intent.value, payload, (late) => {
      // FR-201: the queue delivered it after `submit` had already reported `pending`.
      if (this.status === 'submitting') this.settle(late);
    });
    return this.settle(outcome);
  }

  /** FR-205: the 16 KiB ceiling of FR-062A, measured on the serialized UTF-8 form. */
  private tooLarge(clientContext: Record<string, unknown> | undefined): FeedbackError | null {
    if (clientContext === undefined || Object.keys(clientContext).length === 0) return null;
    const bytes = new TextEncoder().encode(JSON.stringify(clientContext)).length;
    if (bytes <= LIMITS.clientContextMaxBytes) return null;
    return {
      code: 'client_context_too_large',
      message: `clientContext may be at most ${LIMITS.clientContextMaxBytes} bytes when serialized as UTF-8; this one is ${bytes}.`,
    };
  }

  /** Applies an outcome to the session's own state, wherever it came from. */
  private settle(outcome: SubmitOutcome): SubmitOutcome {
    switch (outcome.status) {
      case 'accepted':
      case 'duplicate':
        this.status = 'submitted';
        this.result = { submissionId: outcome.submissionId, formVersion: outcome.formVersion, createdAt: outcome.createdAt };
        this.error = null;
        // The bytes are no longer needed; a submitted session never re-uploads.
        this.retained.clear();
        break;
      case 'pending':
        this.status = 'submitting';
        break;
      case 'invalid':
        // FR-196: the server refused the answers. Back to editing, on the offending page.
        this.status = 'editing';
        this.goToFirstFailure(outcome.details);
        return outcome;
      case 'failed':
        this.status = outcome.error.code === 'intent_expired' ? 'expired' : 'failed';
        this.error = outcome.error;
        break;
    }
    this.emit();
    return outcome;
  }

  /** FR-196: the page holding the first failing question becomes current. */
  private goToFirstFailure(details: ErrorDetail[]): void {
    const failing = details.find((detail) => detail.questionId)?.questionId;
    if (failing) {
      const index = this.form.pages.findIndex((page) => page.elements.some((element) => element.id === failing));
      if (index >= 0) this.pageIndex = index;
    }
    const page = this.form.pages[this.pageIndex];
    this.validation = page ? validationFor(page, details) : {};
    this.status = 'editing';
    this.emit();
  }

  /** FR-197: answers are discarded; nothing is sent. */
  abandon(): void {
    this.abandoned = true;
    this.answers = {};
    this.validation = {};
    this.retained.clear();
    for (const state of this.screenshots.values()) {
      state.attachments = [];
      state.uploads.clear();
    }
    // One last snapshot, so an interface still on screen draws the cleared form rather
    // than the answers somebody just asked to discard. Then nobody is listening.
    this.emit();
    this.listeners.clear();
  }

  // --- Plumbing --------------------------------------------------------------------

  private settled(): boolean {
    return this.abandoned || this.status === 'submitted' || this.status === 'submitting';
  }

  private fail<T>(error: FeedbackError): Result<T> {
    this.error = error;
    this.emit();
    return { ok: false, error };
  }

  private failSubmit(error: FeedbackError): SubmitOutcome {
    this.status = 'failed';
    this.error = error;
    this.emit();
    return { status: 'failed', error };
  }

  private questions(): ClientQuestionElement[] {
    return this.form.pages.flatMap((page) => page.elements.filter(isClientQuestion));
  }

  private emit(): void {
    this.snapshot = this.build();
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private build(): FeedbackSnapshot {
    const page = this.form.pages[this.pageIndex] ?? { id: '', elements: [] };
    const screenshots: Record<string, ScreenshotState> = {};
    for (const [questionId, state] of this.screenshots) {
      const question = this.questions().find((q) => q.id === questionId);
      const maxCount = question && question.type === 'screenshot' ? question.maxCount : 0;
      screenshots[questionId] = {
        attachments: [...state.attachments],
        uploads: [...state.uploads].map(([uploadId, upload]) => ({ uploadId, ...upload })),
        remaining: Math.max(0, maxCount - state.attachments.length - state.uploads.size),
        lost: state.lost,
      };
    }
    return {
      status: this.status,
      formVersion: this.form.formVersion,
      pageIndex: this.pageIndex,
      pageCount: this.form.pages.length,
      page: { id: page.id, elements: page.elements },
      isFirstPage: this.pageIndex === 0,
      isLastPage: this.pageIndex >= this.form.pages.length - 1,
      answers: this.answers,
      validation: this.validation,
      screenshots,
      result: this.result,
      error: this.error,
    };
  }
}

/** Turns the shared rules' details into per-question validation for one page. */
function validationFor(page: ClientFormPage, details: ErrorDetail[]): Record<string, QuestionValidation> {
  const validation: Record<string, QuestionValidation> = {};
  for (const element of page.elements) {
    const detail = details.find((d) => d.questionId === element.id);
    if (detail) validation[element.id] = { valid: false, code: detail.code, message: detail.message };
  }
  return validation;
}

/**
 * The client-facing definition carries the platform's upload limits on every screenshot
 * question (FR-046); the shared rules read the stored shape. Dropping the two injected
 * keys is what makes the SDK run the server's own function over the server's own data.
 */
function stripClientLimits(page: ClientFormPage): { id: string; elements: unknown[] } {
  return {
    id: page.id,
    elements: page.elements.map((element) => {
      if (element.type !== 'screenshot') return element;
      const { acceptedMediaTypes: _a, maxFileBytes: _b, ...stored } = element as ClientFormElement & {
        acceptedMediaTypes?: readonly string[];
        maxFileBytes?: number;
      };
      return stored;
    }),
  };
}

function isClientQuestion(element: ClientFormElement): element is ClientQuestionElement {
  return element.type === 'choice' || element.type === 'text' || element.type === 'email' || element.type === 'screenshot';
}

/**
 * The media type of an image from its own first bytes, for the Node case where a
 * `Buffer` arrives with nothing else (FR-207).
 *
 * Only the three types the platform accepts (section 9.3); anything else is returned as
 * the empty string and refused by the same check that refuses a `image/gif`. The server
 * validates by content too, so this is about failing locally rather than about trust.
 */
export function sniffImageMediaType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return '';
}

/** What the SDK can tell about a file before it uploads it (FR-198). */
/** FR-211: an image picker's `{ uri, name, type }`, which only React Native's FormData can send. */
export function isReactNativeFile(file: ScreenshotSource): file is ReactNativeFile {
  return typeof (file as { uri?: unknown }).uri === 'string' && !(file instanceof Blob) && !(file instanceof Uint8Array);
}

function describe(file: ScreenshotSource): { mediaType: string; bytes: number; filename?: string } {
  if (file instanceof Blob) {
    const named = file as Blob & { name?: string };
    return { mediaType: file.type, bytes: file.size, ...(named.name ? { filename: named.name } : {}) };
  }
  if (file instanceof Uint8Array) {
    return { mediaType: sniffImageMediaType(file), bytes: file.byteLength };
  }
  if (isReactNativeFile(file)) {
    // FR-198: no size, no local check; the server's limit decides.
    return { mediaType: file.type, bytes: file.size ?? 0, filename: file.name };
  }
  return {
    mediaType: file.mediaType,
    bytes: file.data.byteLength,
    ...(file.filename ? { filename: file.filename } : {}),
  };
}
