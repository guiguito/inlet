import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportDefaultsTypeScript, type ConfigTemplate } from '@inlet/shared';
import { expect, it } from 'vitest';
import { configSnippets } from '../../../apps/web/src/lib/config-snippets.js';

/**
 * Remote Config PRD 8.1 Integrate: every snippet the Integrate tab shows compiles against the
 * built package's types, with the defaults file "Defaults for your code" gives (the export
 * route's `format=ts`, `exportDefaultsTypeScript`). A snippet naming an entry, option or method
 * the SDK lacks fails here. `electron` and `react-native` are not installed, so they are
 * declared minimally; the SDK's own types are the real ones, resolved through `exports`.
 */
const TEMPLATE = {
  parameters: [
    { key: 'new_checkout', type: 'boolean', default: false, conditional: [] },
    { key: 'max_upload_mb', type: 'number', default: 10, description: 'Largest upload, in megabytes.', conditional: [] },
    { key: 'headline', type: 'string', default: 'Welcome', conditional: [] },
    { key: 'paywall', type: 'json', default: { plans: ['monthly'], trial: null }, conditional: [] },
  ],
  conditions: [],
} as unknown as ConfigTemplate;

const AMBIENT = `
declare module 'electron' {
  export const app: { whenReady(): Promise<void>; getVersion(): string; getName(): string };
  export const contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  export const ipcRenderer: { send(channel: string, ...args: unknown[]): void; on(channel: string, listener: (event: unknown, ...args: any[]) => void): void };
}
declare module 'react-native' {
  export const Platform: { OS: 'ios' | 'android'; Version: number | string; constants: { Release?: string } };
  export const AppState: { addEventListener(type: 'change', listener: (state: string) => void): { remove(): void } };
}
declare module '@react-native-async-storage/async-storage' {
  const AsyncStorage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> };
  export default AsyncStorage;
}
declare function showNewCheckout(): void;
declare function createWindow(): void;
declare const request: { user: { id: string; plan: string } };
`;

it('compiles every Integrate snippet against the built inlet-sdk types', () => {
  const sdk = resolve(import.meta.dirname, '..');
  // `npm test` builds `@inlet/shared` but not this package; the declarations are the build's.
  if (!existsSync(join(sdk, 'dist/config/index.d.ts'))) execFileSync('node', ['build.mjs'], { cwd: sdk, stdio: 'pipe' });
  const dir = mkdtempSync(join(tmpdir(), 'inlet-config-snippets-'));
  try {
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(sdk, join(dir, 'node_modules/inlet-sdk'), 'dir');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(dir, 'ambient.d.ts'), AMBIENT);
    writeFileSync(join(dir, 'inlet-config-defaults.ts'), exportDefaultsTypeScript(TEMPLATE));
    const snippets = configSnippets({ baseUrl: 'https://inlet.example.com', publishableKey: 'ipk_placeholder', databaseId: 'cfg_placeholder' });
    expect(snippets.map((snippet) => snippet.runtime)).toEqual(['Browser', 'React Native', 'Electron main', 'Electron renderer', 'Node server', 'Node device', 'Any other runtime']);
    const files = snippets.map((snippet, index) => {
      const file = `snippet-${index}.ts`;
      // The snippets import './inlet-config-defaults' as an application's bundler resolves it.
      writeFileSync(join(dir, file), `${snippet.code.replace("from './inlet-config-defaults'", "from './inlet-config-defaults.js'")}\nexport {};\n`);
      return file;
    });
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'DOM'],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          preserveSymlinks: true,
        },
        files: ['ambient.d.ts', 'inlet-config-defaults.ts', ...files],
      }),
    );
    try {
      execFileSync('npx', ['tsc', '-p', dir], { cwd: sdk, stdio: 'pipe' });
    } catch (error) {
      const output = String((error as { stdout?: Buffer }).stdout ?? error);
      throw new Error(`A snippet does not compile against inlet-sdk:\n${output}\n${files.map((file, index) => `--- ${file}: ${snippets[index]!.runtime}`).join('\n')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
