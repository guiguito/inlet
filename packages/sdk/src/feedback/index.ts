import { FeedbackClient } from './client.js';
import type { Uploader } from './gateway.js';
import type { CreateSessionOptions, FeedbackInitOptions, PublishedForm, Result } from './types.js';
import type { FeedbackController } from './controller.js';

/**
 * `inlet-sdk/feedback` (Feedback Collection PRD section 25): `init`, `getForm`,
 * `createSession`, `flush` and `close`, plus the controller and the answer types. The
 * adapters (`./node`, `./browser`, `./electron`) fill in persistence and, for Electron,
 * the process boundary; `./react` is one binding of the controller among others.
 *
 * The module ships no renderer, no styles and no components. What to draw is the
 * integrator's decision, and the controller tells them what to draw it from.
 *
 * The module-level functions act on the client created by the last `init`, exactly as the
 * crash module's do, so an application that uses both configures once and calls both the
 * same way.
 */

let current: FeedbackClient | null = null;

export function init(
  options: FeedbackInitOptions,
  /** Adapters inject an uploader that can report real progress; applications never do. */
  deps: { upload?: Uploader } = {},
): FeedbackClient {
  current = new FeedbackClient(options, deps);
  return current;
}

/** The active client, for adapters. Null before `init`. */
export function getClient(): FeedbackClient | null {
  return current;
}

function required(): FeedbackClient {
  if (!current) throw new Error('inlet-sdk/feedback: call init before using the module.');
  return current;
}

export function getForm(): Promise<Result<PublishedForm>> {
  return required().getForm();
}

export function refreshForm(): Promise<Result<PublishedForm>> {
  return required().refreshForm();
}

export function createSession(options?: CreateSessionOptions): Promise<Result<FeedbackController>> {
  return required().createSession(options);
}

export function flush(timeoutMs?: number): Promise<void> {
  return current ? current.flush(timeoutMs) : Promise.resolve();
}

export async function close(timeoutMs?: number): Promise<void> {
  if (!current) return;
  await current.close(timeoutMs);
  current = null;
}

export { FeedbackClient, SDK_NAME, SDK_VERSION } from './client.js';
export { FeedbackController } from './controller.js';
export { HttpGateway, fetchUploader } from './gateway.js';
export { MemoryStore } from '../store.js';
export type * from './types.js';
