import { sniffImageMediaType } from './controller.js';
import { PendingQueue, type PendingSubmission, type SendOutcome } from './transport.js';
import type {
  FeedbackError,
  FeedbackGateway,
  FinalizePayload,
  PublishedForm,
  Result,
  ScreenshotSource,
  SubmissionIntent,
  SubmitOutcome,
  UploadedAttachment,
} from './types.js';
import type { QueueStore } from '../store.js';

/**
 * The HTTP half of the module: the four client-flow routes of section 9.2, plus the
 * pending-submission queue that makes finalization safe to retry.
 *
 * It is behind the `FeedbackGateway` interface for one reason: an Electron renderer holds
 * no key and makes no request (FR-208), so it drives a controller whose gateway forwards
 * these same five operations over IPC to a main process that owns one of these.
 */

/** What an upload needs, so the browser adapter can supply one that reports real progress. */
export type Uploader = (
  url: string,
  headers: Record<string, string>,
  body: FormData,
  onProgress?: (fraction: number) => void,
) => Promise<UploadResponse>;

export type UploadResponse = { status: number; body: unknown };

export type HttpGatewayOptions = {
  baseUrl: string;
  publishableKey: string;
  feedbackDatabaseId: string;
  store: QueueStore;
  fetch: typeof fetch;
  debug: (message: string, detail?: unknown) => void;
  now: () => number;
  upload?: Uploader;
};

const INTENT_TOKEN_HEADER = 'x-inlet-intent-token';

/** FR-210: what `/v1/health` must name for this deployment to serve a browser client. */
export const CROSS_ORIGIN_CAPABILITY = 'feedback-cross-origin';

export class HttpGateway implements FeedbackGateway {
  readonly queue: PendingQueue;
  private readonly base: string;
  private readonly upload_: Uploader;
  private serverChecked = false;
  private form: Promise<Result<PublishedForm>> | null = null;

  constructor(private readonly options: HttpGatewayOptions) {
    this.base = options.baseUrl.replace(/\/$/, '');
    this.upload_ = options.upload ?? fetchUploader(options.fetch);
    this.queue = new PendingQueue({
      feedbackDatabaseId: options.feedbackDatabaseId,
      store: options.store,
      debug: options.debug,
      now: options.now,
      send: (pending) => this.send(pending),
    });
  }

  private get db(): string {
    return `${this.base}/v1/feedback-databases/${encodeURIComponent(this.options.feedbackDatabaseId)}`;
  }

  private headers(intent?: SubmissionIntent): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.publishableKey}`,
      ...(intent ? { [INTENT_TOKEN_HEADER]: intent.token } : {}),
    };
  }

  /**
   * FR-192: the active published definition, read once and kept for the life of the
   * client.
   *
   * A refusal the server gave is cached too — a form that is not published stays
   * unpublished for longer than a respondent's visit — and `refreshForm` is how a
   * long-lived application asks again. A request that never completed is not cached: an
   * application that starts while the network is down would otherwise never see its form
   * again, however long it ran.
   */
  async getForm(): Promise<Result<PublishedForm>> {
    if (!this.form) this.form = this.readForm();
    const result = await this.form;
    if (!result.ok && result.error.code === 'network_unavailable') this.form = null;
    return result;
  }

  refreshForm(): Promise<Result<PublishedForm>> {
    this.form = this.readForm();
    return this.form;
  }

  private async readForm(): Promise<Result<PublishedForm>> {
    await this.checkServer();
    return this.json<PublishedForm>('GET', `${this.db}/form`, this.headers());
  }

  async createIntent(formVersion: number): Promise<Result<SubmissionIntent>> {
    await this.checkServer();
    return this.json<SubmissionIntent>('POST', `${this.db}/submission-intents`, {
      ...this.headers(),
      'content-type': 'application/json',
    }, JSON.stringify({ formVersion }));
  }

  async upload(
    intent: SubmissionIntent,
    questionId: string,
    file: ScreenshotSource,
    onProgress?: (fraction: number) => void,
  ): Promise<Result<UploadedAttachment>> {
    const { blob, filename } = toBlob(file);
    const body = new FormData();
    body.append('questionId', questionId);
    body.append('file', blob, filename);

    let response: UploadResponse;
    try {
      response = await this.upload_(
        `${this.db}/submission-intents/${intent.intentId}/attachments`,
        this.headers(intent),
        body,
        onProgress,
      );
    } catch (error) {
      return { ok: false, error: networkError(error) };
    }
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, value: response.body as UploadedAttachment };
    }
    return { ok: false, error: errorFrom(response.body, response.status) };
  }

  /**
   * FR-198: best effort. An upload nobody references expires with its intent, so a failure
   * to release costs a few kilobytes for the intent's lifetime and is not worth an error.
   */
  async release(intent: SubmissionIntent, attachmentId: string): Promise<void> {
    try {
      await this.options.fetch(
        `${this.db}/submission-intents/${intent.intentId}/attachments/${encodeURIComponent(attachmentId)}`,
        { method: 'DELETE', headers: this.headers(intent) },
      );
    } catch (error) {
      this.options.debug('A screenshot could not be released; it expires with the intent.', error);
    }
  }

  /**
   * FR-201: finalization goes through the queue, always.
   *
   * The request is attempted immediately, so the ordinary case is one round trip and an
   * answer. What the queue adds is what happens when that round trip does not complete:
   * the entry is already on disk, so the answer arrives on this page or the next start,
   * and nothing decides locally what only the server can decide.
   */
  async finalize(
    intent: SubmissionIntent,
    payload: FinalizePayload,
    onSettled?: (outcome: SubmitOutcome) => void,
  ): Promise<SubmitOutcome> {
    const pending: PendingSubmission = {
      feedbackDatabaseId: this.options.feedbackDatabaseId,
      intentId: intent.intentId,
      token: intent.token,
      payload,
      payloadKey: payloadKey(payload),
      queuedAt: this.options.now(),
    };

    await this.queue.load();
    const held = this.queue.pendingFor(intent.intentId);
    if (held) {
      // FR-203: never two finalizations for one intent. The same payload is the caller
      // asking again for an answer that has not arrived; a different one is a bug we
      // refuse here rather than letting the server answer intent_payload_conflict.
      if (held.payloadKey !== pending.payloadKey) {
        return {
          status: 'failed',
          error: {
            code: 'submission_already_pending',
            message:
              'A different version of this submission is already waiting to be delivered. Wait for it to settle before changing the answers.',
          },
        };
      }
      if (onSettled) this.queue.waitFor(intent.intentId, onSettled);
      return this.awaitAnswer(intent.intentId);
    }

    await this.queue.enqueue(pending);
    if (onSettled) this.queue.waitFor(intent.intentId, onSettled);
    return this.awaitAnswer(intent.intentId);
  }

  /**
   * Resolves with the server's answer, or `pending` once the queue has stopped trying for
   * now. A promise that might never settle would be a trap in an interface, so the
   * snapshot, not this promise, is what a client renders while a submission is in flight.
   */
  private awaitAnswer(intentId: string): Promise<SubmitOutcome> {
    return new Promise<SubmitOutcome>((resolve) => {
      let done = false;
      const settle = (outcome: SubmitOutcome) => {
        if (done) return;
        done = true;
        resolve(outcome);
      };
      this.queue.waitFor(intentId, settle);
      void this.queue.flush().then(() => {
        if (this.queue.pendingFor(intentId)) settle({ status: 'pending' });
      });
    });
  }

  /** One finalization attempt, mapped onto what the queue does next (FR-201). */
  private async send(pending: PendingSubmission): Promise<SendOutcome> {
    await this.checkServer();
    const url = `${this.db}/submission-intents/${pending.intentId}/submit`;
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.publishableKey}`,
          [INTENT_TOKEN_HEADER]: pending.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify(pending.payload),
      });
    } catch (error) {
      return { kind: 'failed', error: networkError(error) };
    }

    if (response.status === 429) {
      const header = Number(response.headers.get('retry-after'));
      return {
        kind: 'rate_limited',
        retryAfterMs: (Number.isFinite(header) && header > 0 ? header : 60) * 1000,
      };
    }
    /*
     * A 5xx is not an answer about this submission: the server did not decide, the intent
     * is still active, and replaying is exactly what the intent makes safe. This is the
     * same line the crash transport draws, and FD-012 means the same thing by "answered"
     * in both modules.
     */
    if (response.status >= 500) {
      return { kind: 'failed', error: { code: 'internal_error', message: `The server answered ${response.status}.` } };
    }

    const body = await response.json().catch(() => null);
    if (response.ok) {
      const result = body as { submissionId: string; status: 'accepted' | 'duplicate'; formVersion: number; createdAt: string };
      return { kind: 'answered', outcome: { status: result.status, submissionId: result.submissionId, formVersion: result.formVersion, createdAt: result.createdAt } };
    }
    const error = errorFrom(body, response.status);
    // FR-196: the server refused the answers themselves; the session goes back to editing.
    if (error.code === 'validation_failed') {
      return { kind: 'answered', outcome: { status: 'invalid', details: error.details ?? [] } };
    }
    return { kind: 'answered', outcome: { status: 'failed', error } };
  }

  flush(timeoutMs?: number): Promise<void> {
    return this.queue.flush(timeoutMs);
  }

  close(): void {
    this.queue.close();
  }

  /** Replays whatever a previous run left behind, without blocking `init`. */
  start(): void {
    void this.queue.load().then(() => this.queue.flush());
  }

  private async json<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<Result<T>> {
    let response: Response;
    try {
      response = await this.options.fetch(url, { method, headers, ...(body === undefined ? {} : { body }) });
    } catch (error) {
      return { ok: false, error: networkError(error) };
    }
    const parsed = await response.json().catch(() => null);
    if (response.ok) return { ok: true, value: parsed as T };
    return { ok: false, error: errorFrom(parsed, response.status) };
  }

  /**
   * FR-210: the minimum-server check, once, before the first request that matters.
   *
   * A deployment older than Release 7 serves the four collection routes but refuses a
   * browser's preflight, which reaches `fetch` as an indistinguishable network failure.
   * Saying so once through `debug` is the difference between "upgrade your Inlet" and an
   * afternoon spent looking at the wrong thing.
   */
  private async checkServer(): Promise<void> {
    if (this.serverChecked) return;
    this.serverChecked = true;
    try {
      const response = await this.options.fetch(`${this.base}/v1/health`, { method: 'GET' });
      if (!response.ok) {
        this.options.debug(`Inlet answered ${response.status} to a health check.`);
        return;
      }
      const body = (await response.json().catch(() => null)) as { capabilities?: string[] } | null;
      if (!body?.capabilities?.includes(CROSS_ORIGIN_CAPABILITY)) {
        this.options.debug(
          'This Inlet deployment predates Release 7; it does not answer feedback requests from another origin. Upgrade the server, or serve your application from the same origin.',
        );
      }
    } catch (error) {
      this.options.debug('Inlet is not reachable.', error);
    }
  }
}

/** The default uploader. `fetch` cannot report upload progress, so it reports the ends. */
export function fetchUploader(impl: typeof fetch): Uploader {
  return async (url, headers, body, onProgress) => {
    onProgress?.(0);
    const response = await impl(url, { method: 'POST', headers, body });
    const parsed = await response.json().catch(() => null);
    onProgress?.(1);
    return { status: response.status, body: parsed };
  };
}

function toBlob(file: ScreenshotSource): { blob: Blob; filename: string } {
  if (file instanceof Blob) {
    const named = file as Blob & { name?: string };
    return { blob: file, filename: named.name ?? 'screenshot' };
  }
  if (file instanceof Uint8Array) {
    return { blob: new Blob([bytesOf(file)], { type: sniffImageMediaType(file) }), filename: 'screenshot' };
  }
  /*
   * The view itself, never `.buffer`. A Node `Buffer` is a view into a shared pool, so its
   * `buffer` is several kilobytes of unrelated allocations with these bytes somewhere
   * inside; uploading that produced "That file is not a readable image" from the server.
   * `Blob` honours a view's offset and length, which is exactly what is wanted.
   */
  const bytes = file.data instanceof Uint8Array ? bytesOf(file.data) : new Uint8Array(file.data);
  return { blob: new Blob([bytes], { type: file.mediaType }), filename: file.filename ?? 'screenshot' };
}

/**
 * A copy of the view's own bytes, never the view's `.buffer`.
 *
 * A Node `Buffer` is a window onto a shared pool, so its backing ArrayBuffer holds
 * unrelated allocations either side of these bytes; uploading it produced "That file is
 * not a readable image" from the server. A copy also settles the SharedArrayBuffer case,
 * which `Blob` will not take.
 */
function bytesOf(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

export function networkError(error: unknown): FeedbackError {
  return {
    code: 'network_unavailable',
    message: error instanceof Error ? error.message : 'The request did not complete.',
  };
}

export function errorFrom(body: unknown, status: number): FeedbackError {
  const error = (body as { error?: { code?: string; message?: string; details?: FeedbackError['details'] } } | null)?.error;
  return {
    code: error?.code ?? `http_${status}`,
    message: error?.message ?? `The server answered ${status}.`,
    ...(error?.details ? { details: error.details } : {}),
  };
}

/**
 * A stable key for "the same payload", so FR-203 can compare two `submit` calls without
 * hashing. Keys are sorted, so an object built in a different order is the same payload,
 * which is the comparison the server makes too.
 */
export function payloadKey(payload: FinalizePayload): string {
  return JSON.stringify(payload, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  );
}
