/**
 * `npm test` with line coverage: the same three suites (the SDK, the API with its integration
 * tests, the MCP server), each measured over its own `src/`, then one figure for the whole
 * repository written as a shields.io endpoint document to `coverage/badge.json`, which CI
 * publishes on the `badges` branch for the README. Report only: no threshold fails the run.
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
const FLAGS = ['--coverage.enabled', '--coverage.provider=v8', '--coverage.include=src/**', '--coverage.reporter=json-summary', '--coverage.reporter=text-summary', '--coverage.reportsDirectory=coverage'];

const run = (args) => {
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(['run', 'build:deps']);
let covered = 0;
let total = 0;
for (const workspace of WORKSPACES) {
  run(['run', 'test', '-w', workspace.name, '--', ...FLAGS]);
  const { lines } = JSON.parse(readFileSync(path.join(root, workspace.dir, 'coverage/coverage-summary.json'), 'utf8')).total;
  console.log(`${workspace.name}: ${lines.pct}% of ${lines.total} lines`);
  covered += lines.covered;
  total += lines.total;
}

const pct = total === 0 ? 0 : (100 * covered) / total;
const color = pct >= 90 ? 'brightgreen' : pct >= 80 ? 'green' : pct >= 70 ? 'yellowgreen' : pct >= 60 ? 'yellow' : 'orange';
mkdirSync(path.join(root, 'coverage'), { recursive: true });
writeFileSync(path.join(root, 'coverage/badge.json'), `${JSON.stringify({ schemaVersion: 1, label: 'coverage', message: `${pct.toFixed(1)}%`, color })}\n`);
console.log(`All: ${pct.toFixed(1)}% of ${total} lines`);
