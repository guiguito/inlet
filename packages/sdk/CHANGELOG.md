# Changelog

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
