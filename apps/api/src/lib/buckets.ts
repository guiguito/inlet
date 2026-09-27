/**
 * Sliding-window counters kept in fixed buckets (UX Analytics AN-020, Foundations FD-030,
 * FD-031): per key, `buckets` counts of `bucketMs` each, so reading or adding costs one pass
 * over the buckets whatever the volume counted. A window of `n` buckets covers the current,
 * partial bucket and the `n - 1` before it, so it spans between `n - 1` and `n` bucket
 * lengths: a limit of 1,000 events in five minutes of one-minute buckets admits 1,000 in any
 * period of four to five minutes.
 *
 * ponytail: at most `maxKeys` keys. When a new key would exceed that, keys idle for the
 * whole window are forgotten first (a scan, at most once per bucket), then the least
 * recently counted one, which may lose a live key's count: a client inventing keys can make
 * another key's limit forget part of what it counted, never make memory grow. In memory on
 * one instance (FD-031); a shared store is the documented upgrade.
 */
export class BucketedCounters {
  private readonly entries = new Map<string, { stamps: number[]; counts: number[] }>();
  private lastSweep = -1;

  constructor(
    readonly bucketMs: number,
    readonly buckets: number,
    readonly maxKeys: number,
  ) {}

  /** What `key` counted over the last `windowBuckets` buckets (all of them by default). */
  total(key: string, now: number, windowBuckets = this.buckets): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    const current = Math.floor(now / this.bucketMs);
    let sum = 0;
    for (let i = 0; i < this.buckets; i += 1) {
      if (entry.stamps[i]! > current - windowBuckets) sum += entry.counts[i]!;
    }
    return sum;
  }

  /**
   * Milliseconds until `key` could count `amount` more within `limit` over `windowBuckets`,
   * or 0 when it can now. An amount above the limit can never fit and answers the window.
   */
  waitMs(key: string, amount: number, limit: number, now: number, windowBuckets = this.buckets): number {
    const current = Math.floor(now / this.bucketMs);
    const entry = this.entries.get(key);
    if (!entry) return amount <= limit ? 0 : windowBuckets * this.bucketMs;
    const live: [number, number][] = [];
    for (let i = 0; i < this.buckets; i += 1) {
      if (entry.stamps[i]! > current - windowBuckets) live.push([entry.stamps[i]!, entry.counts[i]!]);
    }
    live.sort((a, b) => a[0] - b[0]);
    let total = live.reduce((sum, [, count]) => sum + count, 0);
    if (total + amount <= limit) return 0;
    if (amount > limit) return windowBuckets * this.bucketMs;
    // The oldest bucket leaves the window when the bucket `windowBuckets` after it begins.
    for (const [stamp, count] of live) {
      total -= count;
      if (total + amount <= limit) return Math.max(1, (stamp + windowBuckets) * this.bucketMs - now);
    }
    return windowBuckets * this.bucketMs;
  }

  add(key: string, amount: number, now: number): void {
    const current = Math.floor(now / this.bucketMs);
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
    } else {
      if (this.entries.size >= this.maxKeys) this.makeRoom(current);
      entry = { stamps: new Array<number>(this.buckets).fill(-Infinity), counts: new Array<number>(this.buckets).fill(0) };
    }
    this.entries.set(key, entry);
    const slot = current % this.buckets;
    if (entry.stamps[slot] !== current) {
      entry.stamps[slot] = current;
      entry.counts[slot] = 0;
    }
    entry.counts[slot] = (entry.counts[slot] ?? 0) + amount;
  }

  clear(): void {
    this.entries.clear();
    this.lastSweep = -1;
  }

  get size(): number {
    return this.entries.size;
  }

  private makeRoom(current: number): void {
    if (this.lastSweep !== current) {
      this.lastSweep = current;
      for (const [key, entry] of this.entries) {
        if (Math.max(...entry.stamps) <= current - this.buckets) this.entries.delete(key);
      }
    }
    if (this.entries.size >= this.maxKeys) this.entries.delete(this.entries.keys().next().value as string);
  }
}
