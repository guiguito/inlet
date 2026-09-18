import { join } from 'node:path';
import { FileStore } from '../store-node.js';
import { FeedbackClient } from './client.js';
import { FeedbackController } from './controller.js';
import type {
  CreateSessionOptions,
  FeedbackGateway,
  FeedbackInitOptions,
  FinalizePayload,
  PublishedForm,
  Result,
  ScreenshotSource,
  SubmissionIntent,
  SubmitOutcome,
  UploadedAttachment,
} from './types.js';

export * from './index.js';
export { FileStore } from '../store-node.js';

/**
 * The Electron adapter (FR-208). Two halves, one channel.
 *
 * The key, the queue and the transport live in the main process. `installElectronMain`
 * owns the client and answers on a named IPC channel; `createElectronRenderer` returns a
 * controller whose five network steps are requests over that channel, screenshot bytes
 * travelling as an `ArrayBuffer`. A renderer holds no key and makes no HTTP request.
 *
 * The intent token never reaches a renderer either, although FR-208 does not demand it.
 * Main hands back the intent with the token removed and keeps the real one in a map, so
 * the one credential a renderer could otherwise use to upload to Inlet by itself stays in
 * the process that is allowed to have credentials.
 *
 * The documented path is a preload bridge with context isolation on, as for the crash
 * module. `electron` is imported lazily and typed minimally, so this module loads outside
 * Electron — in tests, or in a shared bundle — without the dependency.
 */

export const IPC_CHANNEL = 'inlet:feedback';

/**
 * How main tells a renderer that a queued finalization was finally answered (FR-201).
 *
 * `ipcMain.handle` is request and response, and a submission the network lost is answered
 * minutes later or on the next start, so there is no response left to put it in. A
 * renderer that does not subscribe to this simply stays in `submitting`, which is honest:
 * main is still trying.
 */
export const IPC_SETTLED_CHANNEL = 'inlet:feedback:settled';

type ElectronApp = { getPath(name: 'userData'): string };
type ElectronIpcMain = {
  handle(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => unknown): unknown;
  removeHandler(channel: string): unknown;
};
type IpcMainEvent = { sender?: { send(channel: string, payload: unknown): void } };
export type ElectronModule = { app: ElectronApp; ipcMain: ElectronIpcMain };

async function electron(): Promise<ElectronModule> {
  // A string variable keeps bundlers from trying to resolve the module for the browser.
  const name = 'electron';
  return (await import(name)) as ElectronModule;
}

/** What travels over the channel. One request per network step, and nothing else. */
export type FeedbackRequest =
  | { op: 'getForm' }
  | { op: 'createIntent'; formVersion: number }
  | { op: 'upload'; intentId: string; questionId: string; file: { data: ArrayBuffer; mediaType: string; filename?: string } }
  | { op: 'release'; intentId: string; attachmentId: string }
  | { op: 'finalize'; intentId: string; payload: FinalizePayload };

export type ElectronMainOptions = FeedbackInitOptions & {
  /** Defaults to `<userData>/inlet-feedback`. */
  queueDir?: string;
};

/**
 * Initializes the client with Electron defaults and answers the renderer channel.
 * Async because Electron is imported lazily; `await` it during `app.whenReady()`.
 */
export async function installElectronMain(
  options: ElectronMainOptions,
  /** Tests pass a fake `electron`; applications leave it out. */
  deps: { electron?: ElectronModule } = {},
): Promise<{ client: FeedbackClient; uninstall: () => void }> {
  const { app, ipcMain } = deps.electron ?? (await electron());
  const client = new FeedbackClient({
    ...options,
    store: options.store ?? new FileStore(options.queueDir ?? join(app.getPath('userData'), 'inlet-feedback')),
  });

  /** The tokens the renderer is not given. Cleared when the client closes. */
  const tokens = new Map<string, SubmissionIntent>();
  const known = (intentId: string): SubmissionIntent => {
    const intent = tokens.get(intentId);
    if (!intent) throw new Error(`inlet-sdk/feedback: no submission intent ${intentId} in this process.`);
    return intent;
  };

  const handle = async (event: IpcMainEvent, request: unknown): Promise<unknown> => {
    const message = request as FeedbackRequest;
    switch (message?.op) {
      case 'getForm':
        return client.getForm();
      case 'createIntent': {
        const created = await client.gateway.createIntent(message.formVersion);
        if (!created.ok) return created;
        tokens.set(created.value.intentId, created.value);
        // FR-208: the renderer gets everything it needs to drive the session and nothing
        // it could use to reach Inlet on its own.
        return { ok: true, value: { ...created.value, token: '' } };
      }
      case 'upload':
        return client.gateway.upload(known(message.intentId), message.questionId, {
          data: message.file.data,
          mediaType: message.file.mediaType,
          ...(message.file.filename ? { filename: message.file.filename } : {}),
        });
      case 'release':
        await client.gateway.release(known(message.intentId), message.attachmentId);
        return { ok: true, value: undefined };
      case 'finalize':
        return client.gateway.finalize(known(message.intentId), message.payload, (outcome) => {
          event.sender?.send(IPC_SETTLED_CHANNEL, { intentId: message.intentId, outcome });
        });
      default:
        throw new Error('inlet-sdk/feedback: unknown request on the Electron channel.');
    }
  };

  ipcMain.handle(IPC_CHANNEL, handle);

  return {
    client,
    uninstall: () => {
      ipcMain.removeHandler(IPC_CHANNEL);
      tokens.clear();
    },
  };
}

export type ElectronRendererOptions = {
  /**
   * How to reach main. Defaults to `window.inletFeedback.invoke`, which the preload
   * script exposes; see the README.
   */
  invoke?: (channel: string, request: FeedbackRequest) => Promise<unknown>;
  /**
   * How to hear main's late answers, from the same preload bridge. Defaults to
   * `window.inletFeedback.on`. Without it a submission the network lost leaves the
   * session in `submitting` until the window is reopened.
   */
  on?: (channel: string, listener: (payload: unknown) => void) => void;
  debug?: (message: string, detail?: unknown) => void;
  now?: () => number;
};

/** What a renderer gets: the form, and sessions over the channel. No key, no queue. */
export type ElectronRenderer = {
  getForm(): Promise<Result<PublishedForm>>;
  createSession(options?: CreateSessionOptions): Promise<Result<FeedbackController>>;
};

export function createElectronRenderer(options: ElectronRendererOptions = {}): ElectronRenderer {
  const invoke = options.invoke ?? defaultInvoke();
  const debug = options.debug ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const settled = new Map<string, (outcome: SubmitOutcome) => void>();
  const subscribe = options.on ?? defaultOn();
  subscribe?.(IPC_SETTLED_CHANNEL, (payload) => {
    const message = payload as { intentId?: string; outcome?: SubmitOutcome };
    if (!message?.intentId || !message.outcome) return;
    settled.get(message.intentId)?.(message.outcome);
    settled.delete(message.intentId);
  });
  const gateway = ipcGateway(invoke, settled);

  return {
    getForm: () => gateway.getForm(),
    async createSession(sessionOptions: CreateSessionOptions = {}) {
      const form = await gateway.getForm();
      if (!form.ok) return form;
      return {
        ok: true,
        value: new FeedbackController({ form: form.value, gateway, debug, now, ...sessionOptions }),
      };
    },
  };
}

/** Every network step as one request over the channel (FR-208). */
export function ipcGateway(
  invoke: (channel: string, request: FeedbackRequest) => Promise<unknown>,
  /** Where to record who wants main's late answer for an intent. */
  settled = new Map<string, (outcome: SubmitOutcome) => void>(),
): FeedbackGateway {
  const send = <T>(request: FeedbackRequest) => invoke(IPC_CHANNEL, request) as Promise<T>;
  return {
    getForm: () => send<Result<PublishedForm>>({ op: 'getForm' }),
    createIntent: (formVersion) => send<Result<SubmissionIntent>>({ op: 'createIntent', formVersion }),
    async upload(intent, questionId, file, onProgress) {
      onProgress?.(0);
      // Structured clone cannot carry a Blob's stream, so the bytes cross as an
      // ArrayBuffer and the media type travels beside them.
      const { data, mediaType, filename } = await toTransferable(file);
      const result = await send<Result<UploadedAttachment>>({
        op: 'upload',
        intentId: intent.intentId,
        questionId,
        file: { data, mediaType, ...(filename ? { filename } : {}) },
      });
      onProgress?.(1);
      return result;
    },
    async release(intent, attachmentId) {
      await send<unknown>({ op: 'release', intentId: intent.intentId, attachmentId });
    },
    finalize: (intent, payload, onSettled) => {
      if (onSettled) settled.set(intent.intentId, onSettled);
      return send<SubmitOutcome>({ op: 'finalize', intentId: intent.intentId, payload });
    },
  };
}

async function toTransferable(file: ScreenshotSource): Promise<{ data: ArrayBuffer; mediaType: string; filename?: string }> {
  if (file instanceof Blob) {
    const named = file as Blob & { name?: string };
    return { data: await file.arrayBuffer(), mediaType: file.type, ...(named.name ? { filename: named.name } : {}) };
  }
  // A copy, not `.buffer`: a Node `Buffer` is a view into a shared pool and its backing
  // ArrayBuffer holds unrelated bytes either side of these ones.
  if (file instanceof Uint8Array) return { data: copyOf(file), mediaType: '' };
  const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
  return {
    data: copyOf(bytes),
    mediaType: file.mediaType,
    ...(file.filename ? { filename: file.filename } : {}),
  };
}

function copyOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function defaultOn(): ((channel: string, listener: (payload: unknown) => void) => void) | undefined {
  return (globalThis as { inletFeedback?: { on?: (channel: string, listener: (payload: unknown) => void) => void } })
    .inletFeedback?.on;
}

function defaultInvoke(): (channel: string, request: FeedbackRequest) => Promise<unknown> {
  const bridge = (globalThis as { inletFeedback?: { invoke?: (channel: string, request: unknown) => Promise<unknown> } }).inletFeedback;
  if (bridge?.invoke) return (channel, request) => bridge.invoke!(channel, request);
  return () =>
    Promise.reject(
      new Error(
        'inlet-sdk/feedback: no bridge to the main process. Expose one from the preload script as window.inletFeedback.invoke, or pass `invoke`.',
      ),
    );
}
