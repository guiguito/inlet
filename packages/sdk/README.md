# inlet-sdk

The client SDK for [Inlet](../../README.md), the self-hosted place your applications
report to. Three modules:

- **`inlet-sdk/feedback`** collects a form's answers from inside your own interface.
- **`inlet-sdk/crash`** reports application failures.
- **`inlet-sdk/analytics`** sends usage events: sessions, retention, funnels, crash-free
  sessions. See [UX analytics](#ux-analytics).

Zero runtime dependencies, ESM and CommonJS, Node 18 or later, evergreen browsers and
React Native 0.74 or later. Feedback and crash have a Node, browser, Electron, React and
React Native entry; analytics has a browser, Node, Electron and React Native entry.

The modules share one **identity** per application: a random session ID, rotated after
30 minutes without activity or after 24 hours, and the user ID you set with `setUser`. It
travels with crash reports and submissions so that Inlet can show you the crash and the
feedback of the same session side by side. Without the analytics module it lives in memory,
is never derived from the device, and `identity: false` at `init` turns it off; see
[Identity](#identity).

If you have never seen Inlet: an Inlet **project** holds databases and owns two kinds of
API key. A **publishable key** (`ipk_…`) can only send data in and is safe to ship in an
application; a **secret key** reads what was collected and must never leave your servers.
A **feedback database** (`fdb_…`) holds one form and the responses it collected. A **crash
database** (`cdb_…`) receives failure reports and groups them into one row per distinct
bug, so that a crash loop is one line and one Slack message.

Your application does not have to share an origin with your Inlet: both modules' browser
entries send cross-origin, with no cookie and no reverse proxy. The server's side of all
this is described in [docs/USING-INLET.md](../../docs/USING-INLET.md); the wire format in
[docs/API.md](../../docs/API.md).

## Install

```
npm install inlet-sdk
```

---

# Feedback

A form in Inlet is pages of questions. Collecting a response is four calls — read the
published form, open a submission intent, upload any screenshots under it, finalize once —
and the calls are not the hard part. What this module does is everything around them:
pinning one version from render to submit, the answer shape per question type, an intent
that expires while somebody is still typing, validating a required question exactly as the
server does, and retrying a lost submission without creating a duplicate.

It draws nothing. There is no component, no stylesheet and no framework requirement: you
get a **controller** that holds one respondent's session and tells your interface what to
show next, and you draw it however the rest of your product is drawn.

The SDK is one of three ways to collect. The **hosted form** is a link with no engineer,
the **HTTP API** is for anything the SDK does not fit, and this is for a form inside your
own application's interface and identity. All three write to the same feedback database.

## Browser

```ts
import * as feedback from 'inlet-sdk/feedback/browser';

feedback.init({
  baseUrl: 'https://inlet.example.com',
  publishableKey: 'ipk_…',
  feedbackDatabaseId: 'fdb_…',
});

const form = await feedback.getForm();
if (!form.ok) return;            // e.g. form.error.code === 'form_not_published'

const session = await feedback.createSession();
if (!session.ok) return;
const controller = session.value;
```

`getForm` returns a result rather than throwing, so "nobody has published this form yet"
is a message you show, not an exception you catch.

## The controller

Subscribe to it, read its snapshot, call its actions. That is the whole interface.

```ts
controller.subscribe((snapshot) => render(snapshot));

const snapshot = controller.getSnapshot();
// snapshot.page.elements  — what to draw now, in authored order
// snapshot.pageIndex, snapshot.pageCount, snapshot.isFirstPage, snapshot.isLastPage
// snapshot.answers        — what has been answered so far
// snapshot.validation     — { [questionId]: { valid: false, code, message } } for this page
// snapshot.screenshots    — { [questionId]: { attachments, uploads, remaining, lost } }
// snapshot.status         — editing | uploading | submitting | submitted | failed | expired
// snapshot.result         — { submissionId, formVersion, createdAt } once submitted
// snapshot.error          — the last refusal, if any
```

The actions:

```ts
controller.setAnswer(questionId, answer);   // undefined clears it
controller.next();                          // validates this page; false if it failed
controller.back();
controller.validatePage();                  // check without moving
await controller.addScreenshot(questionId, file);
await controller.removeScreenshot(questionId, attachmentId);
await controller.submit();
controller.abandon();                       // discards everything; sends nothing
```

The answer shape follows the question's type in the published form, so you never write it
twice:

| Question type | Answer |
| --- | --- |
| `choice`, single-select | `{ optionId: 'op_…' }` |
| `choice`, multi-select | `{ optionIds: ['op_…', 'op_…'] }` |
| `text` | `{ value: 'It hung on save' }` |
| `email` | `{ value: 'someone@example.com' }` |
| `screenshot` | managed for you by `addScreenshot` |

`next()` and `submit()` validate with the server's own rules, bundled into this package at
build: required questions, character limits, no newline in a single-line question, email
syntax, option membership, screenshot count and media type. A placeholder nobody typed
into never satisfies a required question. So a respondent is told what is wrong before a
request goes out, in the same words the server would have used.

## Screenshots

```ts
const result = await controller.addScreenshot(questionId, file);   // a File, Blob or Buffer
if (!result.ok) showMessage(result.error.message);                 // refused before any upload
```

The file's media type and size are checked against that question's own limits first, so an
oversized image fails instantly instead of after a ten-megabyte upload. What comes back is
the image **as Inlet stored it** — re-encoded, usually smaller, with its real dimensions —
which is what you should show in a thumbnail. `snapshot.screenshots[questionId].uploads`
carries a `progress` from 0 to 1 while it is going up, and `remaining` says how many more
that question will take. Screenshot bytes are never persisted by this module.

## Submitting

```ts
const outcome = await controller.submit();
switch (outcome.status) {
  case 'accepted':
  case 'duplicate':  // already stored, this is its original result — treat as success
    thankThem(outcome.submissionId);
    break;
  case 'invalid':    // the server refused an answer; the controller is back on that page
    break;
  case 'pending':    // the network failed; it is queued and will be delivered
    break;
  case 'failed':
    showMessage(outcome.error.message);
    break;
}
```

`submit` always resolves. If the network drops, the finalization is queued and `submit`
returns `pending` rather than hanging; the session stays `submitting` and its snapshot
becomes `submitted` or `failed` when the server finally answers — on this page, or after a
restart. Render the snapshot, not the promise.

## Node

```ts
import * as feedback from 'inlet-sdk/feedback/node';

feedback.init({
  baseUrl, publishableKey, feedbackDatabaseId,
  queueDir: '/var/lib/myapp/inlet-feedback',   // where an undelivered submission waits
});
```

A screenshot may be a `Buffer` (its type is read from its first bytes), a `Blob`, or
`{ data, mediaType, filename }`.

This is the server-to-server case: your backend submitting on behalf of your application.
The address Inlet records with the submission is then your server's, not the respondent's.
If that matters, collect from the browser entry or from a hosted form instead.

## Electron

The key, the queue and the network live in the main process; the renderer drives the
session over IPC and never holds a credential.

Main, during `app.whenReady()`:

```ts
import { installElectronMain } from 'inlet-sdk/feedback/electron';

await installElectronMain({ baseUrl, publishableKey, feedbackDatabaseId });
// the queue defaults to <userData>/inlet-feedback
```

Preload, with context isolation on:

```ts
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('inletFeedback', {
  invoke: (channel: string, request: unknown) => ipcRenderer.invoke(channel, request),
  on: (channel: string, listener: (payload: unknown) => void) =>
    ipcRenderer.on(channel, (_event, payload) => listener(payload)),
});
```

Renderer:

```ts
import { createElectronRenderer } from 'inlet-sdk/feedback/electron';

const inlet = createElectronRenderer();          // uses window.inletFeedback
const session = await inlet.createSession();     // same controller as everywhere else
```

`on` is what lets the renderer hear about a submission main delivered minutes later. Leave
it out and the session simply stays `submitting`.

## React, and any other framework

```tsx
import React from 'react';
import { useFeedbackSession } from 'inlet-sdk/feedback/react';

function FeedbackForm({ controller }) {
  const form = useFeedbackSession(React, controller);   // snapshot + bound actions
  return (
    <form onSubmit={(e) => { e.preventDefault(); form.submit(); }}>
      {form.page.elements.map((element) => renderElement(element, form))}
      {!form.isFirstPage && <button type="button" onClick={form.back}>Back</button>}
      {form.isLastPage
        ? <button type="submit" disabled={form.status !== 'editing'}>Send</button>
        : <button type="button" onClick={form.next}>Next</button>}
    </form>
  );
}
```

React is passed in rather than imported, so this package has no peer dependency and an
application without React never loads that file.

Nothing about the controller is React-shaped. Any framework binds to it the same way — and
so does no framework at all:

```ts
// Svelte
export const session = { subscribe: (run) => (run(controller.getSnapshot()), controller.subscribe(run)) };

// Vue
const snapshot = shallowRef(controller.getSnapshot());
controller.subscribe((next) => { snapshot.value = next; });

// Plain DOM
controller.subscribe(render);
render(controller.getSnapshot());
```

## What gets sent

Exactly four things, at finalization:

- the form version this session pinned;
- the answers, keyed by question ID;
- the IDs of screenshots uploaded under this session's intent;
- the `clientContext` you supplied, if any.

Never sent automatically: the page address, the user agent, the referrer, the language,
the viewport, cookies, timing, or any identifier other than the [identity](#identity)
both modules share: the session ID, and the user ID once your application set one. A
hosted form records operational context because it *is* the client; this is a library
inside somebody else's client and gathers no context of its own.

```ts
feedback.init({ …, clientContext: { appVersion, plan: 'team' } });     // on every submission
await feedback.createSession({ clientContext: { screen: 'billing' } }); // and per session
```

`clientContext` is arbitrary JSON up to 16 KiB; an oversized one fails `submit` locally
with a typed error rather than leaving a `413` for the respondent to wait for. `beforeSend`
gets the whole payload before it is queued and may change it or return `null` to drop it.

## Delivery

Every finalization is attempted immediately, so the ordinary case is one round trip. If it
does not complete, it is held — on disk in Node and Electron, in IndexedDB in browsers —
and replayed on start and after every submit, with exponential backoff, paused by a `429`
for its `Retry-After`. It is kept until the server answers, whatever the answer is.

That last part is the point. A request that vanished after the server stored the response
looks exactly like one that never arrived, and only the server can tell them apart: the
submission intent guarantees that replaying the same payload returns the original result
and that a different payload is refused. So the SDK never guesses. Even after the intent's
expiry has passed the replay still happens, because a finalized intent never expires: the
server answers with the original result if it had the submission, and `intent_expired` if
it never did, and either answer ends the retry. At most twenty submissions wait at once,
and one the server has never answered in seven days is dropped with a message through
`debug`.

Two finalizations for one intent are impossible: a `submit` whose payload differs from one
already queued is refused locally, so this module can never be the cause of an
`intent_payload_conflict`.

## Feedback options

| Option | Purpose |
| --- | --- |
| `baseUrl`, `publishableKey`, `feedbackDatabaseId` | Required. A secret key throws at `init`. |
| `clientContext` | Merged into every submission. A session's own keys win. |
| `beforeSend(payload)` | Return the payload, a changed one, or `null` to drop it. |
| `queueDir` (Node, Electron) / `store` | Where an undelivered submission waits. |
| `fetch` | Your own implementation, for tests or a proxy. |
| `debug(message, detail)` | Warnings and transport events. Silent by default. |

Per session, on `createSession`:

| Option | Purpose |
| --- | --- |
| `clientContext` | Merged over the client's. |
| `retainScreenshotBytes` | Default true. Keeps uploaded bytes in memory so an expired intent can re-upload them instead of asking the respondent again. |

---

# Crash reports

Reports an application's failures to a crash database, which groups them into one row per
distinct bug. Everything below is independent of the feedback module; if you use both,
`baseUrl` and `publishableKey` are the same values and the two share one place on disk.

## Node

```ts
import * as crash from 'inlet-sdk/crash/node';

crash.init({
  baseUrl: 'https://inlet.example.com',
  publishableKey: 'ipk_…',
  crashDatabaseId: 'cdb_…',
  release: process.env.APP_VERSION!,
  queueDir: '/var/lib/myapp/inlet-crash', // where unsent reports wait for the network
});
crash.installNodeHandlers();
```

`installNodeHandlers` observes `uncaughtException` and `unhandledRejection`. On an
uncaught exception the report is written to `queueDir` synchronously, sent if the network
allows within two seconds, and the process then exits with code 1 the way Node would
have. Pass `{ exitCode: false }` to keep the process alive, if you know what you are doing.

## Browser

```ts
import * as crash from 'inlet-sdk/crash/browser';

crash.init({ baseUrl, publishableKey, crashDatabaseId, release: '1.4.0' });
crash.installBrowserHandlers();
```

The queue lives in IndexedDB. Frames from your own origin are in-app; frames from a CDN
or an extension are recorded as `<external>` with their function name only.

Your site and Inlet do not need to share an origin: crash ingest answers cross-origin
requests, so `https://app.example.com` can report to `https://inlet.example.com` with no
reverse proxy in between. Nothing else in Inlet does, and no cookie is ever sent with a
report. If IndexedDB is unavailable — a private window, blocked site data — the SDK keeps the
queue in memory for the life of the page and says so through `debug` instead of failing.

## Electron

Main process, during `app.whenReady()`:

```ts
import { installElectronMain } from 'inlet-sdk/crash/electron';

await installElectronMain({ baseUrl, publishableKey, crashDatabaseId });
// release defaults to app.getVersion(), the queue to <userData>/inlet-crash
```

This installs the Node handlers, reports `render-process-gone` and `child-process-gone`
with their reason and exit code, and listens on the IPC channel `inlet:crash` for
envelopes from renderers.

**Not every exit is a crash.** Electron reports a normal window close as `clean-exit`, so
that reason is ignored by default — reporting it files a crash every time someone closes a
window. For child processes `killed` is ignored too, because that is usually your own code
calling `kill()` on a sidecar; for renderers `killed` *is* reported, because there it means
the operating system took the process away, which is an OOM kill and the crash you most want.
Everything else — `crashed`, `oom`, `abnormal-exit`, `launch-failed`, `integrity-failure`,
`memory-eviction` — is reported.

```ts
await installElectronMain({
  ...,
  ignoreRendererReasons: ['clean-exit'],            // the default
  ignoreChildReasons: ['clean-exit', 'killed'],     // the default
});
```

Pass `[]` to either one to report every reason, as versions before 0.1.3 did.

### Catching the exits that leave nothing behind

A hang, a Force Quit, a power loss and an OOM kill run no handler at all, so nothing inside
the dying process can report them. `uncleanExit` writes a small file while the app is alive
and removes it on a clean quit; a file still there on the next launch means the last run died,
and is reported as `unclean-exit` with the uptime it managed.

```ts
await installElectronMain({ ..., uncleanExit: true });
```

Off by default, and armed only in a packaged build — a development runner restarts the main
process constantly and would otherwise report your own dev loop. The file lives beside the
queue, under the user-data directory.

Preload script, so a renderer can reach that channel with context isolation on:

```ts
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('inletCrash', {
  send: (channel: string, envelope: unknown) => ipcRenderer.send(channel, envelope),
});
```

Renderer:

```ts
import { installElectronRenderer } from 'inlet-sdk/crash/electron-renderer';
import { createErrorBoundary } from 'inlet-sdk/crash/react';
import React from 'react';

const renderer = installElectronRenderer(); // uses window.inletCrash.send
const ErrorBoundary = createErrorBoundary(React, (report) => renderer.captureReport(report));

renderer.uninstall(); // takes the window listeners off again, for hot reload and tests
```

`inlet-sdk/crash/electron-renderer` is its own entry, with no Node imports, so a renderer
bundler can take it. `inlet-sdk/crash/electron` pulls in the Node adapter and the on-disk
queue, which Vite will not bundle for a renderer; it re-exports `installElectronRenderer`
only so a main-process module keeps working.

A renderer never holds the key or a queue; everything goes through main. Main treats the
channel as a trust boundary: it reads only `kind`, `exception`, `context`, `tags` and
`fingerprint`, and fills in the release, environment, system and user itself, so a renderer
running remote content cannot file a crash against a release that never shipped. Kinds are
limited to `exception`, `unhandled-rejection`, `render-error` and `message`; widen that with
`allowedKinds`, and restrict tag keys with `tagAllowlist`.

## What gets sent

Only the fields of the crash envelope, and nothing your code did not put there:

- the failure: kind, error type, message, frames (function name, file, line, column,
  whether it is your code);
- your release, environment, operating system and runtime;
- an opaque user ID, only after you call `setUser(id)`;
- the session ID of the shared [identity](#identity), unless `identity: false`;
- tags you set and any `context` you attach to a capture.

Never sent automatically: environment variables, command-line arguments, URLs, headers,
local variables, source lines, console output, or file paths outside your application.
Library frames lose their path and keep their function name.

**Messages are redacted by default.** An error message is where user data leaks:
`ENOENT: … /Users/alice/…`, `Invalid email alice@…`. The default policy keeps a message
only when it matches a shape known to come from the runtime (`x is not a function`,
`Cannot read properties of undefined (reading 'id')`, `Maximum call stack size exceeded`,
…) and otherwise sends the first word followed by `<redacted>`. If your messages are
safe, pass `redaction: (message) => message`; to allow your own shapes, pass
`redaction: redactExcept([/^Could not open document/])`.

## Capturing by hand

```ts
import { captureException, captureMessage, captureReport, setUser, setTags, flush } from 'inlet-sdk/crash';

try { risky(); } catch (error) { await captureException(error, { tags: { step: 'import' } }); }
await captureMessage('Sync took longer than a minute', { kind: 'message' });
await captureReport({ kind: 'unclean-exit', exit: { lastUptimeMs: 4200 } }); // for what the SDK cannot observe
setUser('user-42'); setUser(null);
setTags({ engine: 'pi', windows: '2' });
await flush(); // before a planned exit
```

`captureReport` is for failure classes the SDK cannot see itself: a native crash your
application parsed from a minidump on the next launch (`kind: 'native'`), or a sidecar the
SDK does not supervise. You build the block for the kind; the SDK fills in the release,
environment, system, user and tags. On Electron you no longer have to write the unclean-exit
sentinel yourself — `installElectronMain({ uncleanExit: true })` does it.

## Delivery

Every report is queued before it is sent, and the queue survives restarts (disk on Node
and Electron, IndexedDB in browsers). Replay runs on start and after every capture, up to
50 reports per request, at least 100 ms apart. A `429` from the server pauses replay for
its `Retry-After`; a network failure backs off exponentially; a report the server has
answered, with a result or with a refusal, is never sent again. The queue holds 200
reports and drops the oldest past that.

On the client, the same crash (same fingerprint, computed exactly as the server does) is
sent once per 24 hours, and at most five reports go out per hour, both persisted across
restarts, so a crash loop that restarts your application sends one report. Loosen it with
`dedupe: { perFingerprintMs, perHour }` or disable it with `dedupe: false`.

Every request carries a timeout, 20 seconds by default (`timeoutMs`). `onSent` is called
once per report the server accepted — including each accepted entry of a batch — with the
server's ids and the envelope that produced it, which is what lets you write an audit row
that knows whether the crash was new:

```ts
init({
  ...,
  onSent: ({ reportId, groupId, isNewGroup }, envelope) => audit(envelope.eventId, reportId, groupId, isNewGroup),
  onDrop: (reason, detail) => log(`crash report dropped: ${reason}`, detail),
});
```

`onDrop` names why a report never reached the server: `disabled`, `sampled`, `bounds`,
`dedupe`, `beforeSend`, `queue-full` or `refused`. Without it every drop is invisible unless
you also passed `debug`.

## Turning it off

```ts
init({ ..., enabled: false });        // start off; no branching around init
await setEnabled(true);               // start capturing
await setEnabled(false);              // stop capturing and stop replay, keep the queue
await setEnabled(false, { dropQueue: true }); // and discard what is queued
```

This is the opposite of `close()`, which flushes. An opt-out that flushed would send the
very reports the person just declined, so `setEnabled(false)` never does.

## Redaction

**Read this before you conclude the integration is broken.** By default, *your own error
messages are redacted*. An exception message is the one field that routinely carries what a
user typed, so the default sends it only when it matches a shape the runtime itself generates
— `x is not a function`, `socket hang up` — and replaces everything else with `<redacted>`.
Messages your application authors are exactly the ones that do not match. A first run against
a fresh database therefore shows a column of `<redacted>`, and that is the default working,
not a fault.

It is also the wrong trade for most applications, because an application's own messages are
the diagnostic half and usually carry no user data at all. Pick a policy deliberately:

| Policy | What it sends |
| --- | --- |
| `defaultRedaction` | The default. Allowlists by *shape*: known runtime messages verbatim, everything else `<redacted>`, keeping an errno-shaped leading token (`ENOENT:`, `ERR_MODULE_NOT_FOUND`). Safest, and quietest. |
| `redactPatterns` | Redacts by *pattern* instead: paths, email addresses, URLs, IP addresses and long opaque tokens become markers and the sentence around them survives. A **denylist**, so best effort — see below. |
| `redactExcept([/^…/])` | Your own safe shapes verbatim; everything else as `defaultRedaction`. |
| `keepMessages` | Everything verbatim. For applications that know their messages carry no user data. |

```ts
import { keepMessages, redactExcept, redactPatterns } from 'inlet-sdk/crash';

init({ ..., redaction: redactPatterns });
// 'Wallet sync failed after 3 retries'           -> unchanged
// '/Users/alice/secret.docx could not be opened' -> '<path> could not be opened'
```

`redactPatterns` is a **denylist**, and that is a real limit rather than a footnote: it removes
the shapes it knows and cannot promise a message is free of content. A workspace name, a project
title or a bare filename matches none of its patterns and will be sent. If your product promises
that crash reports are content-free *by construction*, you need an allowlist — `defaultRedaction`
or `redactExcept` — because no set of patterns can give you that. `redactPatterns` is for
applications that want their own diagnostics readable and are willing to review what they write.

It is not the default either, because changing what a crash reporter reports is worse than an
awkward default and this one has already moved once. A path containing spaces is redacted only
up to the first space, which still removes the user's name.

Group titles never depend on the message — they come from the error type and the top in-app
frame — so a redacted message costs you less than it appears to.

## Crash options

| Option | Purpose |
| --- | --- |
| `baseUrl`, `publishableKey`, `crashDatabaseId`, `release` | Required. A secret key or an empty release throws at `init`. |
| `build`, `channel`, `environment` | Reported with every envelope. `environment` defaults to `production`. |
| `sampleRate` | 0 to 1. |
| `enabled` | Start capturing or not. Default true. Flip it with `setEnabled`. |
| `beforeSend(envelope)` | Return the envelope, a changed one, or `null` to drop it. Asynchronous, so it cannot run on the fatal path. |
| `beforeSendSync(envelope)` | The same, synchronous, and the only hook that runs on the fatal path. Runs on every capture, before `beforeSend`. Define only this one and your filter covers uncaught exceptions too. |
| `onSent(sent, envelope)` | Once per accepted report, with the server's ids and the envelope that produced it. |
| `onDrop(reason, detail)` | Why a report was dropped. |
| `timeoutMs` | Per-request timeout. Default 20000. |
| `redaction(message)` | See above. |
| `appRoots` | Paths or URL prefixes that are your code. Derived per protocol when omitted — the origin over http, the document's directory under `file:` — by the exported `defaultAppRoots()`. Node and Electron main use the working directory and the app path. |
| `dedupe` | See above. |
| `queueSize`, `store` | The queue ceiling (at most 200) and where it lives. |
| `tags` | Attached to every event. |
| `allowedKinds`, `tagAllowlist` | Electron main only: what the IPC channel accepts from a renderer. |
| `ignoreRendererReasons`, `ignoreChildReasons` | Electron main only: exit reasons that are not crashes. Defaults `['clean-exit']` and `['clean-exit', 'killed']`. |
| `uncleanExit` | Electron main only: report a previous run that never quit cleanly. Off by default, packaged builds only. |
| `identity` | Attach the session ID of the shared [identity](#identity), and the installation ID while an analytics client is enabled. Default true; `false` sends exactly what 0.1.5 sent. Crash flags for crash-free sessions do not depend on it. |
| `random(bytes)` | Fills a buffer with random bytes, for a runtime without `crypto.getRandomValues`. React Native only needs it without a polyfill, and even then IDs are still unique. |
| `debug(message, detail)` | Receives warnings and transport events. Silent by default. |

---

# UX analytics

`inlet-sdk/analytics` sends named events to an **analytics database** (`adb_…`): what your
users do, sessions, retention, funnels and crash-free sessions per version, on your own
server. It needs a deployment whose `/v1/health` lists `analytics` (the event store is an
optional service; see the server's deployment guide). Until it does, events wait in the
queue and the SDK asks again every ten minutes, so collection starts by itself once your
operator turns analytics on.

**One identity for every module.** The crash, feedback and analytics modules of one
application share one installation, session and user ID only if they share storage: give
them **the same persistence directory on Node, and the same store on React Native**. In a
browser and in Electron they share it without you doing anything. See [Identity](#identity).

## Consent first

**An installation ID stored on a device generally requires consent in the European Union.
You decide the lawful basis of its collection.** So initialise the module disabled and turn
it on in your consent callback:

```ts
import * as analytics from 'inlet-sdk/analytics/browser';

analytics.init({
  baseUrl: 'https://inlet.example.com',
  publishableKey: 'ipk_…',
  analyticsDatabaseId: 'adb_…',
  app: { version: '1.4.0' },
  enabled: false, // nothing is stored or sent until consent
});

// In your consent banner's callback, once the person agrees (and at every start after):
analytics.setEnabled(true);

analytics.track('checkout_completed', { params: { plan: 'pro', items: 3 } });
analytics.screen('Checkout');
```

While disabled the module creates no installation, sends nothing, drops every `track` with
the reason `disabled`, and writes nothing to the device but its opt-out choice. Without
`enabled` at `init`, a stored opt-out applies; an explicit `enabled` overrides it.

When the person withdraws consent:

```ts
await analytics.setEnabled(false, { forget: true });
```

`forget` deletes the installation ID, the session ID, attribution and experiments, the
stored app version, crash flags not yet sent and the analytics queue, and removes the
installation ID from crash reports and feedback submissions still waiting to be sent. The
next `setEnabled(true)` begins a new installation. (Deleting what the server already holds
is an erasure, which an Admin runs from the project's settings.)

## One entry per runtime

| Entry | For | Keeps the identity and the queue |
| --- | --- | --- |
| `inlet-sdk/analytics/browser` | Web pages | Identity in `localStorage`, queue in IndexedDB |
| `inlet-sdk/analytics/electron` | The Electron main process (`installElectronMain`) | Files under `<userData>/inlet` |
| `inlet-sdk/analytics/electron-renderer` | Electron windows (`createElectronRenderer`) | Nothing: it forwards to main |
| `inlet-sdk/analytics/react-native` | React Native 0.74 or later | The store you inject, under 1 MB |
| `inlet-sdk/analytics/node` | Backends (server mode, the default) and command-line tools (device mode) | Memory in server mode; files under `persistenceDir` in device mode |
| `inlet-sdk/analytics` | Any other runtime with `fetch` | Memory, or the `store` you give it |

Every entry but the renderer exposes the same functions: `init`, `track`, `screen`,
`setUserId`, `setAttribution`, `setExperiment`, `setEnabled`, `reset`, `getInstallationId`,
`getSessionId`, `flush` and `close`. One analytics client and one identity serve the whole
application, whichever entry initialised them; a `track` before `init` warns once in the
console.

## Electron

The identity, the queue and the network live in the main process, so the publishable key
never reaches a window. Main, during `app.whenReady()`:

```ts
import { installElectronMain } from 'inlet-sdk/analytics/electron';

const analytics = await installElectronMain({
  baseUrl: 'https://inlet.example.com',
  publishableKey: 'ipk_…',
  analyticsDatabaseId: 'adb_…',
  enabled: false, // consent first, as above
});
// app.version defaults to app.getVersion(), app.id to app.getName(),
// the identity and the queue to <userData>/inlet.

analytics.setEnabled(true); // in your consent callback, here or in a window
analytics.track('export_finished', { params: { format: 'pdf' } });
```

Events report the platform `macos`, `windows` or `linux` with the version the operating
system reports through `process.getSystemVersion()` — macOS 15.1, not the kernel's 24.1.0 —
and the runtime `electron` with its version. The returned client is the one analytics
client; `analytics.uninstall()` takes its IPC listener off again (for hot reload and tests),
and `close()` stops it.

Preload, with context isolation on. Expose only the two analytics channels:

```ts
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('inletAnalytics', {
  send: (channel: string, message: unknown) => {
    if (channel === 'inlet:analytics') ipcRenderer.send(channel, message);
  },
  on: (channel: string, listener: (payload: unknown) => void) => {
    if (channel === 'inlet:analytics:ids') ipcRenderer.on(channel, (_event, payload) => listener(payload));
  },
});
```

Renderer:

```ts
import { createElectronRenderer } from 'inlet-sdk/analytics/electron-renderer';

const analytics = createElectronRenderer(); // uses window.inletAnalytics
analytics.screen('Settings');
analytics.track('theme_changed', { params: { theme: 'dark' } });
analytics.setUserId('u_123'); // after sign-in: crash reports and submissions carry it too
```

**What a window can do**: `track`, `screen`, `setUserId`, `setAttribution`, `setExperiment`,
`setEnabled` (with `forget`), `reset`, and `getInstallationId` and `getSessionId`, which
return what main last pushed (null until its first push, which answers as soon as the window
is created). **What it cannot do**: hold a key, make a request, or set anything main owns.
Main reads only an event's name, category, params and timestamp, bounds them, and adds the
installation and session IDs, the context and the app version itself, so a window running
remote content cannot forge them; the standard events (`app_started`, `session_crashed` and
the others) are the SDK's own and a window's attempt to send one is ignored. Sign-in and
consent usually happen in a window, so main applies a window's `setUserId`, `setAttribution`,
`setExperiment`, `setEnabled` and `reset` — the user ID being the one crash reports carry —
unless you install it with `acceptRendererIdentity: false`.

`inlet-sdk/analytics/electron-renderer` has no Node imports, so a renderer bundler takes it;
`inlet-sdk/analytics/browser` in a window is the wrong entry and says so through `debug`.

## React Native

React Native 0.74 or later. The entry takes React Native's modules and your store as
parameters and imports nothing, so it adds no native dependency you did not choose and
touches no browser global when loaded.

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import * as analytics from 'inlet-sdk/analytics/react-native';

analytics.init({
  baseUrl: 'https://inlet.example.com',
  publishableKey: 'ipk_…',
  analyticsDatabaseId: 'adb_…',
  app: { version: '1.4.0' }, // required: React Native cannot read it without a native module
  Platform,
  AppState,
  store: AsyncStorage, // the same store you give the crash and feedback modules
  enabled: false,
});

// In your consent callback:
analytics.setEnabled(true);
```

- **The store**: AsyncStorage, or a synchronous store such as MMKV behind the same three
  methods (see [React Native](#react-native-1) below for the MMKV adapter). The identity is
  kept in memory, read from the store before the first event — calls made before that wait
  for it — and written through; the queue is one event per key.
- **The byte budget**: what the module stores stays under `maxStoreBytes`, 1 MB by default.
  Past it your oldest events go first and the standard events last. With the crash module's
  2 MB and the feedback module's 1 MB that stays inside the 6 MB Android gives AsyncStorage
  by default, with room for a config module.
- **What an event says**: platform `ios` or `android`, the system version a person reads
  (`Platform.Version` on iOS, `Platform.constants.Release` on Android), the runtime
  `react-native` with its version, and the locale from `Intl`.
- **Sessions**: every process start begins one; the application coming back to the
  foreground after `sessionTimeoutMinutes` begins another. Moving to the background flushes.
- **IDs without `crypto`**: from `random` if you pass it, else `crypto.getRandomValues` where a
  polyfill provides it, else the SDK's own generator.
- **Crash-free sessions are best effort without a synchronous store.** The crash module
  writes its crash flag to its own store on the fatal path, and this module sends it as
  `session_crashed` at the next start. The write survives a crash that kills the JavaScript
  thread only when that store is synchronous. With AsyncStorage a crash that takes the
  process down at once may never be counted, and your crash-free rate reads high. **Give the
  crash module MMKV (or another synchronous store)** if you rely on that figure.

## Server mode and device mode

**Server mode** (the Node entry's default) is a backend reporting on behalf of its users.
No identity is kept, no standard event is sent, events carry the platform `server` and
count as background events (never as active installations), and every `track` must name
whose event it is, or it is dropped with the reason `missing-identity`:

```ts
import * as analytics from 'inlet-sdk/analytics/node';

analytics.init({ baseUrl, publishableKey, analyticsDatabaseId, app: { version: '2.3.0' } });
analytics.track('invoice_paid', { userId: user.id, params: { amount: 49 } });
```

**In a serverless function, `await analytics.flush()` before the handler returns.** The
queue is in memory there, and a frozen or recycled instance loses what it had not sent.

A server-mode `track` may also pass `installationId` (forwarded by your app from
`getInstallationId()`), `sessionId`, and `context` (`platform`, `os`, `runtime`, `locale`,
`country`).

**Device mode** (`mode: 'device'`, the default of every other entry) is an application on a
person's device: an installation, sessions and the standard events. On Node it is for a
command-line tool or a desktop application without Electron:

```ts
analytics.init({ baseUrl, publishableKey, analyticsDatabaseId, app: { version: '1.0.0' }, mode: 'device', persistenceDir: '/path/to/app-data/inlet' });
// …
await analytics.close(); // before a command-line tool exits, so its events are sent and saved
```

Give the crash and feedback modules the same directory, so all three share one
installation. The platform is `macos`, `windows` or `linux` with the version the system
reports, which on macOS is the kernel's (`24.1.0`); pass `os: { name: 'macOS', version: '15.1' }`
to report the product version. Node, Bun and Deno are detected (`runtime`). Where a runtime
permission refuses file or system access, the module keeps memory and leaves the version
out; when it cannot write the installation ID it says so through `debug` and marks its
events `ephemeral`.

## What gets sent

Exactly the fields of the analytics envelope and nothing else: an event ID (UUID v7), the
time, the name, an optional category, the installation ID, the user ID you set, the session
ID, your attribution and experiments, your params, the app version, build and ID, the
platform, the operating system and browser with their **major** versions (the full system
version outside browsers), the language, the environment, whether the identity is
ephemeral, and the SDK's name and version.

Params, attribution, experiments and the user ID are yours: the SDK sends them only when you
set them. The user-agent string, the page address, the referrer, the screen and anything
fingerprintable are never sent, and no high-entropy client hint is requested. Browsers now
freeze parts of the user-agent string (macOS 10.15.7, Windows 10.0, Android 10); those
versions say nothing about the device, so they are left out rather than reported wrongly.

Every event is checked against the server's own rules before it is queued, with the same
code the server runs. What the server would truncate is truncated; what it would refuse is
dropped here, through `onDrop(reason, detail)` with one of `disabled`, `bounds`,
`beforeSend`, `queue-full`, `refused` or `missing-identity`. `beforeSend(event)` runs
synchronously on every event, standard ones included, and may return it, a changed copy or
`null`; its result is checked again.

## Standard events and sessions

In device mode the module sends, unless `standardEvents` turns one off:

| Event | When | Params |
| --- | --- | --- |
| `app_installed` | The first enable for an installation | — |
| `app_updated` | The app version or build differs from the last run's | `previousVersion`, `previousBuild` |
| `app_started` | Each session start | `trigger` (`launch`, `resume`, `reset`), `crashReporting` |
| `session_crashed` | A crash ended a session (see below) | `kind`, `crashedAt` |
| `screen_viewed` | Only when you call `screen(name)` | `screen` |

`app_installed` is the first run the SDK saw: adding the SDK to an app already in use makes
every existing user a new installation on their first launch, so read cohorts from your
rollout date on. Turning `app_started` off leaves sessions, retention and crash-free sessions
without data.

A session ends after `sessionTimeoutMinutes` without activity (30 by default, 1 to 240) and
after 24 hours; activity is a `track`, a crash capture, a feedback submission, or the
application coming back to the foreground. `reset()` — for a sign-out — clears the user ID
and starts a new session, keeping the installation. In Electron, React Native and Node
device mode every process start begins a session with `trigger: 'launch'`.

**Several tabs.** Every tab of an origin shares one installation and one session. Opening a
new tab continues the session and sends nothing; the tab that notices the session expired
rotates it under a Web Lock, so exactly one `app_started` is sent. Where Web Locks are
unavailable (outside a secure context) the next session ID is derived from the expired one,
so tabs rotating at once agree on it. One tab at a time sends what every tab queued.

**Web identity has limits.** Browsers clear storage when the user asks, Safari removes
script-written storage after seven days without a visit, and a private window keeps nothing.
When `localStorage` is unavailable the module keeps the identity in memory for the page and
marks its events `ephemeral` (they count everywhere except new installations and cohorts);
when IndexedDB is unavailable it keeps the queue in memory for the page. It says either
through `debug`. Call `setUserId` after sign-in to follow signed-in people across devices.

## Attribution, experiments and the user ID

```ts
analytics.setUserId('u_123');                 // the same user ID the crash and feedback modules send
analytics.setAttribution('spring-campaign');  // sticky: every later event carries it
analytics.setExperiment('checkout', 'b');     // sticky, at most five
analytics.track('clicked', { attribution: 'newsletter', experiments: { checkout: 'c' } }); // this event only
```

Attribution and experiments are stored with the installation, so they survive a restart;
`null` clears one. The server keeps an installation's first attribution as its install
attribution, whatever you set later. A sixth experiment is refused with a `debug` message.

## Crash-free sessions

With the crash module in the same application, analytics measures crash-free sessions per
version. When the crash module captures a crash — an unhandled exception or rejection, a
native crash, an unclean exit, a renderer that died — it flags the session, synchronously
where storage allows, so a crash that kills the process is found at the next start; the
analytics module then sends `session_crashed` with the time of the crash, however long the
application stayed closed. The flag is raised after `beforeSendSync` (drop a report there
and it is not a crash) and before dedupe and sampling, so every crashing session counts once
even when its report is never sent — a report too large to send included. On React Native
this is best effort unless the crash module's store is synchronous (see
[React Native](#react-native) above).

In a browser, only an error whose stack has a frame in your own code counts, so a browser
extension's error does not. `app_started` reports `crashReporting: true` only when a crash
module is enabled **and at least one of the page's scripts lies within its `appRoots`**. If
your scripts are served from another origin — a CDN — pass it:

```ts
crash.init({ baseUrl, publishableKey, crashDatabaseId, release: '1.4.0', appRoots: [location.origin, 'https://cdn.example.com/app'] });
```

Otherwise that version reads as "not measured" rather than wrongly crash-free.

## Delivery

Events are written to the queue before they are sent and replayed on the next start. They
go in batches of up to `batchSize` (50) every `flushIntervalMs` (5 s in browsers, 10 s
elsewhere), at once when a full batch is queued, on `flush()`, and when a React Native
application goes to the background. When a page is hidden or closed the module sends what
fits in 60 KiB of `keepalive` requests (browsers allow 64 KiB per page); the rest waits for
the next page. A transport failure backs off exponentially with jitter; a `429`, or a `503`
with `Retry-After`, pauses analytics for that long — and only analytics: the crash module
keeps sending. An event the server answered, accepted or refused, is never sent again. Past
`queueSize` (1,000) the oldest of your events is dropped first, the standard events last.

**Size.** `inlet-sdk/analytics/browser` is 15.4 KB minified and gzipped, the event rules
included. The build fails past 20 KB.

## Analytics options

| Option | Purpose |
| --- | --- |
| `baseUrl`, `publishableKey`, `analyticsDatabaseId`, `app` | Required. `app` is `{ version, build?, id? }`; `id` tells apart the apps of one product. A secret key or an empty version throws at `init`. In Electron main `app` is optional: the application's version and name. |
| `enabled` | Collect or not. Default true, unless a stored opt-out applies. |
| `mode` | `device` or `server`. The Node entry defaults to `server`, the others to `device`. |
| `environment` | Defaults to `production`. |
| `userId`, `attribution`, `experiments` | Initial values of the calls above. |
| `standardEvents` | `{ app_installed, app_updated, app_started, session_crashed }`, each on by default. |
| `sessionTimeoutMinutes` | 30 by default, 1 to 240. |
| `flushIntervalMs`, `batchSize`, `queueSize` | 5000 in browsers or 10000; 50, at most 100; 1,000. |
| `beforeSend(event)` | Synchronous; return the event, a changed one, or `null`. |
| `onDrop(reason, detail)` | Every dropped event, with its reason. |
| `timeoutMs` | Per request. Default 20000. |
| `store` | The bare entry: a store for the identity and the queue (the crash module's `QueueStore` shape; synchronous `getSync`/`setSync` keep crash flags through a fatal crash). React Native: AsyncStorage or a synchronous store. |
| `persistenceDir`, `os` | Node device mode: where the identity and queue live; the OS to report. Electron main: `persistenceDir` only. |
| `acceptRendererIdentity` | Electron main: apply a window's identity and consent calls. Default true. |
| `Platform`, `AppState`, `maxStoreBytes` | React Native: the modules from `react-native`; the byte budget, 1 MB by default. |
| `fetch`, `random(bytes)`, `debug(message, detail)` | As in the other modules. |

`getInstallationId()` returns the installation ID — to forward to your backend, or to quote
in a data-subject request — or `null` while disabled and in server mode. `getSessionId()`
returns the current session ID or `null`.

---

# React Native

React Native 0.74 or later. The crash and feedback React Native entries take React Native's
modules and your storage as parameters and import nothing, so they add no native dependency
you did not choose, and they touch no browser global when loaded. The analytics entry is
described [with the rest of analytics](#react-native); give all three the same store.

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import * as crash from 'inlet-sdk/crash/react-native';
import * as feedback from 'inlet-sdk/feedback/react-native';

const inlet = { baseUrl: 'https://inlet.example.com', publishableKey: 'ipk_…' };

crash.init({ ...inlet, crashDatabaseId: 'cdb_…', release: '1.4.0', Platform, storage: AsyncStorage });
// ErrorUtils is React Native's global. The handler it replaces still runs afterwards.
const uninstall = crash.installReactNativeHandlers({ ErrorUtils, AppState });

feedback.init({ ...inlet, feedbackDatabaseId: 'fdb_…', storage: AsyncStorage });
```

- **The release is required**: React Native cannot read the app version without a native
  module, so pass it from your build configuration.
- **What a report says**: platform `other`, runtime `react-native` with its version, and
  `iOS` or `Android` with the version a person reads (on Android, `Platform.constants.Release`,
  not the API level in `Platform.Version`).
- **Frames**: Hermes stacks are parsed, and every frame from your JavaScript bundle —
  `index.android.bundle`, `main.jsbundle`, or the development server's `index.bundle` — is
  your code, reported by the bundle's name and never its path on the device.
- **The global handler**: an error reaching `ErrorUtils` is captured, written to the store,
  and then handed to the handler that was there before, so the red box in development
  and the crash in release are unchanged. A fatal error is reported unhandled; a
  non-fatal one, which the application survives, as handled.
- **Unhandled promise rejections** are observed through Hermes' tracker in release builds.
  Under `__DEV__` React Native already tracks them for LogBox and a second tracker would
  replace it, so the default is off there; `trackRejections: true` turns it on anyway.
- **Storage**: one report per key and at most 2 MB of crash reports, 1 MB of pending
  submissions (and 1 MB for analytics), oldest dropped first, adjustable with `maxStoreBytes`, so that the modules
  together stay inside the 6 MB Android gives AsyncStorage by default.
- **The fatal write** happens before the previous handler runs only when the store is
  synchronous. AsyncStorage is not, so with it the write is best effort: a crash that
  kills the JavaScript thread at once may lose its report. For a guarantee, give `storage`
  a synchronous store such as MMKV behind the same three methods:
  `{ getItem: (k) => mmkv.getString(k) ?? null, setItem: (k, v) => mmkv.set(k, v), removeItem: (k) => mmkv.delete(k) }`.
- **Flushes** when the application moves to the background.
- **Not observed**: native crashes, and there is no unclean-exit sentinel. A native crash
  summary you read at the next launch goes in `captureReport({ …, previousRun: true })`.
- **Screenshots** are the file descriptors an image picker returns, `{ uri, name, type, size? }`,
  uploaded through React Native's `FormData` with progress. Without `size` the size check
  happens on the server rather than before the upload. `useFeedbackSession` from
  `inlet-sdk/feedback/react` works unchanged.
- **IDs without `crypto`**: the SDK uses `crypto.getRandomValues` where a polyfill provides
  it, the `random` option if you pass one, and otherwise its own generator; fingerprints use
  the SDK's own SHA-256, which gives the server's exact result.
- **Metro** before React Native 0.79 does not read the package's `exports`. The package
  ships a directory per entry React Native imports, so the imports above resolve on 0.74
  with the default Metro configuration.

---

# Identity

The modules of one application share one identity, whatever entry initialised them:

| | What it is | Where it lives |
| --- | --- | --- |
| **Session ID** | A random, time-ordered UUID. A new one after 30 minutes without activity (the analytics module's `sessionTimeoutMinutes`), after 24 hours, and on every process start. A capture, a submission or a `track` is activity. | Memory; with analytics enabled in a browser, `localStorage`, shared by the origin's tabs |
| **User ID** | What you pass to `setUser(id)` or `setUserId(id)` in any module; `null` clears it. | Memory |
| **Installation ID** | A random UUID the analytics module creates at its first enable, kept until `forget`. Crash reports and submissions carry it **only while an analytics client is enabled**. | With analytics enabled: `localStorage`; `installation-id.json` under the persistence directory (`<userData>/inlet` in Electron); `inlet-sdk:installation-id` in the React Native store |

Without an enabled analytics client nothing is written to the device for the identity, the
unclean-exit sentinel included, and a page load begins a new session. With one, the identity
is stored under keys every module reads (`inlet-sdk:installation-id` and its siblings in
`localStorage` and in a React Native store; files of the same names on disk), so give every
module the same persistence directory on Node and the same store on React Native. In
Electron the main process holds it, and windows reach it through the renderer entries. While analytics is disabled the only thing written is its opt-out.

It is sent only to a deployment whose `/v1/health` lists `identity`; an older deployment gets
exactly the fields it has always accepted, so upgrading the SDK before the server loses no
report. A report about the previous run — the unclean-exit report, or
`captureReport({ …, previousRun: true })` — carries the session and installation IDs the
sentinel recorded for that run, which it records only while analytics is enabled, and
otherwise none.

In the server, reports and submissions keep these IDs so that you can filter crash groups
by session or installation, and see one respondent's crash beside their feedback.
`identity: false` on either module's `init` turns it off for that module: a crash report is
then exactly what 0.1.5 sent, the user ID from `setUser` included, and a submission carries
no identity field at all.

