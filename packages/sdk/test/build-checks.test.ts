import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browserSafe, browserSize, reactNativeSafe } from '../build-checks.mjs';

/**
 * AN-240, CR-109: the build's purity and load checks fire. `build.mjs` runs them on every
 * browser, Electron renderer, React Native and bare entry; here each is run on an entry that
 * breaks its rule, so a check that silently stopped matching would fail this test.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(name: string, code: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'inlet-checks-'));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, code);
  return file;
}

describe('the purity check (AN-240, CR-109)', () => {
  it('fails on a direct or bundled Node import, in ESM and CommonJS, and passes a clean entry', () => {
    expect(() => browserSafe([entry('esm.js', "import { join } from 'node:path';\nexport const x = join('a', 'b');\n")])).toThrow(/imports from 'node:path'/);
    expect(() => browserSafe([entry('cjs.cjs', "const fs = require(\"node:fs\");\nmodule.exports = fs;\n")])).toThrow(/imports require\("node:fs"/);
    expect(() => browserSafe([entry('dynamic.js', "export const load = () => import('node:os');\n")])).toThrow(/node:os/);
    // The string itself is not an import: the in-app frame filter tests for that prefix.
    expect(() => browserSafe([entry('clean.js', "export const internal = (file) => file.startsWith('node:');\n")])).not.toThrow();
  });
});

describe('the React Native load check (AN-240)', () => {
  for (const global of ['window', 'document', 'indexedDB', 'localStorage']) {
    it(`fails on an entry that touches ${global} when loaded`, () => {
      expect(() => reactNativeSafe([entry(`${global}.mjs`, `export const value = typeof ${global} === 'undefined' ? null : ${global};\n`)])).toThrow(new RegExp(`touched ${global} at load`));
    });
  }

  it('passes an entry that reads them only when called', () => {
    expect(() => reactNativeSafe([entry('lazy.mjs', "export const later = () => globalThis.window;\n")])).not.toThrow();
  });
});

describe('the size check (AN-240, RC-123)', () => {
  it('keeps inlet-sdk/config/browser under 8 KB minified and gzipped', async () => {
    const bytes = await browserSize('src/config/browser.ts', 8);
    expect(bytes).toBeLessThanOrEqual(8 * 1024);
  });

  it('fails on an entry past its limit', async () => {
    const big = entry('big.js', `export const noise = ${JSON.stringify(Array.from({ length: 4000 }, (_, index) => Math.sin(index).toString(36)))};\n`);
    await expect(browserSize(big, 1)).rejects.toThrow(/past the 1 KB/);
  });
});
