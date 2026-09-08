import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Token and password handling (section 12.1: secrets, invitation tokens and intent
 * tokens are never logged or stored in plaintext).
 */

/** URL-safe random token. 32 bytes gives 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256, hex encoded. Correct for high-entropy tokens: they need no key
 * stretching, and a fast hash keeps token lookup a single indexed query.
 * Passwords use Argon2id instead.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Argon2id with the library defaults, which follow current OWASP guidance. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Constant-time comparison for equal-length hex digests. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Canonical JSON: object keys sorted at every depth, no insignificant whitespace.
 *
 * This is what makes the retry contract of section 9.2 well defined. Two
 * finalizations count as "the same payload" when their canonical forms match, so key
 * order in the request body does not matter but a changed value does.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}

export function payloadHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
