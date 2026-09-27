/**
 * The build's purity and load checks (Crash Reports CR-109, CR-120; UX Analytics AN-240;
 * Feedback Collection FR-211), apart from `build.mjs` so that `test/build-checks.test.ts`
 * can prove each one fails on an entry that breaks its rule.
 */
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * CR-109, AN-240: fails the build if an entry meant for a browser, an Electron renderer or
 * React Native picked up a Node import, directly or through something it imports.
 *
 * `node:*` is external, so esbuild passes such an import straight through to the output and
 * says nothing — the breakage surfaces in the integrator's bundler instead. This is the check
 * that item 4 of the 0.1.0 integration review assumed already existed; `standAlone()` in
 * `build.mjs` is about `.d.ts` self-containment and has never had anything to do with Node
 * imports.
 */
export function browserSafe(files) {
  // Matches an import or require of a node: module, not the string "node:" itself — the
  // in-app frame filter in browser.js and react.js legitimately tests for that prefix.
  const imports = /(?:from\s*|import\s*\(?\s*|require\(\s*)(['"])node:[^'"]*\1/;
  for (const file of files) {
    const match = imports.exec(readFileSync(file, 'utf8'));
    if (match) {
      throw new Error(
        `${file} imports ${match[0]}. That entry must run in a browser, an Electron renderer or React Native, so it cannot reach Node — find what pulled it in (usually ./node.js or ../store-node.js) and move the shared part into a module that does not.`,
      );
    }
  }
}

/**
 * AN-240, CR-120, FR-211: a React Native entry must touch no `window`, `document`,
 * `indexedDB` or `localStorage` when loaded, because on a device they do not exist and a
 * top-level read of one throws before the application renders anything. Each entry is
 * loaded here with those four globals defined as getters that throw, in a child process so
 * the trap cannot leak into the build.
 */
export function reactNativeSafe(files) {
  const trap = ['window', 'document', 'indexedDB', 'localStorage']
    .map((name) => `Object.defineProperty(globalThis, ${JSON.stringify(name)}, { configurable: true, get() { throw new Error('touched ${name} at load'); } });`)
    .join('\n');
  for (const entry of files) {
    const url = pathToFileURL(resolve(entry)).href;
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', `${trap}\nawait import(${JSON.stringify(url)});`], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`${entry} cannot load in React Native: ${String(error.stderr ?? error.message).trim().split('\n').find((line) => /Error: touched \w+ at load/.test(line)) ?? error.message}`);
    }
  }
}

/**
 * AN-240, RC-123: a browser entry stays under its limit, and the README states its size.
 * Measured as an integrator's bundler ships it — minified — and gzipped, because gzip is what
 * CDNs, bundle analysers and size budgets report, and brotli, a few kilobytes smaller, would
 * make the limit easier to meet than what most pages actually serve. Returns the bytes.
 */
export async function browserSize(entry, limitKb) {
  const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, write: false, logLevel: 'warning' });
  const bytes = gzipSync(result.outputFiles[0].contents, { level: 9 }).length;
  const name = entry.replace(/^src\//, 'inlet-sdk/').replace(/\.ts$/, '');
  console.log(`${name}: ${(bytes / 1024).toFixed(1)} KB minified and gzipped (limit ${limitKb} KB).`);
  if (bytes > limitKb * 1024) {
    throw new Error(`${name} is ${(bytes / 1024).toFixed(1)} KB minified and gzipped, past the ${limitKb} KB its requirement allows. Find what grew it.`);
  }
  return bytes;
}
