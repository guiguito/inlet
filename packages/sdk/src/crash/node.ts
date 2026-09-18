import { createHash } from 'node:crypto';
import { arch, platform, release as osRelease } from 'node:os';
import { CrashClient } from './client.js';
import { getClient, init as initCore } from './index.js';
import { FileStore } from '../store-node.js';
import type { CrashInitOptions } from './types.js';

export * from './index.js';
export { FileStore } from '../store-node.js';

/**
 * The Node adapter (CR-097, CR-100).
 *
 * `init` here is the core `init` with Node defaults filled in: the OS and runtime, the
 * current working directory as the application root, a synchronous SHA-256 for the fatal
 * path, and a disk queue when a `queueDir` is given. `installNodeHandlers` observes
 * `uncaughtException` and `unhandledRejection`, persists the report synchronously, tries
 * to send for two seconds, and then lets the process die the way Node would have.
 */

export type NodeInitOptions = CrashInitOptions & {
  /** Where the queue and dedupe state live across restarts (CR-097). Memory when omitted. */
  queueDir?: string;
};

export function sha256Hex(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function init(options: NodeInitOptions): CrashClient {
  const { queueDir, ...rest } = options;
  return initCore({
    platform: 'node',
    os: { name: osName(), version: osRelease(), arch: arch() },
    runtime: { name: 'node', version: process.versions.node },
    appRoots: [process.cwd()],
    hash: sha256Hex,
    ...(queueDir ? { store: new FileStore(queueDir) } : {}),
    ...rest,
  });
}

export type NodeHandlerOptions = {
  /** After an uncaught exception, exit with this code once the report is sent or two seconds pass. Default 1; `false` keeps the process alive. */
  exitCode?: number | false;
  /** Milliseconds to wait for the send before exiting. Default 2000. */
  flushTimeoutMs?: number;
};

/** CR-100: observes `uncaughtException` and `unhandledRejection`. Returns an uninstaller. */
export function installNodeHandlers(options: NodeHandlerOptions = {}): () => void {
  const exitCode = options.exitCode ?? 1;
  const flushTimeoutMs = options.flushTimeoutMs ?? 2_000;

  const onException = (error: unknown) => {
    const client = getClient();
    if (!client) return;
    client.captureFatal(error, { kind: 'exception', handled: false });
    void client.flush(flushTimeoutMs).finally(() => {
      if (exitCode !== false) process.exit(exitCode);
    });
  };
  const onRejection = (reason: unknown) => {
    const client = getClient();
    if (!client) return;
    client.captureFatal(reason, { kind: 'unhandled-rejection', handled: false });
    void client.flush(flushTimeoutMs);
  };

  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
}

function osName(): string {
  const name = platform();
  return name === 'darwin' ? 'macOS' : name === 'win32' ? 'Windows' : name === 'linux' ? 'Linux' : name;
}
