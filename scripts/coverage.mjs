/**
 * `npm test` with line coverage: the same three suites (the SDK, the API with its integration
 * tests, the MCP server), each measured over its own `src/`, then one figure for the whole
 * repository written as a shields.io endpoint document to `coverage/badge.json`, which CI
 * publishes on the `badges` branch for the README. Report only: no threshold fails the run.
 * The suites' test counts go to `coverage/vitest-count.json`.
 *
 * `node scripts/coverage.mjs tests-badge`, after `npm run test:e2e` in CI, adds Playwright's
 * count from `coverage/e2e.json` and writes the tests badge, `coverage/tests.json`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACES = [
  { name: 'inlet-sdk', dir: 'packages/sdk' },
  { name: '@inlet/api', dir: 'apps/api' },
  { name: '@inlet/mcp', dir: 'apps/mcp' },
];
const FLAGS = ['--reporter=default', '--reporter=json', '--outputFile.json=coverage/tests.json', '--coverage.enabled', '--coverage.provider=v8', '--coverage.include=src/**', '--coverage.reporter=json-summary', '--coverage.reporter=text-summary', '--coverage.reportsDirectory=coverage'];

const run = (args) => {
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const badge = (name, message, color) => {
  mkdirSync(path.join(root, 'coverage'), { recursive: true });
  writeFileSync(path.join(root, 'coverage', name), `${JSON.stringify({ schemaVersion: 1, label: name === 'badge.json' ? 'coverage' : 'tests', message, color })}\n`);
};

if (process.argv[2] === 'tests-badge') {
  const { passed } = JSON.parse(readFileSync(path.join(root, 'coverage/vitest-count.json'), 'utf8'));
  const { stats } = JSON.parse(readFileSync(path.join(root, 'coverage/e2e.json'), 'utf8'));
  const e2e = stats.expected + stats.flaky;
  badge('tests.json', `${passed.toLocaleString('en')} unit and integration · ${e2e} end-to-end`, 'brightgreen');
  console.log(`Tests: ${passed} unit and integration, ${e2e} end-to-end`);
  process.exit(0);
}

run(['run', 'build:deps']);
let passed = 0;
let covered = 0;
let total = 0;
for (const workspace of WORKSPACES) {
  run(['run', 'test', '-w', workspace.name, '--', ...FLAGS]);
  const { lines } = JSON.parse(readFileSync(path.join(root, workspace.dir, 'coverage/coverage-summary.json'), 'utf8')).total;
  console.log(`${workspace.name}: ${lines.pct}% of ${lines.total} lines`);
  passed += JSON.parse(readFileSync(path.join(root, workspace.dir, 'coverage/tests.json'), 'utf8')).numPassedTests;
  covered += lines.covered;
  total += lines.total;
}

const pct = total === 0 ? 0 : (100 * covered) / total;
const color = pct >= 90 ? 'brightgreen' : pct >= 80 ? 'green' : pct >= 70 ? 'yellowgreen' : pct >= 60 ? 'yellow' : 'orange';
badge('badge.json', `${pct.toFixed(1)}%`, color);
writeFileSync(path.join(root, 'coverage/vitest-count.json'), `${JSON.stringify({ passed })}\n`);
console.log(`All: ${pct.toFixed(1)}% of ${total} lines; ${passed} tests passed`);
