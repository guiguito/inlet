/**
 * The Collect tab's snippets (UX Analytics PRD 8.1 Collect), one per runtime, written against
 * the SDK surface of AN-220 to AN-239. They live here, and only here, so that piece 11, which
 * builds `inlet-sdk/analytics`, checks its surface against exactly what the interface tells an
 * integrator to write: every entry, option and call below must exist under that name.
 *
 * Each is consent-first (AN-186): the module is initialised with `enabled: false` and turned
 * on with `setEnabled(true)` in the application's consent callback. An explicit `enabled` at
 * `init` overrides a persisted choice (AN-225), so the callback runs on every start once the
 * person has agreed.
 */

/** AN-186: said beside the snippets, and in the SDK documentation. */
export const ANALYTICS_CONSENT_NOTE =
  'An installation ID stored on a device generally requires consent in the European Union. You decide the lawful basis of its collection; these snippets start disabled and collect only once your consent callback turns them on.';

export type AnalyticsSnippet = { runtime: string; code: string; note?: string };

export function analyticsSnippets(options: { baseUrl: string; publishableKey: string; analyticsDatabaseId: string }): AnalyticsSnippet[] {
  const config = (app: string, indent = '  ') =>
    [`baseUrl: '${options.baseUrl}',`, `publishableKey: '${options.publishableKey}',`, `analyticsDatabaseId: '${options.analyticsDatabaseId}',`, `app: ${app},`]
      .map((line) => `${indent}${line}`)
      .join('\n');

  return [
    {
      runtime: 'Browser',
      code: `import * as analytics from 'inlet-sdk/analytics/browser';

analytics.init({
${config("{ version: '1.4.0' }")}
  enabled: false, // nothing is stored or sent until consent
});

// In your consent banner's callback, once the person agrees:
analytics.setEnabled(true);

analytics.track('checkout_completed', { params: { plan: 'pro' } });`,
    },
    {
      runtime: 'React Native',
      code: `import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import * as analytics from 'inlet-sdk/analytics/react-native';

// React Native 0.74 or later. The modules are passed in; the entry imports nothing.
analytics.init({
${config("{ version: '1.4.0' }")}
  Platform,
  AppState,
  store: AsyncStorage,
  enabled: false,
});

// In your consent callback:
analytics.setEnabled(true);`,
    },
    {
      runtime: 'Electron main',
      code: `import { app } from 'electron';
import { installElectronMain } from 'inlet-sdk/analytics/electron';

// The identity, the queue and the transport live in the main process. The app version
// and ID default to the application's own; renderers reach it over IPC.
const analytics = await installElectronMain({
${config('{ version: app.getVersion() }')}
  enabled: false,
});

// In your consent callback, here or in a renderer:
analytics.setEnabled(true);`,
    },
    {
      runtime: 'Electron renderer',
      code: `import { createElectronRenderer } from 'inlet-sdk/analytics/electron-renderer';

// Holds no key and makes no request: every call goes to the main process, which adds the
// installation, the session and the context itself.
const analytics = createElectronRenderer();

// In your consent callback; it reaches the main process:
analytics.setEnabled(true);

analytics.screen('Settings');`,
    },
    {
      runtime: 'Node server',
      note: 'In a serverless function, await analytics.flush() before the handler returns.',
      code: `import * as analytics from 'inlet-sdk/analytics/node';

// Server mode: no identity is stored; each event names the user (or the installation)
// it belongs to, and counts as a background event.
analytics.init({
${config("{ version: '1.4.0' }")}
  enabled: false,
});

// When this service may collect, for example once your consent records are loaded:
analytics.setEnabled(true);

// Only for the people whose consent your records hold.
if (user.analyticsConsent) {
  analytics.track('invoice_paid', { userId: user.id, params: { amount: 49 } });
}
await analytics.flush();`,
    },
  ];
}
