# inlet-sdk

The client SDK for [Inlet](../../README.md), the self-hosted feedback collector. This
release ships one module, `inlet-sdk/crash`, which reports application failures to a
crash database on your own Inlet. Zero runtime dependencies, ESM and CommonJS, Node 18 or
later and evergreen browsers.

If you have never seen Inlet: an Inlet **project** holds databases and owns two kinds of
API key. A **publishable key** (`ipk_…`) can only send data in and is safe to ship in an
application. A **crash database** (`cdb_…`) receives failure reports and groups them into
one row per distinct bug, so that a crash loop is one line and one Slack message. The
server's side of this is described in [docs/USING-INLET.md](../../docs/USING-INLET.md#crash-reports);
the wire format in [docs/API.md](../../docs/API.md#crash-reports).

## Install

```
npm install inlet-sdk
```

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

Preload script, so a renderer can reach that channel with context isolation on:

```ts
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('inletCrash', {
  send: (channel: string, envelope: unknown) => ipcRenderer.send(channel, envelope),
});
```

Renderer:

```ts
import { installElectronRenderer } from 'inlet-sdk/crash/electron';
import { createErrorBoundary } from 'inlet-sdk/crash/react';
import React from 'react';

const renderer = installElectronRenderer(); // uses window.inletCrash.send
const ErrorBoundary = createErrorBoundary(React, (report) => renderer.captureReport(report));
```

A renderer never holds the key or a queue; everything goes through main.

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
application parsed from a minidump on the next launch (`kind: 'native'`), a sidecar that
exited (`kind: 'child-exit'`), an unclean-exit sentinel. You build the block for the kind;
the SDK fills in the release, environment, system, user and tags.

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

## Options

| Option | Purpose |
| --- | --- |
| `baseUrl`, `publishableKey`, `crashDatabaseId`, `release` | Required. A secret key or an empty release throws at `init`. |
| `build`, `channel`, `environment` | Reported with every envelope. `environment` defaults to `production`. |
| `sampleRate` | 0 to 1. |
| `beforeSend(envelope)` | Return the envelope, a changed one, or `null` to drop it. Not run on the fatal path. |
| `redaction(message)` | See above. |
| `appRoots` | Paths or URL prefixes that are your code. Adapters detect a default. |
| `dedupe` | See above. |
| `queueSize`, `store` | The queue ceiling (at most 200) and where it lives. |
| `tags` | Attached to every event. |
| `debug(message, detail)` | Receives warnings and transport events. Silent by default. |
