/**
 * The root entry (CR-112).
 *
 * `import 'inlet-sdk'` used to fail outright, because the exports map had no `"."` — the
 * first thing anyone types, and a papercut every integrator hit once.
 *
 * Namespaced rather than flat: both modules export `init`, `flush` and `close`, so a flat
 * re-export would collide. Both sides point at the platform-neutral entries; an application
 * that wants the Node, browser or Electron adapters imports the subpath it needs, which is
 * also what keeps a browser bundle free of the Node ones.
 */
export * as crash from './crash/index.js';
export * as feedback from './feedback/index.js';
