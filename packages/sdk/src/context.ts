/**
 * The context an event says about where it ran (UX Analytics AN-236, AN-237, section 9.1),
 * derived the same way for every module that needs it. Remote Config's fetch context
 * (RC-118) reuses this module, which is why it is not under `analytics/`.
 *
 * Neutral on purpose: no Node import and no read of a global at load. Each adapter gathers
 * its inputs — the user-agent string and `navigator.language` in a browser, `process` and
 * `os` in Node — and passes them in, so the browser and React Native bundles stay pure
 * (AN-240) and every derivation is a plain function a test can call.
 */

export type EventContext = {
  platform: 'web' | 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'server' | 'other';
  os?: { name: string; version?: string };
  runtime?: { name: string; version?: string };
  locale?: string;
};

/**
 * The values browsers now freeze in the user-agent string, which say nothing about the
 * device: Safari and Chrome report macOS 10.15.7 whatever the version, Chrome reports Windows
 * NT 10.0 for Windows 10 and 11, and Chrome on Android reports Android 10 (AN-236).
 */
const FROZEN_OS_VERSIONS: Record<string, string> = { macOS: '10.15.7', Windows: '10.0', Android: '10' };

/**
 * AN-236: platform `web`, the operating system and the browser with their major versions,
 * from the user-agent string, and the language. The string itself is never sent, and no
 * high-entropy client hint is asked for.
 */
export function browserContext(userAgent: string, language: string | undefined): EventContext {
  const os = osOf(userAgent);
  const runtime = browserOf(userAgent);
  const locale = language ? normalizeLocale(language) : undefined;
  return { platform: 'web', os, ...(runtime ? { runtime } : {}), ...(locale ? { locale } : {}) };
}

function osOf(ua: string): { name: string; version?: string } {
  const found = (name: string, full: string | undefined) => {
    const dotted = full?.replace(/_/g, '.');
    if (!dotted || FROZEN_OS_VERSIONS[name] === dotted) return { name };
    return { name, version: dotted.split('.')[0]! };
  };
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+(?:_\d+)*)/.exec(ua);
  if (ios) return found('iOS', ios[1]);
  const windows = /Windows NT (\d+(?:\.\d+)*)/.exec(ua);
  if (windows) return found('Windows', windows[1]);
  const android = /Android (\d+(?:\.\d+)*)/.exec(ua);
  if (android) return found('Android', android[1]);
  if (/CrOS/.test(ua)) return { name: 'ChromeOS' };
  const mac = /Mac OS X (\d+(?:[_.]\d+)*)/.exec(ua);
  if (mac) return found('macOS', mac[1]);
  if (/Linux/.test(ua)) return { name: 'Linux' };
  return { name: 'other' };
}

function browserOf(ua: string): { name: string; version: string } | undefined {
  const rules: [string, RegExp][] = [
    ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
    ['Opera', /OPR\/(\d+)/],
    ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Safari', /Version\/(\d+).*Safari/],
  ];
  for (const [name, pattern] of rules) {
    const match = pattern.exec(ua);
    if (match) return { name, version: match[1]! };
  }
  return undefined;
}

/** Loaded in an Electron renderer, the browser entry is the wrong one (AN-236). */
export function isElectronRenderer(userAgent: string): boolean {
  return /\bElectron\//.test(userAgent);
}

/**
 * The server's `validateEvent` refuses a locale that is not BCP 47, so `en_US` would reject
 * the whole event: underscores become hyphens, the language is lower case, a four-letter
 * script title case and a two-letter region upper case. What still does not look like a
 * language tag is left out rather than sent to be refused.
 */
export function normalizeLocale(value: string): string | undefined {
  // POSIX locales carry an encoding or a modifier (`en_US.UTF-8`, `de_DE@euro`).
  const cleaned = value.trim().replace(/[.@].*$/, '').replace(/_/g, '-').split('-').filter((part) => part.length > 0);
  if (cleaned.length === 0 || !/^[A-Za-z]{2,8}$/.test(cleaned[0]!)) return undefined;
  const tag = cleaned
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (/^[A-Za-z]{4}$/.test(part)) return part[0]!.toUpperCase() + part.slice(1).toLowerCase();
      if (/^[A-Za-z]{2}$/.test(part)) return part.toUpperCase();
      return part;
    })
    .join('-');
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag) && tag.length <= 35 ? tag : undefined;
}

export type ServerRuntime = { name: 'node' | 'bun' | 'deno'; version?: string };

/**
 * AN-237: which JavaScript runtime this is, from globals Bun and Deno define and Node does
 * not. The Node entry passes `globalThis` and `process.versions`.
 */
export function serverRuntime(global: { Bun?: { version?: string }; Deno?: { version?: { deno?: string } } }, versions: Record<string, string | undefined> | undefined): ServerRuntime {
  if (global.Bun) return { name: 'bun', ...(global.Bun.version ? { version: global.Bun.version } : {}) };
  if (global.Deno) return { name: 'deno', ...(global.Deno.version?.deno ? { version: global.Deno.version.deno } : {}) };
  return { name: 'node', ...(versions?.node ? { version: versions.node } : {}) };
}

/**
 * AN-237, the Node entry. Server mode: platform `server` and the runtime. Device mode (a
 * command-line tool, a desktop application without Electron): platform `macos`, `windows`
 * or `linux` with the version the system reports — on macOS the kernel's, unless the
 * integrator names the operating system — and the locale from `Intl`.
 */
export function nodeContext(input: {
  mode: 'server' | 'device';
  runtime: ServerRuntime;
  /** `process.platform`. */
  platform?: string;
  /** `os.release()`, or undefined where a permission refused it. */
  release?: string;
  os?: { name: string; version?: string };
  locale?: string;
}): EventContext {
  const runtime = { name: input.runtime.name, ...(input.runtime.version ? { version: input.runtime.version } : {}) };
  if (input.mode === 'server') return { platform: 'server', runtime };
  const platform = input.platform === 'darwin' ? 'macos' : input.platform === 'win32' ? 'windows' : input.platform === 'linux' ? 'linux' : 'other';
  const name = platform === 'macos' ? 'macOS' : platform === 'windows' ? 'Windows' : platform === 'linux' ? 'Linux' : (input.platform ?? 'other');
  const os = input.os ?? { name, ...(input.release ? { version: input.release } : {}) };
  const locale = input.locale ? normalizeLocale(input.locale) : undefined;
  return { platform, os, runtime, ...(locale ? { locale } : {}) };
}
