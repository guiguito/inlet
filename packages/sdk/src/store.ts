/**
 * The persistent store behind both modules' queues (Foundations FD-012).
 *
 * One key-value store per application, so an integrator who uses `inlet-sdk/crash` and
 * `inlet-sdk/feedback` together configures persistence once and the two keep their own
 * keys inside it: `queue` and `dedupe` for crashes, `feedback-queue` for submissions.
 *
 * `setSync` is what a fatal crash handler calls before any network, so a crash that
 * takes the process down still leaves its report on disk. A store without it (IndexedDB)
 * persists asynchronously, which is the best a browser can do; the feedback module never
 * needs it, because nothing it queues happens while the process is dying.
 */
export type QueueStore = {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string): Promise<void> | void;
  /** Synchronous read and write, for the fatal path. Disk stores have them; IndexedDB cannot. */
  getSync?(key: string): string | null;
  setSync?(key: string, value: string): void;
};

/** The default store: memory only. Adapters replace it with disk or IndexedDB. */
export class MemoryStore implements QueueStore {
  private readonly values = new Map<string, string>();
  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  getSync(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.values.set(key, value);
  }
  setSync(key: string, value: string): void {
    this.values.set(key, value);
  }
}
