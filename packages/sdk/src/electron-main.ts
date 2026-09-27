import { nodeContext, type EventContext } from './context.js';

/**
 * The Electron main process's context (UX Analytics AN-238, Remote Config RC-125, Crash
 * Reports CR-111): `macos`, `windows` or `linux` with the version `process.getSystemVersion()`
 * reports, which on macOS is the product's (15.1), not the kernel's `os.release()` (24.1.0);
 * runtime `electron` with its version; the locale from `Intl`.
 */
export function electronMainContext(debug: (message: string, detail?: unknown) => void): EventContext {
  const proc = process as NodeJS.Process & { getSystemVersion?: () => string; versions: { electron?: string } };
  let systemVersion: string | undefined;
  try {
    systemVersion = proc.getSystemVersion?.();
  } catch (error) {
    debug('The operating system version could not be read; it is left out.', error);
  }
  let locale: string | undefined;
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    locale = undefined;
  }
  const electronVersion = proc.versions.electron;
  return nodeContext({
    mode: 'device',
    runtime: electronVersion ? { name: 'electron', version: electronVersion } : { name: 'node', ...(proc.versions.node ? { version: proc.versions.node } : {}) },
    platform: proc.platform,
    ...(systemVersion ? { release: systemVersion } : {}),
    ...(locale ? { locale } : {}),
  });
}
