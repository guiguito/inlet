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
  crash: ['index', 'node', 'browser', 'electron', 'electron-renderer', 'react', 'react-native'],
  feedback: ['index', 'node', 'browser', 'electron', 'react', 'react-native'],
};
const platformOf = {
  index: 'neutral',
  node: 'node',
  browser: 'browser',
  electron: 'node',
  'electron-renderer': 'browser',
  react: 'neutral',
  'react-native': 'neutral',
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
reactNativeSafe();
metroShims();
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
  // CR-109, AN-240: the bare entries and the React Native ones too.
  const safe = [
    'dist/index',
    'dist/crash/index',
    'dist/feedback/index',
    'dist/crash/react-native',
    'dist/feedback/react-native',
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
 * AN-240, CR-120, FR-211: a React Native entry must touch no `window`, `document`,
 * `indexedDB` or `localStorage` when loaded, because on a device they do not exist and a
 * top-level read of one throws before the application renders anything. Each entry is
 * loaded here with those four globals defined as getters that throw, in a child process so
 * the trap cannot leak into the build.
 */
function reactNativeSafe() {
  const trap = ['window', 'document', 'indexedDB', 'localStorage']
    .map((name) => `Object.defineProperty(globalThis, ${JSON.stringify(name)}, { configurable: true, get() { throw new Error('touched ${name} at load'); } });`)
    .join('\n');
  for (const entry of ['dist/crash/react-native.js', 'dist/feedback/react-native.js', 'dist/crash/index.js', 'dist/feedback/index.js', 'dist/feedback/react.js']) {
    const url = new URL(entry, `file://${process.cwd()}/`).href;
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', `${trap}\nawait import(${JSON.stringify(url)});`], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`${entry} cannot load in React Native: ${String(error.stderr ?? error.message).trim().split('\n').find((line) => line.includes('touched')) ?? error.message}`);
    }
  }
}

/**
 * AN-239: Metro resolves a package's `exports` by default only from React Native 0.79, so
 * every entry a React Native application imports also gets a directory whose
 * `package.json` names the built file, which is how Metro's legacy resolution finds it.
 * Listed in `files`; the build writes them so they can never point at a file that moved.
 */
function metroShims() {
  for (const entry of ['crash', 'crash/react-native', 'feedback', 'feedback/react', 'feedback/react-native']) {
    const up = entry.split('/').map(() => '..').join('/');
    const target = entry.includes('/') ? entry : `${entry}/index`;
    mkdirSync(entry, { recursive: true });
    writeFileSync(
      join(entry, 'package.json'),
      // The ESM build: Metro 0.80's default source extensions do not include `cjs`.
      `${JSON.stringify({ main: `${up}/dist/${target}.js`, types: `${up}/dist/${target}.d.ts`, sideEffects: false }, null, 2)}\n`,
    );
  }
}

/**
 * The SDK stamps its version into every envelope's `sdk` block, from a constant rather than
 * from package.json, because the tests run against `src` where an esbuild define would be
 * undefined. So the two are checked against each other here instead.
 */
function versionsAgree() {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const file of ['src/crash/client.ts', 'src/feedback/client.ts']) {
    const declared = /export const SDK_VERSION = '([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1];
    if (declared !== version) {
      throw new Error(`SDK_VERSION in ${file} is '${declared}' but package.json says '${version}'. Bump both.`);
    }
  }
}

function* declarations(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* declarations(path);
    else if (entry.name.endsWith('.d.ts')) yield path;
  }
}
