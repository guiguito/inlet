/**
 * A bounded map that forgets the entry used least recently once it holds `capacity`
 * entries. A `Map` keeps insertion order, so re-inserting on every read makes its first key
 * the least recently used one.
 */
export class Lru<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as K);
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  /** Removes every entry whose key passes `test`. A scan: for invalidations, which are rare. */
  deleteWhere(test: (key: K, value: V) => boolean): void {
    for (const [key, value] of this.entries) if (test(key, value)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
