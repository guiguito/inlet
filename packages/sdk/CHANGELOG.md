# Changelog

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
