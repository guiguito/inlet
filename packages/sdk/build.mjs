/**
 * Bundles the SDK with esbuild: ESM and CommonJS per entry point (Foundations FD-013).
 *
 * `@inlet/shared/crash-core` is bundled in, which is how the package ships with zero
 * runtime dependencies while computing the exact fingerprint the server groups by.
 * `electron` and `react` are the integrator's; they stay external and optional.
 */
import { build } from 'esbuild';

const entries = ['index', 'node', 'browser', 'electron', 'react'];
const platformOf = { index: 'neutral', node: 'node', browser: 'browser', electron: 'node', react: 'neutral' };

for (const entry of entries) {
  for (const format of ['esm', 'cjs']) {
    await build({
      entryPoints: [`src/crash/${entry}.ts`],
      outfile: `dist/crash/${entry}.${format === 'esm' ? 'js' : 'cjs'}`,
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
