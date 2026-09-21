/**
 * Builds the SDK: ESM and CommonJS per entry point, then the type declarations
 * (Foundations FD-013).
 *
 * `@inlet/shared/crash-core` and `@inlet/shared/feedback-core` are bundled in, which is
 * how the package ships with zero runtime dependencies while computing the exact
 * fingerprint the server groups by and running the exact answer rules the server
 * validates with. `electron` and `react` are the integrator's; they stay external and
 * optional.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { build } from 'esbuild';

// The Electron renderer half is a crash-only entry: it has to be bundlable by Vite for a
// renderer, which the `electron` entry never was (CR-109).
const entriesOf = {
  crash: ['index', 'node', 'browser', 'electron', 'electron-renderer', 'react'],
  feedback: ['index', 'node', 'browser', 'electron', 'react'],
};
const platformOf = {
  index: 'neutral',
  node: 'node',
  browser: 'browser',
  electron: 'node',
  'electron-renderer': 'browser',
  react: 'neutral',
};

for (const [module, entries] of Object.entries(entriesOf)) {
  for (const entry of entries) {
    for (const format of ['esm', 'cjs']) {
      await build({
        entryPoints: [`src/${module}/${entry}.ts`],
        outfile: `dist/${module}/${entry}.${format === 'esm' ? 'js' : 'cjs'}`,
        bundle: true,
        format,
        platform: platformOf[entry],
        target: ['es2022', 'node18'],
        mainFields: ['module', 'main'],
        external: ['electron', 'react', 'node:*'],
        sourcemap: true,
        logLevel: 'warning',
      });
    }
  }
}

// CR-112: the root entry, so `import 'inlet-sdk'` resolves. Namespaced, because both modules
// export `init`, `flush` and `close`.
for (const format of ['esm', 'cjs']) {
  await build({
    entryPoints: ['src/index.ts'],
    outfile: `dist/index.${format === 'esm' ? 'js' : 'cjs'}`,
    bundle: true,
    format,
    platform: 'neutral',
    target: ['es2022', 'node18'],
    mainFields: ['module', 'main'],
    external: ['electron', 'react', 'node:*'],
    sourcemap: true,
    logLevel: 'warning',
  });
}

execFileSync('npx', ['tsc', '-p', 'tsconfig.json', '--emitDeclarationOnly'], { stdio: 'inherit' });
standAlone();
browserSafe();
versionsAgree();

/**
 * Makes the emitted declarations stand alone.
 *
 * The bundler inlines `@inlet/shared`, but `tsc` cannot: a public type that names one of
 * its declarations emits an import of `@inlet/shared/feedback-core`, a private workspace
 * package that is not in the tarball, and every integrator's `tsc` would then fail on a
 * module it cannot resolve. So the declarations it needs are copied in beside the code and
 * the specifiers rewritten to point at the copies.
 *
 * The check at the end is the part that matters: reach for a new subpath of `@inlet/shared`
 * in a public type and the build stops here rather than shipping a broken tarball.
 */
function standAlone() {
  // `feedback-core` re-exports these two, so their declarations travel with it.
  const shared = ['feedback-core', 'errors', 'limits'];
  mkdirSync('dist/shared', { recursive: true });
  for (const name of shared) copyFileSync(`../shared/dist/${name}.d.ts`, `dist/shared/${name}.d.ts`);

  for (const file of declarations('dist')) {
    const to = relative(dirname(file), 'dist/shared').split('\\').join('/');
    const rewritten = readFileSync(file, 'utf8').replace(
      /(['"])@inlet\/shared\/([a-z-]+)\1/g,
      (match, quote, name) =>
        shared.includes(name) ? `${quote}${to}/${name}.js${quote}` : match,
    );
    writeFileSync(file, rewritten);
    const leftover = /from ['"]@inlet\/shared[^'"]*['"]/.exec(rewritten);
    if (leftover) {
      throw new Error(
        `${file} still imports ${leftover[0]}. Copy that module into dist/shared in build.mjs, or keep it out of the public types.`,
      );
    }
  }
}

/**
 * CR-109: fails the build if an entry meant for a browser or an Electron renderer picked up a
 * Node import, directly or through something it imports.
 *
 * `node:*` is external, so esbuild passes such an import straight through to the output and
 * says nothing — the breakage surfaces in the integrator's bundler instead. This is the check
 * that item 4 of the 0.1.0 integration review assumed already existed; `standAlone()` above is
 * about `.d.ts` self-containment and has never had anything to do with Node imports.
 */
function browserSafe() {
  const safe = [
    'dist/index',
    'dist/crash/browser',
    'dist/crash/react',
    'dist/crash/electron-renderer',
    'dist/feedback/browser',
    'dist/feedback/react',
  ];
  // Matches an import or require of a node: module, not the string "node:" itself — the
  // in-app frame filter in browser.js and react.js legitimately tests for that prefix.
  const imports = /(?:from\s*|import\s*\(?\s*|require\(\s*)(['"])node:[^'"]*\1/;
  for (const base of safe) {
    for (const file of [`${base}.js`, `${base}.cjs`]) {
      const match = imports.exec(readFileSync(file, 'utf8'));
      if (match) {
        throw new Error(
          `${file} imports ${match[0]}. That entry must run in a browser or an Electron renderer, so it cannot reach Node — find what pulled it in (usually ./node.js or ../store-node.js) and move the shared part into a module that does not.`,
        );
      }
    }
  }
}

/**
 * The SDK stamps its version into every envelope's `sdk` block, from a constant rather than
 * from package.json, because the tests run against `src` where an esbuild define would be
 * undefined. So the two are checked against each other here instead.
 */
function versionsAgree() {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const source = readFileSync('src/crash/client.ts', 'utf8');
  const declared = /export const SDK_VERSION = '([^']+)'/.exec(source)?.[1];
  if (declared !== version) {
    throw new Error(`SDK_VERSION in src/crash/client.ts is '${declared}' but package.json says '${version}'. Bump both.`);
  }
}

function* declarations(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* declarations(path);
    else if (entry.name.endsWith('.d.ts')) yield path;
  }
}
