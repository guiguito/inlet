# `inlet-sdk` 0.1.2 (crash SDK integration feedback): implementation plan and handoff

**Status as of September 21, 2026: implemented and verified.** Not a numbered Inlet release —
the server, the interface and the MCP tools are untouched; only `packages/sdk` and the
documentation change. Requirements: `docs/prd/crash-reports.md` section 6.9 (mirrored from the
Notion page named in its Document Status). Technical choices and rejected alternatives:
`docs/DECISIONS.md` section 26. Requirement IDs are cited as CR-xxx; Foundations rules as
FD-xxx.

Driven by the first external integration review of 0.1.0, which went to npm the same morning.
Fourteen items were filed. Eleven are implemented here with two of the three nice-to-haves;
the minidump reader is deferred.

## What is done and verified

| Piece | Where | Verified by |
| --- | --- | --- |
| Runtime enable and disable; `enabled` at `init`, `setEnabled(enabled, { dropQueue })`, no flush on the way out (CR-104) | `src/crash/client.ts`, `src/crash/transport.ts` (`setPaused`, `clear`), `src/crash/index.ts` | `test/crash.test.ts`, 4 cases in "runtime enable and disable" |
| Delivery callback, once per accepted report, paired with its envelope by batch index (CR-105) | `src/crash/transport.ts` run loop | `test/crash.test.ts`, 2 cases in "delivery callback" — one a 3-report batch with the middle entry refused |
| Per-request timeout via `AbortSignal.timeout`, default 20 s, on ingest and the health check (CR-106) | `src/crash/transport.ts` `abort()` | `test/crash.test.ts`, "aborts a hung request instead of waiting on the socket" |
| `beforeSendSync`, running on both capture paths before the async hook (CR-107) | `src/crash/client.ts` `runBeforeSendSync` | `test/crash.test.ts`, 3 cases in "synchronous envelope hook" |
| Bounds re-checked after the hooks, so a hook cannot breach the 64 KiB cap (CR-096) | `src/crash/client.ts` `capture`, `captureSync` | `test/crash.test.ts`, "drops an envelope a hook grew past 64 KiB" |
| Structured drop reporting for all seven reasons (CR-108) | `src/crash/client.ts`, `src/crash/transport.ts` | `test/crash.test.ts`, 2 cases in "structured drop reporting" |
| Browser-safe Electron renderer entry, with a teardown it never had (CR-109) | `src/crash/electron-renderer.ts` (new), `package.json` exports, `build.mjs` | `test/electron.test.ts`, "the renderer entry is browser-safe"; `browserSafe()` at build time |
| Default redaction emits the marker alone, errno-shaped leading token excepted; `keepMessages` (CR-094, CR-113) | `src/crash/redaction.ts` | `test/crash.test.ts`, 4 cases in "redaction" |
| One client across entry points, on a `globalThis` symbol; a capture before `init` warns (CR-110) | `src/crash/index.ts` | `test/crash.test.ts`, "one client across entry points"; `grep` over `dist/crash/*.js` |
| Electron main does not exit by default; uninstall removes every listener (CR-100) | `src/crash/electron.ts`, `src/crash/node.ts` | `test/electron.test.ts`, 2 cases in "Electron main teardown" |
| IPC as a trust boundary: five fields read, kinds restricted, tags bounded and allowlistable (CR-111) | `src/crash/electron.ts` `sanitizeRendererReport` | `test/electron.test.ts`, 3 cases in "the IPC channel is a trust boundary" |
| Root export, namespaced (CR-112) | `src/index.ts` (new), `package.json` exports, `build.mjs` | `browserSafe()` covers `dist/index.js`; typecheck |
| `SDK_VERSION` can no longer drift from `package.json` | `build.mjs` `versionsAgree()` | Confirmed to fail on a deliberate mismatch |

98 tests pass (`npm test -w inlet-sdk`), up from 75. Typecheck and build are clean, and both
new build checks were confirmed to fail on a deliberately broken tree before being trusted.

## What remains, in order

1. *(done: the eleven blocking and correctness items, CR-104 to CR-113 plus the four
   amendments.)*
2. *(done: PRD amended in Notion and mirrored to `docs/prd/crash-reports.md`; parity verified
   at 313/313 prose lines.)*
3. *(done: `docs/DECISIONS.md` section 26, `packages/sdk/README.md`, `docs/USING-INLET.md`,
   and the four wrong snippets in `apps/web/src/pages/crash-database.tsx`.)*
4. **Publish.** Not done, and deliberately not automated. See "Publishing" below.
5. **Tell the integrator.** The four behaviour changes are in `packages/sdk/CHANGELOG.md`;
   0.1.2 does not signal them by its number.

## Left out, and why

- **The minidump reader.** A binary-format parser, nobody is blocked on it, purely additive.
  Deferred to a later Crash release with a design note in the PRD's section 14.
- **`crash/electron` still re-exports `installElectronRenderer`.** Moving it outright would
  break a main-process module that imports it, for no benefit; a renderer could never have
  used that entry anyway. The README and the interface both point at the new entry.
- **The feedback module's singleton.** The same per-entry bundling almost certainly duplicates
  it too. Out of scope here; worth checking before the feedback SDK gets its own integrator.
- **`files: ["dist", "src"]` still ships `src/`,** whose `@inlet/shared/crash-core` imports do
  not resolve from the tarball. Cosmetic — it only affects go-to-definition — but it is real.

## Watch out for

- **The errno regex needs its trailing `:?`.** `ENOENT:` carries the colon, and
  `/^[A-Z][A-Z0-9_]{2,}$/` as originally proposed drops it, silently turning a useful title
  into a bare marker and breaking `test/crash.test.ts`.
- **`browserSafe()` must not match the bare string `"node:"`.** `dist/crash/browser.js` and
  `dist/crash/react.js` contain `normalized.startsWith("node:")` in the in-app frame filter.
  Match an import or a require.
- **Do not "simplify" the global symbol back into a module variable.** It looks like an
  unnecessary indirection and it is the only thing making the four bundles agree. Section 26.1.
- **Tests that assert on a message now need `keepMessages`.** Five existing tests failed on
  the redaction change, and one of them — the `beforeSend` test — failed for a non-obvious
  reason: its hook filtered on `message.includes('drop')`, which stopped matching once the
  message became `<redacted>`.
- **A Notion `update_content` batch is all-or-nothing.** One bad `old_str` rolls back the
  whole call, and Notion re-serializes a code span inside bold as `**** \`x\` ****`, so an
  `old_str` copied from the mirror will not match. Keep code spans out of bold headings.

## Conformance: every requirement, where it lives, how it is proven

Legend: **SDK** = `packages/sdk/src`, **Test** = `packages/sdk/test`, **Build** =
`packages/sdk/build.mjs`, **Web** = `apps/web/src`.

### 6.9 SDK — `inlet-sdk/crash`

| Req | Where | Proof |
| --- | --- | --- |
| CR-090 (amended) | SDK `crash/index.ts` | typecheck; `setEnabled` exported and tested |
| CR-094 (amended) | SDK `crash/redaction.ts` | Test `crash.test.ts` "redaction", 4 cases |
| CR-096 (amended) | SDK `crash/client.ts` | Test "bounds are re-checked after the hooks" |
| CR-100 (amended) | SDK `crash/electron.ts`, `crash/node.ts` | Test `electron.test.ts` "Electron main teardown", 2 cases |
| CR-104 | SDK `crash/client.ts`, `crash/transport.ts` | Test "runtime enable and disable", 4 cases |
| CR-105 | SDK `crash/transport.ts` | Test "delivery callback", 2 cases |
| CR-106 | SDK `crash/transport.ts` | Test "request timeout" |
| CR-107 | SDK `crash/client.ts` | Test "synchronous envelope hook", 3 cases |
| CR-108 | SDK `crash/client.ts`, `crash/transport.ts` | Test "structured drop reporting", 2 cases |
| CR-109 | SDK `crash/electron-renderer.ts`, Build `browserSafe()` | Test "the renderer entry is browser-safe"; build fails on a planted `node:fs` |
| CR-110 | SDK `crash/index.ts` | Test "one client across entry points"; every `dist/crash/*.js` references one symbol |
| CR-111 | SDK `crash/electron.ts` | Test "the IPC channel is a trust boundary", 3 cases |
| CR-112 | SDK `index.ts`, `package.json` | Build emits `dist/index.{js,cjs}`, node-free |
| CR-113 | SDK `crash/redaction.ts` | Test "keepMessages is the named opt-out" |

### Documentation

| Surface | Where | Note |
| --- | --- | --- |
| PRD | Notion page + `docs/prd/crash-reports.md` | Parity verified, 313/313 prose lines |
| Decisions | `docs/DECISIONS.md` section 26 | Six subsections, four corrections and two declines |
| Integrator guide | `packages/sdk/README.md` | Redaction, Turning it off, delivery callbacks, renderer entry, option table |
| Product walkthrough | `docs/USING-INLET.md` | Entry points, redaction default, opt-out |
| Collect tab | Web `pages/crash-database.tsx` | All four snippets named the wrong entry; fixed |
| Changelog | `packages/sdk/CHANGELOG.md` | New. Leads with the four behaviour changes |
