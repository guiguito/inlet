# inlet-sdk

The client SDK for [Inlet](../../README.md), the self-hosted place your applications
report to. Two modules:

- **`inlet-sdk/feedback`** collects a form's answers from inside your own interface.
- **`inlet-sdk/crash`** reports application failures.

Zero runtime dependencies, ESM and CommonJS, Node 18 or later and evergreen browsers. Each
module has a Node, browser, Electron and React entry.

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
the viewport, cookies, timing, or any identifier. A hosted form records operational
context because it *is* the client; this is a library inside somebody else's client and
records nothing on its own.

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
| `redactPatterns` | Redacts by *pattern* instead: paths, email addresses, URLs, IP addresses and long opaque tokens become markers and the sentence around them survives. The right default for most application code. |
| `redactExcept([/^…/])` | Your own safe shapes verbatim; everything else as `defaultRedaction`. |
| `keepMessages` | Everything verbatim. For applications that know their messages carry no user data. |

```ts
import { keepMessages, redactExcept, redactPatterns } from 'inlet-sdk/crash';

init({ ..., redaction: redactPatterns });
// 'Wallet sync failed after 3 retries'           -> unchanged
// '/Users/alice/secret.docx could not be opened' -> '<path> could not be opened'
```

`redactPatterns` is not the default because changing what a crash reporter reports is worse
than an awkward default, and this one has already moved once. A path containing spaces is
redacted only up to the first space, which still removes the user's name.

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
| `appRoots` | Paths or URL prefixes that are your code. Adapters detect a default. |
| `dedupe` | See above. |
| `queueSize`, `store` | The queue ceiling (at most 200) and where it lives. |
| `tags` | Attached to every event. |
| `allowedKinds`, `tagAllowlist` | Electron main only: what the IPC channel accepts from a renderer. |
| `ignoreRendererReasons`, `ignoreChildReasons` | Electron main only: exit reasons that are not crashes. Defaults `['clean-exit']` and `['clean-exit', 'killed']`. |
| `uncleanExit` | Electron main only: report a previous run that never quit cleanly. Off by default, packaged builds only. |
| `debug(message, detail)` | Receives warnings and transport events. Silent by default. |
