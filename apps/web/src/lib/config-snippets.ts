/**
 * The Integrate tab's snippets (Remote Config PRD 8.1 Integrate), one per runtime, written
 * against `inlet-sdk/config` as `packages/sdk/README.md` "# Remote config" documents it: every
 * entry, option and call below must exist under that name there.
 *
 * Where a runtime stores an installation ID (RC-119), the snippet starts with
 * `installationId: false` and turns it on with `setInstallationIdEnabled(true)` in the
 * application's consent callback. Node server mode sends none unless a context carries one, and
 * an Electron renderer holds no identity (main does), so neither needs it.
 */

/** RC-119: said beside the snippets, as the SDK documentation says it. */
export const CONFIG_CONSENT_NOTE =
  'Unless you pass installationId: false, the module stores a random installation ID on the device and sends it with every fetch, so that percentage rollouts and splits stay stable. You decide whether it needs consent where your users are; these snippets start without it and turn it on in your consent callback. Without it, a percentage rule or split bucketed by installation is false.';

export type ConfigSnippet = { runtime: string; code: string; note?: string };

/** Where the "Defaults for your code" file is saved in the snippets. */
const DEFAULTS_IMPORT = "import { configDefaults } from './inlet-config-defaults'; // \"Defaults for your code\"";

export function configSnippets(options: { baseUrl: string; publishableKey: string; databaseId: string }): ConfigSnippet[] {
  const config = (lines: string[], indent = '  ') =>
    [`baseUrl: '${options.baseUrl}',`, `publishableKey: '${options.publishableKey}',`, `databaseId: '${options.databaseId}',`, ...lines].map((line) => `${indent}${line}`).join('\n');

  return [
    {
      runtime: 'Browser',
      code: `import * as config from 'inlet-sdk/config/browser';
${DEFAULTS_IMPORT}

const client = config.init({
${config(["app: { version: '1.4.2' },", 'defaults: configDefaults,', 'installationId: false, // nothing is stored for identity, none is sent, until consent'])}
});
await client.ready({ timeoutMs: 1500 }); // the first fetch's values, or false after 1.5 s
if (client.get('new_checkout')) showNewCheckout();

// In your consent callback, once the person agrees:
client.setInstallationIdEnabled(true); // creates the ID if needed, stores it and fetches`,
    },
    {
      runtime: 'React Native',
      note: 'Give the analytics, crash and feedback modules the same store, so that they share one installation ID.',
      code: `import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import * as config from 'inlet-sdk/config/react-native';
${DEFAULTS_IMPORT}

// React Native 0.74 or later. The modules are passed in; the entry imports nothing.
const client = config.init({
${config(["app: { version: '1.4.2' },", 'defaults: configDefaults,', 'Platform,', 'AppState,', 'store: AsyncStorage,', 'installationId: false,'])}
});

// In your consent callback:
client.setInstallationIdEnabled(true);`,
    },
    {
      runtime: 'Electron main',
      note: 'The main process owns the one client: the installation ID, the answers and the transport, under <userData>/inlet. The app version and ID default to the application’s own.',
      code: `// main.ts
import { app } from 'electron';
import { installElectronMain } from 'inlet-sdk/config/electron';
${DEFAULTS_IMPORT}

app.whenReady().then(async () => {
  const config = await installElectronMain({
${config(['defaults: configDefaults,', 'installationId: false,'], '    ')}
  });
  createWindow();

  // In your consent callback:
  config.setInstallationIdEnabled(true);
});`,
    },
    {
      runtime: 'Electron renderer',
      note: 'A renderer holds no key and makes no request: it reads what main pushes, so give it the same defaults as main. The preload script is required; keep context isolation on and expose only the two config channels.',
      code: `// preload.ts, with contextIsolation on
import { contextBridge, ipcRenderer } from 'electron';

// Only the config module's two channels: the page must not reach your other IPC handlers.
contextBridge.exposeInMainWorld('inletConfig', {
  send: (channel: string, message: unknown) => {
    if (channel === 'inlet:config') ipcRenderer.send(channel, message);
  },
  on: (channel: string, listener: (payload: unknown) => void) => {
    if (channel === 'inlet:config:state') ipcRenderer.on(channel, (_event, payload) => listener(payload));
  },
});

// renderer.ts
import { createElectronRenderer } from 'inlet-sdk/config/electron-renderer';
${DEFAULTS_IMPORT}

const config = createElectronRenderer({ defaults: configDefaults });
if (config.get('new_checkout')) showNewCheckout();`,
    },
    {
      runtime: 'Node server',
      note: 'Server mode, the default: every distinct context costs a fetch, cached per context for the refresh interval. No installation ID is sent unless the context carries one.',
      code: `import * as config from 'inlet-sdk/config/node';
${DEFAULTS_IMPORT}

const client = config.init({
${config(["app: { version: '2.3.0' },", 'defaults: configDefaults,'])}
});

const values = await client.evaluate({ userId: request.user.id, attributes: { plan: request.user.plan } });
const limit = values.getNumber('max_upload_mb', 10);`,
    },
    {
      runtime: 'Node device',
      note: 'For a command-line tool or a desktop application without Electron: it behaves as the browser entry does, a process start being the launch. Give the other modules the same directory.',
      code: `import * as config from 'inlet-sdk/config/node';
${DEFAULTS_IMPORT}

const client = config.init({
${config(["app: { version: '1.4.2' },", 'defaults: configDefaults,', "mode: 'device',", "persistenceDir: '/path/to/app-data/inlet',", 'installationId: false,'])}
});
await client.ready({ timeoutMs: 1500 });

// In your consent flow:
client.setInstallationIdEnabled(true);`,
    },
    {
      runtime: 'Any other runtime',
      note: 'The core entry, for a runtime with fetch: it keeps the answers and the installation ID in memory for the process, or in the store you give it.',
      code: `import * as config from 'inlet-sdk/config';
${DEFAULTS_IMPORT}

const client = config.init({
${config(["app: { version: '1.4.2' },", 'defaults: configDefaults,', 'installationId: false,'])}
});

// In your consent flow:
client.setInstallationIdEnabled(true);`,
    },
  ];
}
