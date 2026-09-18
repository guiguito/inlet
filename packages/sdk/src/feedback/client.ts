import { MemoryStore } from '../store.js';
import { FeedbackController } from './controller.js';
import { HttpGateway, type Uploader } from './gateway.js';
import type {
  CreateSessionOptions,
  FeedbackGateway,
  FeedbackInitOptions,
  PublishedForm,
  Result,
} from './types.js';

export const SDK_NAME = 'inlet-sdk';
export const SDK_VERSION = '0.1.0';

/**
 * The feedback client (FR-190 to FR-192).
 *
 * `init` returns one of these and the module-level functions delegate to the last one
 * created, which is the shape `inlet-sdk/crash` already has and the one an integrator
 * using both will expect. The class is exported for tests and for an application
 * collecting into two feedback databases.
 */
export class FeedbackClient {
  readonly gateway: HttpGateway;
  private readonly debug: (message: string, detail?: unknown) => void;
  private readonly now: () => number;
  private closed = false;

  constructor(
    readonly options: FeedbackInitOptions,
    /** Adapters inject an uploader that can report real progress (FR-198). */
    deps: { upload?: Uploader } = {},
  ) {
    if (typeof options.publishableKey !== 'string' || !options.publishableKey.startsWith('ipk_')) {
      // FR-191, FD-011: a secret key in an application is a leak, and a key of the wrong
      // shape is a misconfiguration. Both are the integrator's to fix, at startup.
      throw new Error(
        'inlet-sdk/feedback: init needs a publishable client key (ipk_…). A secret server key must never ship in an application.',
      );
    }
    if (!options.baseUrl || !options.feedbackDatabaseId) {
      throw new Error('inlet-sdk/feedback: init needs baseUrl and feedbackDatabaseId.');
    }
    this.debug = options.debug ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.gateway = new HttpGateway({
      baseUrl: options.baseUrl,
      publishableKey: options.publishableKey,
      feedbackDatabaseId: options.feedbackDatabaseId,
      store: options.store ?? new MemoryStore(),
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      debug: this.debug,
      now: this.now,
      ...(deps.upload ? { upload: deps.upload } : {}),
    });
    // FR-201: a submission a previous run could not deliver is delivered now.
    this.gateway.start();
  }

  /** FR-192: the active published definition, cached for the life of the client. */
  getForm(): Promise<Result<PublishedForm>> {
    return this.gateway.getForm();
  }

  /** Asks the server again, for an application that outlives a publish. */
  refreshForm(): Promise<Result<PublishedForm>> {
    return this.gateway.refreshForm();
  }

  /**
   * Opens one respondent's session (FR-193).
   *
   * Reads the form if it has not been read, because a session without a definition has
   * nothing to pin, nothing to validate against and nothing to show. No intent is created
   * here; that waits for the first upload or the first submit.
   */
  async createSession(options: CreateSessionOptions = {}): Promise<Result<FeedbackController>> {
    if (this.closed) {
      return {
        ok: false,
        error: { code: 'client_closed', message: 'This Inlet client was closed; call init again.' },
      };
    }
    const form =
      options.formVersion === undefined
        ? await this.getForm()
        : await this.versioned(options.formVersion);
    if (!form.ok) return form;
    return { ok: true, value: this.session(form.value, this.gateway, options) };
  }

  /**
   * A session against a named version (FR-193).
   *
   * The form route serves the active version only, so a client naming an older one gets
   * the active definition with the version it asked for pinned on the intent. That would
   * render one version and finalize another, which is the first mistake section 25.1
   * names, so it is refused here rather than half-supported.
   */
  private async versioned(formVersion: number): Promise<Result<PublishedForm>> {
    const form = await this.getForm();
    if (!form.ok) return form;
    if (form.value.formVersion !== formVersion) {
      return {
        ok: false,
        error: {
          code: 'form_version_unknown',
          message: `Version ${formVersion} is not the active version; Inlet serves the active definition only. Create the session without formVersion.`,
        },
      };
    }
    return form;
  }

  /** Builds a controller over any gateway. The Electron renderer reuses this. */
  session(form: PublishedForm, gateway: FeedbackGateway, options: CreateSessionOptions = {}): FeedbackController {
    const merged = { ...(this.options.clientContext ?? {}), ...(options.clientContext ?? {}) };
    return new FeedbackController({
      form,
      gateway,
      debug: this.debug,
      now: this.now,
      ...options,
      ...(Object.keys(merged).length > 0 ? { clientContext: merged } : {}),
      ...(this.options.beforeSend ? { beforeSend: this.options.beforeSend } : {}),
    });
  }

  /** FR-201: sends what is queued; resolves when the queue is empty, paused or timed out. */
  flush(timeoutMs?: number): Promise<void> {
    return this.gateway.flush(timeoutMs);
  }

  async close(timeoutMs = 2_000): Promise<void> {
    await this.flush(timeoutMs);
    this.closed = true;
    this.gateway.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
