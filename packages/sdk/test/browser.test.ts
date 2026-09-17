import { describe, expect, it } from 'vitest';
import { osFromUserAgent, runtimeFromUserAgent } from '../src/crash/browser.js';

/**
 * The browser adapter's pure helpers. They decide what `os` and `runtime` a crash report
 * carries, which is what a developer filters by when a bug turns out to be one platform's
 * (CR-040). Everything else in the adapter needs a real browser and lives in
 * `e2e/api/sdk-browser.spec.ts`.
 *
 * Real user-agent strings, not invented ones: the point is that these survive contact with
 * what browsers actually send.
 */
const AGENTS = {
  chromeOnWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  chromeOnMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edgeOnWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70',
  firefoxOnLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  safariOnMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  safariOnIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  chromeOnAndroid:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  nonsense: 'Something nobody has ever shipped',
} as const;

describe('osFromUserAgent', () => {
  it('names the system and its version', () => {
    expect(osFromUserAgent(AGENTS.chromeOnWindows)).toEqual({ name: 'Windows', version: '10.0' });
    // The underscores Apple uses become the dots everyone reads.
    expect(osFromUserAgent(AGENTS.chromeOnMac)).toEqual({ name: 'macOS', version: '10.15.7' });
    expect(osFromUserAgent(AGENTS.safariOnIphone)).toEqual({ name: 'iOS', version: '18.1' });
    expect(osFromUserAgent(AGENTS.chromeOnAndroid)).toEqual({ name: 'Android', version: '15' });
  });

  it('reads Android before Linux, since every Android agent also says Linux', () => {
    expect(osFromUserAgent(AGENTS.chromeOnAndroid).name).toBe('Android');
    expect(osFromUserAgent(AGENTS.firefoxOnLinux)).toEqual({ name: 'Linux' });
  });

  it('falls back to other rather than guessing', () => {
    expect(osFromUserAgent(AGENTS.nonsense)).toEqual({ name: 'other' });
    expect(osFromUserAgent('')).toEqual({ name: 'other' });
  });
});

describe('runtimeFromUserAgent', () => {
  it('names the browser and its version', () => {
    expect(runtimeFromUserAgent(AGENTS.chromeOnWindows)).toEqual({ name: 'Chrome', version: '131.0.0.0' });
    expect(runtimeFromUserAgent(AGENTS.firefoxOnLinux)).toEqual({ name: 'Firefox', version: '133.0' });
    expect(runtimeFromUserAgent(AGENTS.safariOnMac)).toEqual({ name: 'Safari', version: '18.1' });
  });

  it('tells Edge from the Chrome it also claims to be', () => {
    // Edge ships "Chrome/131… Edg/131…"; reading Chrome first would hide every Edge crash.
    expect(runtimeFromUserAgent(AGENTS.edgeOnWindows)).toEqual({ name: 'Edge', version: '131.0.2903.70' });
  });

  it('tells Chrome from the Safari it also claims to be', () => {
    // Chrome ships "Chrome/131… Safari/537.36" but no "Version/", which is what separates them.
    expect(runtimeFromUserAgent(AGENTS.chromeOnMac).name).toBe('Chrome');
    expect(runtimeFromUserAgent(AGENTS.safariOnIphone)).toEqual({ name: 'Safari', version: '18.1' });
  });

  it('falls back to browser rather than guessing', () => {
    expect(runtimeFromUserAgent(AGENTS.nonsense)).toEqual({ name: 'browser' });
  });
});
