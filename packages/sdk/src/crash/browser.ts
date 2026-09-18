import { CrashClient } from './client.js';
import { getClient, init as initCore } from './index.js';
import { IndexedDbStore } from '../store-browser.js';
import type { CrashInitOptions } from './types.js';

export * from './index.js';
export { IndexedDbStore } from '../store-browser.js';

/**
 * The browser adapter (CR-097, CR-100).
 *
 * Defaults: platform `browser`, the page's origin as the application root (so frames from
 * a CDN or an extension are `<external>`), an IndexedDB store, and the OS and browser
 * read from the user agent in the coarsest way that still distinguishes systems. Nothing
 * from `window.location`, `document` or `navigator` beyond that goes into a report
 * (CR-095).
 */

export function init(options: CrashInitOptions): CrashClient {
  const hasIndexedDb = typeof indexedDB !== 'undefined';
  return initCore({
    platform: 'browser',
    ...(typeof navigator !== 'undefined' ? { os: osFromUserAgent(navigator.userAgent), runtime: runtimeFromUserAgent(navigator.userAgent) } : {}),
    ...(typeof location !== 'undefined' ? { appRoots: [location.origin] } : {}),
    ...(hasIndexedDb ? { store: new IndexedDbStore() } : {}),
    ...options,
  });
}

/** CR-100: observes `error` and `unhandledrejection` on `window`. Returns an uninstaller. */
export function installBrowserHandlers(): () => void {
  const onError = (event: ErrorEvent) => {
    void getClient()?.captureException(event.error ?? event.message, { kind: 'exception', handled: false });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    void getClient()?.captureException(event.reason, { kind: 'unhandled-rejection', handled: false });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

export function osFromUserAgent(ua: string): { name: string; version?: string } {
  const windows = /Windows NT ([\d.]+)/.exec(ua);
  if (windows) return { name: 'Windows', version: windows[1] };
  const mac = /Mac OS X ([\d_]+)/.exec(ua);
  if (mac) return { name: 'macOS', version: mac[1]!.replace(/_/g, '.') };
  const ios = /(?:iPhone|iPad).*OS ([\d_]+)/.exec(ua);
  if (ios) return { name: 'iOS', version: ios[1]!.replace(/_/g, '.') };
  const android = /Android ([\d.]+)/.exec(ua);
  if (android) return { name: 'Android', version: android[1] };
  if (/Linux/.test(ua)) return { name: 'Linux' };
  return { name: 'other' };
}

export function runtimeFromUserAgent(ua: string): { name: string; version?: string } {
  const edge = /Edg\/([\d.]+)/.exec(ua);
  if (edge) return { name: 'Edge', version: edge[1] };
  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  if (chrome) return { name: 'Chrome', version: chrome[1] };
  const firefox = /Firefox\/([\d.]+)/.exec(ua);
  if (firefox) return { name: 'Firefox', version: firefox[1] };
  const safari = /Version\/([\d.]+).*Safari/.exec(ua);
  if (safari) return { name: 'Safari', version: safari[1] };
  return { name: 'browser' };
}
