import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { arch, platform, release as osRelease } from 'node:os';
import { join } from 'node:path';
import { CrashClient } from './client.js';
import { getClient, init as initCore } from './index.js';
import type { CrashInitOptions, QueueStore } from './types.js';

export * from './index.js';

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

/** One JSON file per key under a directory; `setSync` is a synchronous write for the fatal path. */
export class FileStore implements QueueStore {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    return join(this.dir, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.path(key), 'utf8');
    } catch {
      return null;
    }
  }

  getSync(key: string): string | null {
    try {
      return readFileSync(this.path(key), 'utf8');
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Write beside, then rename-by-overwrite: a crash mid-write leaves the old file whole.
    await writeFile(`${this.path(key)}.tmp`, value, 'utf8');
    await writeFile(this.path(key), value, 'utf8');
  }

  setSync(key: string, value: string): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(key), value, 'utf8');
  }
}

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
