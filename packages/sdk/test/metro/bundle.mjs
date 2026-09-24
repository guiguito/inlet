/**
 * The Metro integration test (UX Analytics AN-239, Crash Reports CR-120, Feedback
 * Collection FR-211).
 *
 * Packs `inlet-sdk`, installs the tarball into a throwaway React Native 0.74 project and
 * bundles, for both platforms and in release mode, an application that imports every entry
 * a React Native application imports: the React Native entries, the bare entries and
 * `inlet-sdk/feedback/react`. React Native 0.74's Metro does not read package `exports`, so
 * this is what proves the directory shims resolve.
 *
 * Not part of `npm test`: it installs React Native, which takes a minute and a few hundred
 * megabytes. Run it with `npm run test:metro -w inlet-sdk`. Set INLET_METRO_PROJECT to a
 * directory to keep and reuse the project between runs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sdk = resolve(import.meta.dirname, '../..');
const project = process.env.INLET_METRO_PROJECT ?? mkdtempSync(join(tmpdir(), 'inlet-metro-'));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

mkdirSync(project, { recursive: true });
if (!existsSync(join(project, 'node_modules/react-native'))) {
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'inlet-metro-check', private: true, version: '0.0.0' }));
  run('npm', ['install', '--no-audit', '--no-fund', 'react-native@0.74.7', 'react@18.2.0', '@react-native/metro-config@0.74.89', '@react-native/babel-preset@0.74.89'], project);
}

// The tarball, exactly as npm would publish it.
run('npm', ['run', 'build'], sdk);
const tarball = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', project], { cwd: sdk, encoding: 'utf8' }).trim().split('\n').pop();
run('npm', ['install', '--no-audit', '--no-fund', '--no-save', join(project, tarball)], project);

writeFileSync(join(project, 'babel.config.js'), "module.exports = { presets: ['module:@react-native/babel-preset'] };\n");
writeFileSync(
  join(project, 'metro.config.js'),
  "const { getDefaultConfig } = require('@react-native/metro-config');\nmodule.exports = getDefaultConfig(__dirname);\n",
);
writeFileSync(
  join(project, 'index.js'),
  `import * as crashRn from 'inlet-sdk/crash/react-native';
import * as crash from 'inlet-sdk/crash';
import * as feedbackRn from 'inlet-sdk/feedback/react-native';
import * as feedback from 'inlet-sdk/feedback';
import { useFeedbackSession } from 'inlet-sdk/feedback/react';

globalThis.__inlet = [crashRn.init, crashRn.installReactNativeHandlers, crash.captureException, feedbackRn.init, feedback.createSession, useFeedbackSession];
`,
);

for (const platform of ['ios', 'android']) {
  const out = join(project, `bundle.${platform}.js`);
  run('npx', ['react-native', 'bundle', '--platform', platform, '--dev', 'false', '--entry-file', 'index.js', '--bundle-output', out, '--reset-cache'], project);
  const bundle = readFileSync(out, 'utf8');
  for (const marker of ['installReactNativeHandlers', 'inlet-crash:', 'inlet-feedback:']) {
    if (!bundle.includes(marker)) throw new Error(`The ${platform} bundle does not contain ${marker}; an inlet-sdk entry was not bundled.`);
  }
  console.log(`Metro bundled every React Native entry of ${tarball} for ${platform} (${Math.round(bundle.length / 1024)} KB).`);
}
