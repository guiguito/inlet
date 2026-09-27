import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

/**
 * The test suites' global setup imports `scripts/local-services.mjs`, and with it
 * `embedded-postgres`, whose exit hook calls `process.exit(0)` from `beforeExit`. A runner that
 * reports failures by setting `process.exitCode` then exited 0: `vitest run` with a failing test
 * passed `npm test` and CI (found in Release 9's acceptance audit, piece 11a).
 */
it('keeps the exit code a process set after importing the local services', () => {
  const services = pathToFileURL(resolve(import.meta.dirname, '../../../../scripts/local-services.mjs')).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(services)}); process.exitCode = 3;`], { encoding: 'utf8' });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(3);
});
