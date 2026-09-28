# Changelog

## 0.5.0 — 2026-09-28

No environment label, and no compatibility with older servers. Breaking.

- **No `environment` option.** It is gone from `inlet-sdk/crash` and from every
  `inlet-sdk/analytics` entry, and envelopes no longer carry the field: a server refuses an
  envelope that does, as `unknown_field`. An environment is a project: report a staging build
  to a staging project's databases, with that project's publishable key. Nothing is filtered to
  `production` any more; every event and report counts.
- **The identity is always sent.** The crash and feedback modules attach the shared session ID,
  and the installation ID while an analytics client is enabled, without first reading
  `/v1/health`, which they no longer call. `identity: false` still turns the IDs off. They no
  longer warn about deployments older than Release 6 or 7.
- **No compatibility with 0.2.x or 0.3.x modules bundled beside this one.** The shared identity
  is no longer upgraded in place when an older copy of the package created it, and the config
  module expects the analytics module of this version.
- **Needs a server of the same release.** The server dropped the `identity` and
  `feedback-cross-origin` capabilities and the `environment` field, and this version's
  modules do not check which server they talk to.

`SDK_VERSION` is `0.5.0` in every module. The analytics and config modules still wait until
`/v1/health` lists `analytics` or `config`.

## 0.4.0 — 2026-09-27

Remote config.

**What an existing application sees.** Upgrading from 0.3.0 without installing the config
module changes one thing, a fix in the React Native entries (below): crash reports,
submissions and analytics events carry exactly what 0.3.0 sent, and nothing new is written to
the device. `SDK_VERSION` is `0.4.0` in every module.

- **`inlet-sdk/config`** (Remote Config RC-110 to RC-129), with `/browser`, `/node`,
  `/electron`, `/electron-renderer` and `/react-native` entries and the bare entry for any
  runtime with `fetch`. `init` takes the database ID (`cfg_…`), the publishable key, the app
  version and in-app `defaults` that type `get`; reads are synchronous and never throw (`get`,
  `getBoolean`, `getNumber`, `getString`, `getJson`, `getAll`, `getDetails`, `getExperiments`,
  also module-level); `ready({ timeoutMs })`, `onUpdate`, `activate`, `refresh`,
  `setAttributes`, `setUserId`, `setInstallationIdEnabled`, `getInstallationId`, `close`.
  Failures after `init` go to `onError(reason)`. Needs a deployment whose `/v1/health` lists
  `config`; until then the application reads its defaults and asks again ten minutes later.
- **When values apply.** At the next launch by default (`activation: 'launch'`), at once for
  the first fetch before any read, for parameters marked live, for an unpublish and after a
  change of user; `activate()` or `refresh({ activate: true })` applies a staged answer.
  Answers are bound to the app version, build and user ID they were fetched for. The client
  fetches at launch, on return to the foreground after the refresh interval, and every
  interval (the larger of `refreshIntervalMinutes` and the database's), with jitter.
- **Browser**: 7.9 KB minified and gzipped, and the build fails past 8 KB. Answers and the
  installation ID in `localStorage`; the tabs of an origin share one fetch per refresh
  interval under a Web Lock.
- **Node**: server mode (the default) evaluates per context with `evaluate(context)`, 1,000
  contexts cached, and never derives a country from the server's address; device mode
  (`mode: 'device'`, `persistenceDir`) behaves as the browser entry, with files on disk.
- **Electron** (`installElectronMain`, `createElectronRenderer`): the main process owns the
  client under `<userData>/inlet` and pushes its state to every window on
  `inlet:config:state`; renderers hold no key and make no request, and send their reads,
  `activate`, `refresh`, `setUserId` and `setAttributes` over `inlet:config` through a
  preload bridge. `acceptRendererIdentity: false` ignores a renderer's identity calls.
- **React Native**: `Platform`, `AppState`, an AsyncStorage-compatible `store` and `random`
  as parameters, nothing imported. A return to the foreground after 30 minutes or more in the
  background is a launch. What it stores stays under `maxStoreBytes` (1 MB). Metro resolves
  `inlet-sdk/config/react-native` without package `exports`.
- **Experiments into analytics** (RC-129). With an analytics client of the application
  enabled, each activation sets the active answer's split variants with analytics'
  `setExperiment`, so they ride on every later event, and clears the ones the config module
  set that the answer no longer carries; an analytics client enabled later receives them. It
  never touches an experiment your application set, and shares the limit of five with your
  own calls (a refusal goes to the config module's `debug`). The analytics module gains
  `syncConfigExperiments()`, which the config module calls; you do not. An analytics module
  older than 0.4.0 records nothing.
- **The shared identity.** The config module creates the installation ID when none exists,
  under the one key every module reads, unless initialised with `installationId: false`
  (start with it off if the ID needs consent where your users are, then call
  `setInstallationIdEnabled(true)`); the analytics module adopts it. Crash reports and
  feedback submissions still carry an installation ID only while an analytics client is
  enabled. A user ID set by any module (`setUser`, `setUserId`) is seen by the config module,
  which fetches the new user's values, also when the other module is a 0.2.x or 0.3.0 copy.
  A config fetch neither starts nor extends a session.
- **Fix: the React Native store no longer leaves an unhandled rejection** when an
  AsyncStorage that fails rejects its first read (every React Native entry).

## 0.3.0 — 2026-09-27

UX analytics, and the identity it shares.

**What an existing application sees.** Upgrading from 0.2.0 without installing the analytics
module changes one thing: a Node process that awaits `flush(timeoutMs)` exits as soon as its
queue is sent instead of when the timeout runs out (below). Its crash reports and submissions
carry exactly what 0.2.0 sent, and nothing new is written to the device. Everything else below
applies once you initialise `inlet-sdk/analytics`, and most of it only while analytics is
enabled.

- **`flush(timeoutMs)` no longer holds a Node process open**, in every module. The timeout's
  timer used to outlive the flush, so a script or command-line tool that ended with
  `await flush(10_000)` lived the full ten seconds after its queue was sent; the timer now ends
  with the flush. Found by the release's end-to-end tests of the Node entry in device mode.

- **`inlet-sdk/analytics`**, with `/browser`, `/node`, `/electron`, `/electron-renderer`
  and `/react-native` entries (UX Analytics AN-220 to AN-242): `init`, `track`, `screen`, `setUserId`, `setAttribution`, `setExperiment`,
  `setEnabled` (with `forget`), `reset`, `getInstallationId`, `getSessionId`, `flush`,
  `close`. Consent first: initialise with `enabled: false` and call `setEnabled(true)` in your
  consent callback. Events are checked with the server's own rules before they are queued.
  Standard events (`app_installed`, `app_updated`, `app_started`, `session_crashed`,
  `screen_viewed`), sessions shared by the tabs of an origin, a persistent queue in IndexedDB
  or on disk, `keepalive` delivery when a page closes. The browser entry is 15.5 KB minified
  and gzipped. Needs a deployment whose `/v1/health` lists `analytics`; until then events
  wait, and the SDK asks again every ten minutes. `setExperiment` refuses the keys
  `__proto__`, `constructor` and `prototype` through `debug`, as the server refuses them as
  param and experiment keys on every event.
- **Electron** (AN-238): `installElectronMain` from `inlet-sdk/analytics/electron` keeps the
  identity, the queue and the key in the main process under `<userData>/inlet`, defaults the
  app version and ID to the application's own, and reports the operating system's version
  (`process.getSystemVersion()`), not the kernel's. `createElectronRenderer` from
  `inlet-sdk/analytics/electron-renderer` is browser-safe, holds no key and makes no
  request: a window's `track`, `screen`, `setUserId`, `setAttribution`, `setExperiment`,
  `setEnabled` and `reset` go to main over `inlet:analytics` through a preload bridge
  (`window.inletAnalytics`), and main pushes the installation and session IDs back. Main
  reads only an event's name, category, params and timestamp; `acceptRendererIdentity: false`
  refuses a window's identity and consent calls. A window's `setUserId` sets the user ID crash
  reports carry (CR-111).
- **React Native** (AN-239): `inlet-sdk/analytics/react-native` takes `Platform`, `AppState`
  and your store (`store: AsyncStorage`, or MMKV behind the same methods) and imports nothing.
  Platform `ios` or `android` with the system version, a flush when the application goes to
  the background, a new session on return after the timeout and at every process start, and
  at most 1 MB in the store (`maxStoreBytes`). The app version is required. Metro shims for
  `inlet-sdk/analytics` and `inlet-sdk/analytics/react-native`.
- **Crash flags on React Native** (AN-151): the crash module writes a crash flag to its own
  store on its fatal path — synchronously only when that store is synchronous — and the
  analytics module sends it as `session_crashed` at the next start. With AsyncStorage,
  crash-free sessions are best effort; give the crash module a synchronous store to rely on
  them.
- **The installation ID only while analytics is enabled.** Crash reports and submissions
  carry `installationId` while an analytics client of the application is enabled, decided by
  that state, never by an ID being present (Foundations FD-016). Disable analytics and they
  stop carrying it; `setEnabled(false, { forget: true })` also removes it from reports and
  submissions still queued.
- **Crash-free sessions.** With analytics enabled, the crash module flags the session of a
  crashing report (an unhandled exception or rejection, a native crash, an unclean exit, a
  renderer that died) after `beforeSendSync` and before dedupe and sampling, so the analytics
  module sends `session_crashed`; in a browser only errors with a frame in your own code
  count. Nothing is flagged without analytics. See "Crash-free sessions" in the README for
  `appRoots` when your scripts come from a CDN.
- **The unclean-exit sentinel records the session and installation** of the run it watches,
  only while analytics is enabled, and the previous-run report carries them. Without
  analytics it holds what 0.2.0's did.
- **`app_started` asks the crash module** whether it is enabled and, in a browser, whether a
  page script lies within its `appRoots`.
- With analytics enabled in a browser, the session ID lives in `localStorage` and every tab
  of the origin shares it; crash reports from those tabs carry that shared session.
- **A crashing report too large to send still flags its session.** A crash whose context or
  envelope fails the size check is dropped as before, but with analytics enabled
  `beforeSendSync` runs on it and, unless it returns `null`, its session counts as crashed.
- **The React Native store's byte ceiling counts the queue's index too**, so what a queue
  keeps is a little under its ceiling rather than a little over.

## 0.2.0 — September 24, 2026

The shared identity, and React Native. Needs nothing from your server to upgrade: against a
deployment older than this release the new fields are simply not sent.

- **One identity for the application** (Foundations FD-016). Crash reports carry a
  `sessionId` and submissions carry `sessionId` and `userId`: a random, time-ordered UUID
  that rotates after 30 minutes without activity and after 24 hours, and the user ID your
  application set with `setUser` in either module. Both live in memory; nothing is written
  to the device. **This is the one visible change for an application on 0.1.5**: its
  reports gain a session ID. `identity: false` at `init` removes it.
- **Only to a server that accepts it.** The fields go to a deployment whose `/v1/health`
  lists `identity`, checked when the SDK sends and again after a failed probe. The probe
  is shared by both modules and cached per origin.
- **`inlet-sdk/crash/react-native` and `inlet-sdk/feedback/react-native`** (CR-120, FR-211)
  for React Native 0.74 or later, resolvable by Metro without package-exports support.
  See the README.
- **`captureReport({ …, previousRun: true })`** for a report about the previous run, such as
  a native crash summary read at launch. It carries none of the current run's IDs.
- **The unclean-exit report is filed against the release that died.** The sentinel now
  records the release it watches, so an update installed over a crashing version no longer
  attributes the crash to the new one. A sentinel written by 0.1.x still reports, against
  the current release as before.
- **No `crypto` required.** Event IDs, session IDs and fingerprints fall back to the SDK's
  own generator and SHA-256 where `crypto.getRandomValues` or `crypto.subtle` is missing.
- **Truncation never splits an emoji.** Bounds are still counted in UTF-16 units, but a
  cut that would leave half a surrogate pair gives up that unit instead.
- **Every request times out**, feedback's included (20 seconds, `timeoutMs`), without
  needing `AbortSignal.timeout`.
- Feedback's `SDK_VERSION` constant now agrees with the package version; it said 0.1.0.

## 0.1.5 — September 22, 2026

Two hardening fixes on the path 0.1.4 added. Found by a smoke test of the published 0.1.4
tarball, not by a report.

- **`defaultAppRoots()` could throw on a torn-down `location`.** It guarded with
  `typeof location === 'undefined'`, which is false when a test environment sets `location` to
  `null` — defined, but with no `protocol` to read. It now returns `[]` for anything that is not
  a usable location. This matters more than it looks: `defaultAppRoots()` runs inside
  `componentDidCatch`, so throwing there turned a contained React render error into an unhandled
  one. A crash reporter must never make a crash worse.
- **An error boundary no longer rethrows if reporting fails.** `componentDidCatch` now contains
  its own failure, including a `capture` callback of yours that throws. React is already
  handling an error at that point; failing again replaces a contained problem with an
  uncontained one, which is strictly worse than not reporting.

No API change, and nothing about what gets reported. If you are on 0.1.4 and your renderer runs
in a real browser, neither of these can have affected you.

## 0.1.4 — September 22, 2026

A follow-up to 0.1.3, which fixed one of four places that decide what counts as your code.

### Your crash groups will change, once

Frames are marked in-app by matching them against application roots, and the fingerprint is
built from **in-app frames only**. Three entries supplied roots that matched nothing, so they
contributed no frame parts at all — which means every report sharing an error message merged
into a single group no matter where it threw. React render errors were the worst case: one
group for an entire application.

After upgrading, those reports fingerprint by throw site and separate into the groups they
should always have had. Existing groups keep their old reports and nothing merges them, so you
will see familiar groups stop growing while new ones appear beside them. That is the fix
landing, not a regression. Group titles improve for the same reason: `Checkout (<external>)`
becomes `Checkout (index.js)`.

### Fixed

- **`createErrorBoundary` sent every React render-error frame to `<external>`.** Its `appRoots`
  defaulted to `[]`. This is the half of 0.1.3's renderer fix that was missed, and it meant a
  packaged app's React errors were unreadable and ungrouped.
- **`inlet-sdk/crash/browser` still carried the 0.1.3 bug.** Its default was `[location.origin]`,
  which under `file:` is the string `"file://"` and matches no frame.
- **The bare `inlet-sdk/crash` entry supplied no roots at all** in a browser. Now derived, once,
  when the client is created.

### Added

- **`defaultAppRoots()` is exported** from `inlet-sdk/crash`. One derivation now backs all four
  entries — the origin over http, the document's directory under `file:` — and you can call it
  yourself where you need the same answer.

### Changed

- **`redactPatterns` is documented as a denylist**, which is what it always was. It removes the
  shapes it knows and **cannot promise a message carries no content**: a workspace name, a
  project title or a bare filename matches none of its patterns and will be sent. If you need
  content-free reports by construction, use `defaultRedaction` or `redactExcept` — an allowlist
  is the only thing that gives that guarantee. Behaviour is unchanged; the 0.1.3 README
  overstated it by calling it "the right default for most application code".

## 0.1.3 — September 22, 2026

From the second external integration review. One behaviour change, and it makes an upgraded
application report **fewer** crashes, not more — which should not be mistaken for a regression.

### Behaviour change

- **A normal window close is no longer a crash.** `installElectronMain` reported every
  `render-process-gone` and `child-process-gone`, and Electron defines `clean-exit` as "exited
  with an exit code of zero" — which is what closing a window looks like. Every integrator
  filed a crash report every time a user closed a window until they wrote the filter
  themselves. `clean-exit` is now ignored for both, and `killed` is ignored for child processes
  as well, because that is ordinarily your own code terminating a sidecar. A **killed renderer
  is still reported**: there it means the operating system reclaimed memory, which is the crash
  most worth having. Everything else — `crashed`, `oom`, `abnormal-exit`, `launch-failed`,
  `integrity-failure`, `memory-eviction` — is unchanged. Restore the old behaviour with
  `ignoreRendererReasons: []` and `ignoreChildReasons: []`.

### Fixed

- **A packaged Electron renderer produced unreadable stacks.** The renderer's application-root
  default was `location.origin`, which under `file:` — every packaged app — is the string
  `"file://"` and matches no frame, so every frame came back `<external>`. It only ever
  appeared in packaged builds, because a development renderer is served over http. The root is
  now derived from the document's path under `file:`, and stacks in packaged apps mark your own
  code in-app as they always should have.

### Added

- **`uncleanExit`** on `installElectronMain`. A hang, a Force Quit, a power loss and an
  out-of-memory kill run no handler at all, so nothing inside the dying process can report
  them. The SDK now keeps a file while the app is alive and removes it on a clean quit; one
  still there on the next launch is reported as `unclean-exit` with the uptime the previous run
  managed. Off by default, and armed only in packaged builds — a development runner restarts
  main constantly and would report your own dev loop. A file that cannot be read still reports,
  without an uptime, because the crash happened either way. `unclean-exit` has been a declared
  kind with no producer since the first release; this is what produces it.
- **`redactPatterns`**, an application-oriented redaction policy. `defaultRedaction`
  allowlists by *shape*, which fits messages a runtime generates and is exactly inverted for
  messages your own code writes: measured over a realistic sample, every engine message
  survived and every application message became a bare `<redacted>`. `redactPatterns` redacts
  by pattern instead — paths, email addresses, URLs, IP addresses and long opaque tokens become
  markers and the sentence around them survives. **Not the default**, and the README now says
  plainly that your own messages are redacted by default, because a first run showing a column
  of `<redacted>` reads as a broken integration and is not one.
- `ignoreRendererReasons` and `ignoreChildReasons` on `installElectronMain`.

## 0.1.2 — September 21, 2026

From the first external integration review of 0.1.0. The version number says "patch"; four
of these change behaviour for an application already on 0.1.0. Read this section before
upgrading.

### Behaviour changes

- **`defaultRedaction` no longer emits a message's leading token.** It used to send the first
  word of any message that missed the safe list, so `alice@corp.com is not a valid address`
  shipped the address and `/Users/alice/secret.docx could not be opened` shipped the path —
  each behind a `<redacted>` marker that read as though it had been handled. Whether a message
  was protected depended on its word order. Unmatched messages now become `<redacted>` alone,
  except where the leading token is errno-shaped (`ENOENT:`, `ERR_MODULE_NOT_FOUND`), which
  carries triage value and cannot carry a payload. `redactExcept` had the same flaw and is
  fixed the same way. If you relied on the old behaviour, `redaction: keepMessages` sends
  messages verbatim.
- **`installElectronMain` no longer exits the process** after an uncaught exception. Exiting
  is right for a CLI and wrong for Electron main, where it takes every renderer and child
  process with it. Pass `{ exitCode: 1 }` as the second argument for the old behaviour.
- **An envelope that a `beforeSend` hook grew past 64 KiB is now dropped** with
  `onDrop('bounds')`, instead of being sent and answered with 413 — which counted as an
  answer, so the report was discarded anyway, silently.
- **The Electron IPC channel ignores renderer-supplied envelope fields.** Main now reads only
  `kind`, `exception`, `context`, `tags` and `fingerprint` from a renderer, and fills in the
  release, environment, system, runtime, user and event ID itself. A renderer could previously
  override all of those, which let it file a crash against a release that never shipped.
  Kinds from a renderer are limited to `exception`, `unhandled-rejection`, `render-error` and
  `message`; widen with `allowedKinds`, restrict tag keys with `tagAllowlist`.

### Added

- `enabled` at `init` and `setEnabled(enabled, { dropQueue })`. Start with crash reporting
  off without branching around `init`; turn it off at runtime without flushing, which an
  opt-out must not do, and optionally discard what is queued.
- `onSent(sent, envelope)` — once per accepted report, including each accepted entry of a
  batch, with the server's report ID, group ID, new-group and regression flags, paired with
  the envelope that produced it.
- `onDrop(reason, detail)` — `disabled`, `sampled`, `bounds`, `dedupe`, `beforeSend`,
  `queue-full` or `refused`. Three of these were previously invisible even with `debug` on.
- `beforeSendSync` — the only hook that can run on the fatal path, and it runs on the ordinary
  path too, so one hook filters uncaught exceptions as well as everything else.
- `timeoutMs`, default 20 seconds, applied per request. There was no request timeout at all; a
  hung socket was bounded only by the caller's `flush` timeout, which stops the waiting, not
  the request.
- `inlet-sdk/crash/electron-renderer` — the renderer half in its own entry, with no Node
  imports, so a renderer bundler can take it. `installElectronRenderer` also returns a
  teardown now. `inlet-sdk/crash/electron` still re-exports it for main-process code.
- `keepMessages` — the named opt-out from redaction.
- A root export, so `import 'inlet-sdk'` resolves. Namespaced: `import { crash, feedback }`.

### Fixed

- **One client across entry points.** Each entry is bundled standalone, so the module-level
  singleton was a separate variable in `crash`, `crash/node`, `crash/browser` and
  `crash/electron`. Calling `installElectronMain` from one and `captureException` from another
  set one client and read another, and every report was dropped with no warning. The client
  now lives on a `globalThis` symbol. A capture before `init` warns once instead of resolving
  to null in silence.
- **`uninstall()` is complete.** It removed the process handlers but left the `app` and
  `ipcMain` listeners on, so repeated installs stacked in tests and on hot reload.
- The build now fails if a browser-safe entry gains a Node import, and if `SDK_VERSION` drifts
  from `package.json`.

## 0.1.1

Not published.

## 0.1.0 — September 21, 2026

First release. `inlet-sdk/crash` with Node, browser, Electron and React entries, and
`inlet-sdk/feedback`.
