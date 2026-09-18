import { FileStore } from '../store-node.js';
import { FeedbackClient } from './client.js';
import { init as initCore } from './index.js';
import type { FeedbackInitOptions } from './types.js';

export * from './index.js';
export { FileStore } from '../store-node.js';

/**
 * The Node adapter (FR-207).
 *
 * `init` here is the core `init` with a disk queue when a `queueDir` is given, so a
 * submission that could not be delivered survives a restart. A screenshot may be a
 * `Buffer` — its media type is read from its first bytes — a `Blob`, or the explicit
 * `{ data, mediaType, filename }` form.
 *
 * This adapter is the server-to-server case: the integrator's own backend submits on
 * behalf of its application. The address Inlet observes and stores with the submission is
 * then the integrator's server, not the respondent's (FR-062C). If the respondent's
 * address matters, collect from the browser adapter or the hosted form instead.
 */

export type NodeFeedbackInitOptions = FeedbackInitOptions & {
  /** Where pending submissions live across restarts (FR-201). Memory when omitted. */
  queueDir?: string;
};

export function init(options: NodeFeedbackInitOptions): FeedbackClient {
  const { queueDir, ...rest } = options;
  return initCore({
    ...(queueDir ? { store: new FileStore(queueDir) } : {}),
    ...rest,
  });
}
