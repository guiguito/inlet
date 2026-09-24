/**
 * Text and identifier helpers shared by the API and `inlet-sdk` (Crash Reports CR-011,
 * Feedback Collection FR-062B, Foundations FD-016).
 *
 * Pure and dependency-free, so the SDK bundles it into every entry, React Native
 * included, where neither `crypto.subtle` nor `crypto.getRandomValues` can be assumed.
 */

/**
 * CR-011, FR-062B: PostgreSQL refuses U+0000 and lone surrogates in `jsonb` and `text`,
 * so a report or an answer carrying either would fail its insert for its characters.
 * Lone surrogates become U+FFFD; U+0000 is removed.
 */
export function sanitizeText(value: string): string {
  // Fast path: the overwhelming majority of strings have neither.
  if (!/[\u0000\uD800-\uDFFF]/.test(value)) return value;
  return value.replace(/\u0000/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/** Every string in a JSON value, object keys included, through `sanitizeText`. */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === 'string') return sanitizeText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[sanitizeText(key)] = sanitizeDeep(item);
    return out as T;
  }
  return value;
}

/**
 * Truncation by UTF-16 code unit, which is how every bound in the envelopes is counted,
 * that never splits a surrogate pair (CR-011): a cut that would leave a lone high
 * surrogate gives up that one unit instead.
 */
export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * UX Analytics §9.1: UUIDs are accepted in any letter case, with or without dashes, and
 * stored, returned and searched as lowercase dashed text. Null when it is not a UUID.
 */
export function normalizeUuid(value: string): string | null {
  if (!UUID.test(value)) return null;
  const hex = value.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- Random IDs (FD-016, UX Analytics AN-239) ---------------------------------------

/** Fills a buffer with random bytes. The SDK's React Native entries accept one. */
export type RandomSource = (bytes: Uint8Array) => void;

let counter = 0;

/**
 * The last-resort generator for a runtime with neither an injected source nor
 * `crypto.getRandomValues`: the time, a counter and `Math.random`, mixed through
 * SHA-256, so that IDs used as primary keys do not collide even when two are made in the
 * same millisecond. Not a cryptographic source, and never used where one exists.
 */
function fallbackRandom(bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    counter = (counter + 1) >>> 0;
    const seed = `${Date.now()}:${counter}:${Math.random()}:${Math.random()}:${Math.random()}`;
    const digest = sha256(new TextEncoder().encode(seed));
    const take = Math.min(digest.length, bytes.length - offset);
    bytes.set(digest.subarray(0, take), offset);
    offset += take;
  }
}

/** The injected source, else `crypto.getRandomValues`, else the fallback above. */
export function randomBytes(length: number, source?: RandomSource): Uint8Array {
  const bytes = new Uint8Array(length);
  if (source) source(bytes);
  else if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else fallbackRandom(bytes);
  return bytes;
}

function dashed(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A random UUID v4, lowercase and dashed. */
export function uuidV4(source?: RandomSource): string {
  const bytes = randomBytes(16, source);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return dashed(bytes);
}

/** A time-ordered UUID v7 (RFC 9562), lowercase and dashed. The session ID of FD-016. */
export function uuidV7(now: number = Date.now(), source?: RandomSource): string {
  const bytes = randomBytes(16, source);
  let ms = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return dashed(bytes);
}

// --- SHA-256 (FIPS 180-4) -------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * A synchronous SHA-256, for runtimes without `crypto.subtle` (React Native) and for the
 * fatal path, which cannot await. The fingerprint must be byte-identical to the
 * server's, which computes it with WebCrypto; a unit test pins the two together.
 */
export function sha256(input: Uint8Array): Uint8Array {
  const length = input.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(input);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(block + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const a = w[t - 15]!;
      const b = w[t - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number];
    for (let t = 0; t < 64; t += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t]! + w[t]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let index = 0; index < 8; index += 1) outView.setUint32(index * 4, h[index]!);
  return out;
}

export function sha256Hex(input: Uint8Array): string {
  return Array.from(sha256(input), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
