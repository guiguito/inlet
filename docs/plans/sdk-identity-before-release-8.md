# The shared SDK identity, React Native and operator limits, before Release 8

The UX Analytics PRD (Release 8) amended Foundations, Crash Reports and Feedback
Collection. This is the record of realigning the existing code with those amendments
before any analytics code is written. Decisions and rejected alternatives are in
`docs/DECISIONS.md` section 29.

**Status: built and verified September 24, 2026.** `inlet-sdk` 0.2.0 is published to npm
(`latest`), and CI runs every check on GitHub Actions (`.github/workflows/ci.yml`).

## Requirement by requirement

| Requirement | State | Where |
| --- | --- | --- |
| FD-016 session and user ID shared by every module | Built | `packages/sdk/src/identity.ts` |
| FD-016 installation ID, persistence, cross-tab session | Waits for the analytics module | — |
| FD-016, CR-118, FR-204 sent only when `/v1/health` lists `identity` | Built | `packages/sdk/src/health.ts`, both transports |
| FD-015 health lists `identity` | Built | `apps/api/src/app.ts` |
| FD-010 React Native adapters, bare entries runnable anywhere with `fetch` | Built | `src/crash/react-native.ts`, `src/feedback/react-native.ts` |
| FD-012 per-module batch and queue bounds, a `429` pauses only its module | Already true; unchanged | both transports |
| FD-014 identity in each module's allowlist | Built | README "What gets sent" |
| FD-032 operator overrides of collection limits and retention bounds | Built for crash and feedback; analytics limits wait | `apps/api/src/env.ts`, `DEPLOYMENT.md` |
| §12.2, CR-015, AN-019 no address or identifier in logs | Built | `serializeRequest` in `apps/api/src/app.ts` |
| CR-011, FR-062B U+0000 and lone surrogates | Built | `packages/shared/src/text.ts`, `parseEnvelope`, `finalizeIntent` |
| CR-040 filter groups and reports by installation and session | Built, API, MCP and the interface | `routes/crash-reads.ts`, `crash-tools.ts`, `crash-database.tsx` |
| CR-047 erasure by installation or user ID | Waits for the analytics module (AN-183) | — |
| CR-092 `previousRun: true` | Built | `src/crash/client.ts` |
| CR-097 React Native queue in the injected store | Built | `src/store-react-native.ts` |
| CR-100, CR-120 `installReactNativeHandlers` | Built | `src/crash/react-native.ts` |
| CR-109, AN-240 no Node import, no browser global at load | Built, checked by the build | `packages/sdk/build.mjs` |
| CR-111 renderer `setUserId` through the analytics renderer entry | Waits for the analytics module | — |
| CR-115 Hermes frames | Built | `reactNativeFrames` |
| CR-118 identity on reports, stored and never announced | Built | schema, ingest, Slack builders unchanged |
| CR-119 sentinel records its release | Built | `src/crash/sentinel.ts` |
| CR-119 crash flags, sentinel session, `crashReporting` | Waits for the analytics module | — |
| FR-062, FR-111 identity stored with a submission and exported | Built | `services/intents.ts`, `services/export.ts` |
| FR-198 React Native file descriptors | Built | `gateway.ts`, `controller.ts` |
| FR-211 `inlet-sdk/feedback/react-native` | Built | `src/feedback/react-native.ts` |
| AN-239 Metro without package exports, on React Native 0.74 | Built and tested | directory shims, `npm run test:metro` |
| AN-154 Usage profile link on a crash report and a submission | Waits for the analytics module | — |

## Handoff to Release 8

What the analytics module must build on top of this, and where it plugs in:

1. **Installation ID** (FD-016): created at the first enable in device mode, kept until
   `forget`. Set `sharedIdentity().installationId` in `packages/sdk/src/identity.ts`; the crash
   and feedback modules already send it whenever it is set, and nothing else.
2. **Identity persistence** (FD-016): written only while analytics is enabled —
   `localStorage` in browsers, a file on Node and Electron main, write-through to the
   injected store on React Native — and the opt-out choice while disabled. Today `Identity`
   is memory only.
3. **Cross-tab session** (AN-229): one session per origin while analytics is enabled in a
   browser, rotated under a Web Lock, derived with SHA-256 where Web Locks are missing
   (`sha256` is in `packages/shared/src/text.ts`). Extends `Identity.sessionId`.
4. **Crash flags** (CR-119, AN-150): the crash module flags a session crashed, after
   `beforeSendSync` and before dedupe and sampling, for the crashing kinds; the browser
   in-app-frame rule; written to the crash store on the fatal path. The hook point is
   `CrashClient.capture` / `captureSync` in `packages/sdk/src/crash/client.ts`.
5. **Sentinel identity** (CR-119): record the session and installation IDs, rewritten on
   rotation, and carry them on the previous-run report. The release is already recorded
   (`packages/sdk/src/crash/sentinel.ts`); `identityFields(previousRun)` in the crash client
   returns nothing for a previous run until then.
6. **`crashReporting` on `app_started`** (CR-119, AN-150): whether any page script lies
   within the crash module's app roots.
7. **Erasure** (CR-047, AN-183): delete crash reports and group-user associations carrying
   the IDs (adjusting affected users and `latestReportId`), and feedback submissions with
   their attachments. The indexes on `installation_id`, `session_id` and `user_id` are in place
   (in the baseline schema).
8. **Analytics operator limits** (FD-032): add rows to `OPERATOR_LIMITS` in
   `apps/api/src/env.ts` and to the table in `docs/DEPLOYMENT.md`.
9. **Renderer `setUserId`** (CR-111, AN-238): accepted from the analytics renderer entry
   unless `installElectronMain` is told not to.
10. **Usage profile link** (AN-154): on a crash report and a submission carrying the IDs.

## Schema

`installation_id uuid` and `session_id uuid` on `crash_reports` and `submissions`, and
`user_id text` on `submissions`, each nullable and indexed with its database ID. They first
shipped as migration 0007; on September 25, 2026 every migration was folded into the one
baseline, `apps/api/drizzle/0000_initial_schema.sql` (DECISIONS.md 30.3).

## Verification

- `npm run typecheck`, `npm test`: SDK, API unit and integration, MCP.
- `npm run test:e2e`: the real server, including `e2e/api/sdk-identity.spec.ts` (one session
  across a crash report and a submission, `identity: false`, the React Native entries without
  `crypto`), the MCP identity filters in `e2e/api/crash-mcp.spec.ts`, and the report identity
  and session link in `e2e/ui/crash.spec.ts`.
- `npm run test:metro -w inlet-sdk`: the packed tarball bundled by Metro on React Native 0.74
  for iOS and Android.

## Upgrade notes

- An application on `inlet-sdk` 0.1.5 that upgrades to 0.2.0 sees its crash reports gain a
  session ID; `identity: false` removes it.
- The SDK can be upgraded before the server: against a deployment whose health does not
  list `identity`, the fields are not sent.
- The API's request log no longer carries URLs or client addresses; a log pipeline that
  parsed `req.url` or `req.remoteAddress` reads `req.route` instead.
