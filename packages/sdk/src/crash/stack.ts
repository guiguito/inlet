import type { CrashFrame } from './types.js';

/**
 * Stack parsing and in-app marking (CR-092, CR-093, CR-095).
 *
 * Two formats cover every JavaScript runtime Inlet targets: V8 (Node, Chromium,
 * Electron) writes `    at fn (file:line:col)`; Firefox and Safari write
 * `fn@file:line:col`. Anything else is kept as a function name with no file, which is
 * still a frame the server can group on.
 *
 * A frame is in-app when its file sits under one of the application roots. Every other
 * frame keeps its function name and loses its file to `<external>`, so a report never
 * carries the path of a library on the user's disk (CR-095). In-app files are made
 * relative to their root for the same reason: `/Users/alice/app/dist/x.js` says where
 * Alice keeps her code; `dist/x.js` does not.
 */

const V8_FRAME = /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?(?:(.+?)(?::(\d+))?(?::(\d+))?)\)?\s*$/;
const GECKO_FRAME = /^\s*(?:(.*?)@)?(.+?)(?::(\d+))?(?::(\d+))?\s*$/;

export function parseStack(stack: string | undefined): Omit<CrashFrame, 'inApp'>[] {
  if (!stack) return [];
  const frames: Omit<CrashFrame, 'inApp'>[] = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trimEnd();
    const isV8 = /^\s*at\s/.test(line);
    // The first line of a V8 stack is `Type: message`, and Gecko stacks have none. A line
    // that is neither `at …` nor `fn@file` is not a frame.
    if (!isV8 && !line.includes('@')) continue;
    const match = isV8 ? V8_FRAME.exec(line) : GECKO_FRAME.exec(line);
    if (!match) continue;
    const [, fn, file, ln, col] = match;
    const location = cleanFile(file);
    frames.push({
      ...(fn ? { function: fn.trim() } : {}),
      ...(location ? { file: location } : {}),
      ...(ln ? { line: Number(ln) } : {}),
      ...(col ? { col: Number(col) } : {}),
    });
  }
  return frames;
}

/** Strips `file://` and Chromium's `(anonymous)`-style noise; keeps `<anonymous>` out of the file slot. */
function cleanFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const trimmed = file.trim();
  if (trimmed === '<anonymous>' || trimmed === 'native' || trimmed === '[native code]') return undefined;
  return trimmed.replace(/^file:\/\//, '');
}

/**
 * CR-093: marks frames under an application root as in-app with a root-relative file,
 * and every other frame as `<external>` with its function name kept.
 */
export function markFrames(frames: Omit<CrashFrame, 'inApp'>[], appRoots: string[]): CrashFrame[] {
  const roots = appRoots.map(normalizeRoot).filter((root) => root.length > 0);
  return frames.map((frame) => {
    const file = frame.file;
    if (!file) return { ...frame, inApp: false };
    const normalized = file.replace(/\\/g, '/');
    if (/(^|\/)node_modules\//.test(normalized) || normalized.startsWith('node:') || /^internal\//.test(normalized)) {
      return { ...frame, file: '<external>', inApp: false };
    }
    for (const root of roots) {
      if (normalized === root || normalized.startsWith(`${root}/`)) {
        return { ...frame, file: normalized.slice(root.length).replace(/^\//, '') || normalized, inApp: true };
      }
      // A URL root such as https://app.example.com matches URL files under it.
      if (root.includes('://') && normalized.startsWith(root)) {
        return { ...frame, file: normalized.slice(root.length).replace(/^\//, '') || normalized, inApp: true };
      }
    }
    return { ...frame, file: '<external>', inApp: false };
  });
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * CR-115: the application's own code, as a browser or an Electron renderer sees it.
 *
 * Under `file:` — which is every packaged Electron app — `location.origin` is the string
 * `"file://"`, which `normalizeRoot` in stack.ts reduces to `"file:"`, which matches nothing.
 * Meanwhile `cleanFile` strips `file://` off every frame, so the frames are plain paths. The
 * two ends disagreed and every frame in a packaged renderer came out `<external>` — unreadable
 * in production, and only in production, because a dev renderer is served over http.
 *
 * It lives here, beside `normalizeRoot` and `cleanFile`, because the 0.1.3 defect was those
 * two disagreeing with a root derived in another file: `cleanFile` strips `file://` off every
 * frame while `normalizeRoot` reduced the origin `"file://"` to `"file:"`, which matches
 * nothing. Both ends of that mismatch are now in one module, and there is one derivation for
 * every caller rather than a default per entry point.
 *
 * Both the raw and the decoded directory are returned: V8 reports file URLs percent-encoded
 * while `pathname` may hand back either, and `markFrames` takes the first root that matches,
 * so a second entry costs nothing. The leading slash stays — on Windows a frame reads
 * `/C:/app/x.js` once `file://` is gone, and so does `pathname`.
 */
export function defaultAppRoots(): string[] {
  // Total by construction. This runs inside `componentDidCatch` (react.ts) and while a client
  // is being built to report a crash, so it must not be able to throw: a reporter that fails
  // there turns a handled error into an unhandled one. `typeof location` alone is not enough —
  // a test environment that tears down globals leaves it null, which is defined and not an
  // object with a protocol.
  const here = typeof location === 'undefined' ? null : (location as Location | null);
  if (!here || typeof here.pathname !== 'string' || typeof here.protocol !== 'string') return [];
  if (here.protocol !== 'file:') return typeof here.origin === 'string' && here.origin ? [here.origin] : [];
  const dir = here.pathname.replace(/\/[^/]*$/, '');
  if (!dir) return [];
  let decoded = dir;
  try {
    decoded = decodeURIComponent(dir);
  } catch {
    // A malformed escape: the raw form is still the better root.
  }
  return decoded === dir ? [dir] : [dir, decoded];
}
