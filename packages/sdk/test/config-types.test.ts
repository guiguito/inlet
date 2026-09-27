import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

/**
 * RC-111: `get` is typed by the widened `defaults`. The assertions are in
 * `config-types.check.ts`, which `tsc` compiles here: the package's `typecheck` covers `src` only.
 */
it('types get from the widened defaults, and rejects a wrong type or a key without a default', () => {
  const root = resolve(import.meta.dirname, '..');
  const dir = mkdtempSync(join(tmpdir(), 'inlet-config-types-'));
  try {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: join(root, 'tsconfig.json'),
        compilerOptions: { noEmit: true, rootDir: root, typeRoots: [join(root, '../../node_modules/@types')] },
        include: [join(root, 'test/config-types.check.ts')],
      }),
    );
    expect(() => execFileSync('npx', ['tsc', '-p', dir], { cwd: root, stdio: 'pipe' })).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
