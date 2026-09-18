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

const entries = ['index', 'node', 'browser', 'electron', 'react'];
const platformOf = { index: 'neutral', node: 'node', browser: 'browser', electron: 'node', react: 'neutral' };

for (const module of ['crash', 'feedback']) {
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

execFileSync('npx', ['tsc', '-p', 'tsconfig.json', '--emitDeclarationOnly'], { stdio: 'inherit' });
standAlone();

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

function* declarations(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* declarations(path);
    else if (entry.name.endsWith('.d.ts')) yield path;
  }
}
