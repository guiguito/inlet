import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QueueStore } from './store.js';

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
