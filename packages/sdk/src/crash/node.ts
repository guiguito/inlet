import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
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

  /**
   * Writes are serialized per store and land by rename.
   *
   * Both halves are load-bearing, and the Electron suite proved it by corrupting a queue
   * file. `writeFile` truncates on open, so two concurrent writes of different lengths
   * interleave: both truncate, the longer one writes its bytes, the shorter one overwrites
   * only the first few, and what is left on disk is the short value followed by the tail of
   * the long one — not valid JSON, and a queue that then fails to parse is a queue of crash
   * reports silently thrown away. The queue is written from several places at once
   * (`enqueue`, and again after every answered batch), so this was reachable in normal use.
   *
   * Renaming rather than writing in place also means a reader, or a process that dies
   * mid-write, sees the whole previous file rather than a half-written one.
   */
  private writes: Promise<unknown> = Promise.resolve();

  set(key: string, value: string): Promise<void> {
    const next = this.writes.then(
      () => this.write(key, value),
      () => this.write(key, value),
    );
    this.writes = next;
    return next;
  }

  private async write(key: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.path(key);
    const staged = `${target}.${process.pid}.tmp`;
    await writeFile(staged, value, 'utf8');
    await rename(staged, target);
  }

  /**
   * The fatal path, so it cannot await the queue above: a report being written while the
   * process dies is worth more than perfect ordering against an in-flight async write. It
   * still lands by rename, so it can never leave a half-written file behind.
   */
  setSync(key: string, value: string): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const target = this.path(key);
    const staged = `${target}.${process.pid}.sync.tmp`;
    writeFileSync(staged, value, 'utf8');
    renameSync(staged, target);
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
