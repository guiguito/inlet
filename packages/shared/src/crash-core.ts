/**
 * The crash envelope (Crash Reports PRD section 9.1) and the grouping rule
 * (CR-020 to CR-022).
 *
 * This file is the contract shared by the API and `@inlet/sdk/crash` (PRD section
 * 11, Security): the server validates with `crashEnvelopeSchema`, the SDK enforces the
 * same bounds before queueing (CR-096), and both compute the same default fingerprint,
 * so client dedupe (CR-099) and server grouping (CR-024) agree on what "the same
 * crash" means. Change a bound here and both sides move together.
 *
 * Everything here is pure and runs in Node and in the browser.
 */

export const CRASH_LIMITS = {
  /** CR-011: the serialized envelope, UTF-8. */
  envelopeMaxBytes: 64 * 1024,
  /** Section 9.1: `context`, serialized. Stored verbatim, the integrator's responsibility. */
  contextMaxBytes: 16 * 1024,
  /** Section 9.1: exception message. Truncated, never rejected. */
  messageMaxLength: 200,
  framesMax: 30,
  tagsMax: 20,
  fingerprintPartsMax: 8,
  fingerprintPartMaxLength: 128,
  /** CR-010: items per batch request. */
  batchMax: 50,
  /** CR-020: in-app frames that participate in the default fingerprint. */
  fingerprintFrames: 5,
  /** CR-101: opaque user ID. */
  userIdMaxLength: 128,
  /** CR-002: report retention bounds. */
  retentionCapDefault: 10_000,
  retentionCapMin: 1_000,
  retentionCapMax: 100_000,
  retentionMaxAgeDaysDefault: 90,
  retentionMaxAgeDaysMin: 7,
  retentionMaxAgeDaysMax: 365,
  /** CR-017: clock tolerance before the received time replaces the client time. */
  clockPastToleranceMs: 30 * 24 * 60 * 60 * 1000,
  clockFutureToleranceMs: 5 * 60 * 1000,
} as const;

/** Section 4: the failure classes the SDK adapters emit. Integrators may add their own. */
export const BUILTIN_CRASH_KINDS = [
  'exception',
  'unhandled-rejection',
  'renderer-gone',
  'render-error',
  'native',
  'child-exit',
  'unclean-exit',
  'message',
] as const;

export const CRASH_PLATFORMS = ['node', 'browser', 'electron', 'other'] as const;

/** CR-012: which conditional block each built-in kind demands. Custom kinds demand none. */
export const KIND_REQUIRES: Record<(typeof BUILTIN_CRASH_KINDS)[number], 'exception' | 'native' | 'exit'> = {
  exception: 'exception',
  'unhandled-rejection': 'exception',
  'render-error': 'exception',
  message: 'exception',
  native: 'native',
  'renderer-gone': 'exit',
  'child-exit': 'exit',
  'unclean-exit': 'exit',
};

/** The literal a client fingerprint may contain to splice in the computed one (CR-022). */
export const FINGERPRINT_DEFAULT_TOKEN = '{{ default }}';


/** The envelope shape the pure functions read. Structurally identical to the schema's output. */
export type CrashFrameLike = { function?: string; file?: string; line?: number; col?: number; inApp: boolean };
export type CrashEnvelopeLike = {
  kind: string;
  exception?: { type: string; message: string; handled: boolean; frames: CrashFrameLike[] };
  native?: { process: string; fault: string; module: string; dumpBytes?: number };
  exit?: { code?: number; signal?: string; reason?: string; name?: string; lastUptimeMs?: number };
  fingerprint?: string[];
};

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Truncation by code unit, the way the server and the SDK both bound text. */
export function truncateCrashText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * CR-021. Order matters: URLs before paths and hex, emails before hex, timestamps
 * before integers, UUIDs before hex. Each placeholder is a distinct token so that
 * "user <id> not found" and "user <email> not found" stay different bugs.
 */
const NORMALIZERS: Array<[RegExp, string]> = [
  [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '<str>'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '<url>'],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>'],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<ts>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
  // Paths: an absolute POSIX path, a Windows drive path, or a file:-less relative path with a slash and an extension.
  [/(?:[A-Za-z]:\\|\\\\)[^\s"'<>|]+|(?:^|(?<=\s|[(=:]))\/[^\s"'<>|]+/g, '<path>'],
  [/\b(?:0x)?[0-9a-f]{8,}\b/gi, '<hex>'],
  [/(?<![\w<])-?\d+(?:\.\d+)?(?![\w>])/g, '<n>'],
];

/** CR-021: the message as it participates in the fingerprint. The stored message is untouched. */
export function normalizeCrashMessage(message: string): string {
  let out = message;
  for (const [pattern, placeholder] of NORMALIZERS) out = out.replace(pattern, placeholder);
  return out.replace(/\s+/g, ' ').trim();
}

/** The basename of a frame's file, without line or column (CR-020). */
function frameFileBasename(file: string | undefined): string {
  if (!file) return '';
  const trimmed = file.replace(/[?#].*$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * CR-020: the parts that identify a crash, before hashing. Exposed so tests and the
 * SDK's debug hook can show why two reports grouped together.
 */
export function defaultFingerprintParts(envelope: CrashEnvelopeLike): string[] {
  const parts: string[] = [`kind:${envelope.kind}`];
  if (envelope.exception) {
    parts.push(`type:${envelope.exception.type}`);
    parts.push(`msg:${normalizeCrashMessage(envelope.exception.message)}`);
    const frames = envelope.exception.frames.filter((frame) => frame.inApp).slice(0, CRASH_LIMITS.fingerprintFrames);
    for (const frame of frames) parts.push(`frame:${frame.function ?? '?'}@${frameFileBasename(frame.file)}`);
  } else if (envelope.native) {
    parts.push(`fault:${envelope.native.fault}`, `module:${envelope.native.module}`);
  } else if (envelope.exit) {
    // An exit has no stack; the reason, signal and name are what distinguish one from another.
    parts.push(`exit:${envelope.exit.reason ?? ''}|${envelope.exit.signal ?? ''}|${envelope.exit.name ?? ''}`);
  }
  return parts;
}

/**
 * CR-022: the parts that actually get hashed, after applying a client fingerprint if
 * one was sent. `{{ default }}` is replaced by the computed parts in place.
 */
export function effectiveFingerprintParts(envelope: CrashEnvelopeLike): string[] {
  if (!envelope.fingerprint) return defaultFingerprintParts(envelope);
  return envelope.fingerprint.flatMap((part) =>
    part.trim() === FINGERPRINT_DEFAULT_TOKEN ? defaultFingerprintParts(envelope) : [`client:${part}`],
  );
}

/**
 * The fingerprint: SHA-256 over the length-prefixed parts, hex. Length-prefixing means
 * `["a", "bc"]` and `["ab", "c"]` never collide. Async because WebCrypto is async and
 * the SDK runs in browsers; the server has `node:crypto` but the same result.
 */
export async function computeFingerprint(parts: string[]): Promise<string> {
  const encoded = new TextEncoder().encode(parts.map((part) => `${part.length}:${part}`).join('\n'));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The current grouping rule's version (CR-023). Bump when `defaultFingerprintParts` or
 * `normalizeCrashMessage` changes; databases record the version they group with and a
 * bump never regroups an existing database.
 */
export const CRASH_GROUPING_VERSION = 1;

/** CR-051: the title fields the server extracts once at ingest for lists and Slack. */
export function crashGroupTitle(envelope: CrashEnvelopeLike): {
  exceptionType: string | null;
  topFrame: string | null;
  module: string | null;
} {
  if (envelope.exception) {
    const top = envelope.exception.frames.find((frame) => frame.inApp) ?? envelope.exception.frames[0];
    const topFrame = top ? `${top.function ?? '?'}${top.file ? ` (${frameFileBasename(top.file)})` : ''}` : null;
    return { exceptionType: envelope.exception.type, topFrame, module: null };
  }
  if (envelope.native) return { exceptionType: envelope.native.fault, topFrame: null, module: envelope.native.module };
  if (envelope.exit) {
    return { exceptionType: envelope.exit.reason ?? envelope.exit.signal ?? null, topFrame: null, module: envelope.exit.name ?? null };
  }
  return { exceptionType: null, topFrame: null, module: null };
}
