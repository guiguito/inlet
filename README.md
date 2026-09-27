<div align="center">

<img src="apps/web/public/favicon.svg" width="64" height="64" alt="">

# Inlet

**Hear it. Catch it. Count it. Change it.**

The self-hosted place your apps report to: user feedback, crash reports, product analytics
and remote config, in one server and one SDK, joined per user, and run by your coding agent
over MCP.

[Quick start](#quick-start) ·
[Using it](docs/USING-INLET.md) ·
[Deploying it](docs/DEPLOYMENT.md) ·
[SDK](packages/sdk/README.md) ·
[API](docs/API.md) ·
[MCP](docs/MCP.md) ·
[Decisions](docs/DECISIONS.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-C2410C.svg)](LICENSE)
[![npm: inlet-sdk](https://img.shields.io/npm/v/inlet-sdk?label=inlet-sdk&color=C2410C)](https://www.npmjs.com/package/inlet-sdk)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-informational)

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/profile-dark.png">
  <img src="docs/screenshots/profile-light.png" alt="A user's profile in Inlet: their recent events grouped by session, beside the crash group and the feedback they sent" width="900">
</picture>

<sub>One person's usage, the crash they hit and the feedback they sent, on one page.</sub>

</div>

---

## Why Inlet

A small team ends up with four vendors: a feedback widget, a crash reporter, an analytics
suite and a feature-flag service. None of them knows it is the same user, each has its own
SDK and its own bill, and all of them hold your users' data.

Inlet is one of each, on your own server, sharing one identity. The feedback a user sends,
the crash they hit and what they did before it sit on the same page. The version that crashes
more shows up as a crash-free rate beside its retention. And the fix that cannot wait for an
app store review is a remote-config change you review, publish and roll back from the same
place.

Because every feature is also an MCP tool, your coding agent can do the whole loop with you.

## The loop

1. **Hear it.** Users tell you checkout is broken, from a form inside your app or a shared link.
2. **Catch it.** The crash is already grouped, tagged with the release that introduced it, and
   counted against crash-free sessions for that version.
3. **Count it.** The checkout funnel, split by version and platform, shows who it stops and how many.
4. **Change it.** Turn the new checkout off for that platform and version, without shipping a
   release. Then watch the funnel and the crash-free rate come back.

The same loop, asked in plain words to an agent connected to Inlet:

> **You:** Checkout conversion looks off since 1.5.0. What happened?
>
> **Claude:** *(reads `get_analytics_overview`, `list_crash_groups`, `run_analytics_funnel`, `list_submissions`)*
> Crash-free sessions fell from 99.6% on 1.4.2 to 96.7% on 1.5.0. The top crash group,
> `TypeError · handlePay (CheckoutScreen.tsx)`, is new in 1.5.0: 247 reports from 159 users,
> all on Android. Since the release, the Checkout funnel converts 26% on Android against 37% on
> iOS, and the latest feedback says why: *"The app closes when I tap Pay."* I can turn
> `new_checkout` off for Android on 1.5.0 until the fix ships; those users get the classic checkout.
>
> **You:** Do it.
>
> **Claude:** *(calls `set_config_condition`, `set_config_parameter`, `diff_config`, `publish_config`)*
> Published version 4, *"Turn off new checkout on Android 1.5.0 while we fix the tripId crash"*.
> Only Android installations on 1.5.0 are affected, and `new_checkout` is a live parameter, so
> they switch at their next fetch, without a restart.

<sub>An example session on the demo data in these screenshots. Every step is one of Inlet's
[MCP tools](docs/MCP.md).</sub>

## Four modules, one SDK

| | What it does | What it needs |
| --- | --- | --- |
| **Feedback** | Versioned forms, collected from your own interface in four calls or from a branded link Inlet hosts, with screenshots. An old answer keeps the labels its respondent saw. | PostgreSQL, S3 |
| **Crash reports** | Content-free reports grouped by fingerprint, so a crash loop is one line. Regressions per release, and one Slack message per new bug, not a thousand. | PostgreSQL |
| **Analytics** | The events your code names: active users, trends split by version or experiment, closed and open funnels with their trend, cohort retention, per-person profiles, crash-free sessions per version. Exact, never sampled. | ClickHouse, shipped in the same compose file and off until you enable it |
| **Remote config** | Typed flags, limits and JSON, with conditions, stable percentage rollouts and splits, published as reviewed, numbered versions you can roll back. The rules stay on your server. | PostgreSQL |

`inlet-sdk` has zero runtime dependencies and one entry per runtime for every module:
browsers, Electron, React Native and Node.

```ts
import * as crash from 'inlet-sdk/crash/browser';
import * as analytics from 'inlet-sdk/analytics/browser';
import * as feedback from 'inlet-sdk/feedback/browser';
import * as config from 'inlet-sdk/config/browser';

const inlet = { baseUrl: 'https://inlet.example.com', publishableKey: 'ipk_…' };

crash.init({ ...inlet, crashDatabaseId: 'cdb_…', release: '1.5.0' });
crash.installBrowserHandlers();
analytics.init({ ...inlet, analyticsDatabaseId: 'adb_…', app: { version: '1.5.0' }, enabled: false });
feedback.init({ ...inlet, feedbackDatabaseId: 'fdb_…' });
const remote = config.init({ ...inlet, databaseId: 'cfg_…', app: { version: '1.5.0' },
                             defaults: { new_checkout: true } });

onConsent(() => analytics.setEnabled(true));   // analytics waits for consent
analytics.setUserId('u_48213');                // one user ID for every module
if (remote.get('new_checkout')) showNewCheckout();
```

The publishable key is safe to ship: it sends data in and reads resolved config values,
and cannot read anything collected. See [packages/sdk](packages/sdk/README.md) for every
runtime, and [docs/API.md](docs/API.md) to call the HTTP API directly instead.

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-dark.png">
        <img src="docs/screenshots/overview-light.png" alt="Analytics Overview: active installations, retention, sessions and crash-free sessions, with a daily chart marking each release">
      </picture>
      <p align="center"><sub>Overview: who is active, how many come back, and when each version shipped</sub></p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-breakdown-dark.png">
        <img src="docs/screenshots/overview-breakdown-light.png" alt="Shares by app version, platform and country, the top events of the last 24 hours, and crash-free sessions per app version">
      </picture>
      <p align="center"><sub>Crash-free sessions per version, beside the version, platform and country shares</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/funnel-dark.png">
        <img src="docs/screenshots/funnel-light.png" alt="A checkout funnel split by platform, its conversion by week">
      </picture>
      <p align="center"><sub>Funnels, closed or open, and their conversion over time</sub></p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/cohort-dark.png">
        <img src="docs/screenshots/cohort-light.png" alt="The weekly Retention cohort table">
      </picture>
      <p align="center"><sub>Cohorts: who comes back, week after week</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/crash-group-dark.png">
        <img src="docs/screenshots/crash-group-light.png" alt="A crash group with its reports, affected users, releases and daily timeline">
      </picture>
      <p align="center"><sub>A crash group: one bug, its releases and its timeline</sub></p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/feedback-dark.png">
        <img src="docs/screenshots/feedback-light.png" alt="A feedback response with the app screenshot beside the answers and the SDK identity it carries">
      </picture>
      <p align="center"><sub>Feedback, with the screenshot beside the answers</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/config-dark.png">
        <img src="docs/screenshots/config-light.png" alt="A remote config change reviewed before it is published, with its note">
      </picture>
      <p align="center"><sub>Remote config: read the difference, then publish</sub></p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/config-preview-dark.png">
        <img src="docs/screenshots/config-preview-light.png" alt="The values a given platform, version and user would receive, and the conditions that decided them">
      </picture>
      <p align="center"><sub>Preview what any device or user receives, and why</sub></p>
    </td>
  </tr>
</table>

## How it compares

| | Inlet | Firebase | PostHog | One tool per job |
| --- | --- | --- | --- | --- |
| Runs on | Your server | Google's cloud | PostHog Cloud; self-hosting is discouraged | Mostly SaaS |
| Feedback forms | Versioned, in-app or hosted, with screenshots | — | Surveys | Canny, Userback |
| Crash reports | Grouped, with regressions per release | Crashlytics | Error tracking | Sentry |
| Product analytics | Trends, funnels, cohorts, profiles | Yes | Yes, and deeper | Amplitude, Mixpanel |
| Remote config and flags | Reviewed versions, rollouts, splits | Yes | Feature flags | LaunchDarkly, Unleash |
| One identity across all of it | Yes | Partly | Yes | No |
| Electron and Node | Yes | No | Node | Varies |
| An agent that reads and acts | MCP, 123 tools | — | MCP | Varies |
| What you run | One container, PostgreSQL, S3; ClickHouse for analytics | Nothing | Nothing, or ClickHouse, Kafka, Redis and PostgreSQL | Several products |
| Price | Free, MIT | Free | Free tier, then usage | Several bills |

Choose PostHog or Amplitude if you need session replay, paths and statistical tests;
Sentry if crashes are your main problem and you need symbolication; LaunchDarkly if you need
approvals and streaming flags. Choose Inlet when you want the four joined, on your own server,
and operable by an agent.

## Built to be trusted

- **Yours.** One container beside your PostgreSQL and your bucket. No telemetry, no
  phone-home, no vendor between you and your users.
- **Nothing you did not name.** No autocapture: no clicks, page addresses or session replay.
  Crash messages are redacted before they leave the device. The request address becomes a
  country and is discarded.
- **Consent first.** Every analytics snippet starts disabled and turns on in your consent
  callback. An Admin erases an installation or a user ID across every database of a project
  in one step.
- **Nothing lost, nothing doubled.** Submissions go through an intent with a documented retry
  contract, Slack notifications are queued in the same transaction as the data, and the SDK's
  queues survive restarts.
- **Versioned, not overwritten.** Published forms and config versions are immutable, so last
  year's answers read with last year's labels, and a bad config is one rollback away.
- **Exact numbers.** Analytics is never sampled, and every chart says which days it covers.
- **Every choice written down.** [DECISIONS.md](docs/DECISIONS.md) records what was built,
  why, what was rejected, and the bugs the tests found.

## What it is not

- **Not Amplitude:** no session replay, heatmaps, paths, formulas or significance tests.
- **Not Sentry:** no memory dumps and no symbolication; a report holds only what your code put in it.
- **Not LaunchDarkly:** apps poll for config rather than stream it, there are no approval
  workflows, and targeting is not access control. Anyone with your publishable key can ask for
  any user's values, so a parameter never holds a secret.
- **One instance.** Inlet runs as one API process; it does not cluster.
- **Consent still applies.** The analytics and config modules store an installation ID on the
  device, which in the European Union generally needs consent. You decide the lawful basis.

## Quick start

Requires Docker.

```bash
git clone https://github.com/guiguito/inlet.git
cd inlet
cp .env.example .env
```

Open `.env` and fill in the three placeholders it ships with — a session secret, and the
email and password for your first admin account:

```dotenv
INLET_SESSION_SECRET=<paste the output of: openssl rand -base64 48>
INLET_ADMIN_EMAIL=you@example.com
INLET_ADMIN_PASSWORD=<something long>
```

Then:

```bash
docker compose up -d --build
docker compose logs -f inlet     # wait for "Inlet is listening"
```

Open <http://localhost:3000>, sign in, and follow
[Your first form in five minutes](docs/USING-INLET.md#your-first-form-in-five-minutes), or
[Your first config in ten minutes](docs/USING-INLET.md#your-first-config-in-ten-minutes).

Analytics needs one more service, ClickHouse, which the same compose file ships behind a
profile:

```bash
docker compose --profile analytics up -d --build
```

Without it, everything else runs as before, and creating an analytics database says which
step enables it. See [Analytics](docs/DEPLOYMENT.md#analytics) for the host it needs, then
[Analytics databases](docs/USING-INLET.md#analytics-databases) to send your first events.

Before pointing real people at it, read the
[security checklist](docs/DEPLOYMENT.md#security-checklist) — it is nine lines and it
matters.

## Using it with Claude

Your deployment serves MCP at `/v1/mcp`. Point a client at it with a secret server key,
and there is nothing to install:

```bash
claude mcp add --transport http inlet https://inlet.example.com/v1/mcp \
  --header "Authorization: Bearer isk_your_secret_server_key"
```

The same tools also run as a local process, for a deployment your client cannot reach.
That server is not published to npm yet, so build it from this repository:

```bash
npm install && npm run build

claude mcp add inlet \
  --env INLET_URL=https://inlet.example.com \
  --env INLET_SECRET_KEY=isk_your_secret_server_key \
  -- node "$PWD/apps/mcp/dist/server.js"
```

Then ask in your own words: *"summarise this week's feedback for the mobile app and
group it by theme"*. Read-only tools are marked as such, and destructive ones make the agent
repeat the exact name of what it is about to delete. See [docs/MCP.md](docs/MCP.md).

## Documentation

| | |
| --- | --- |
| [USING-INLET.md](docs/USING-INLET.md) | For the person collecting feedback, triaging crashes, reading analytics and changing remote config. |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Configuration, reverse proxies, managed PostgreSQL and S3, the optional analytics event store, backups, upgrades. |
| [packages/sdk](packages/sdk/README.md) | `inlet-sdk` for integrators: every module and runtime, what is sent and what never is. |
| [API.md](docs/API.md) | The HTTP integration guide, with the retry contract in full. The interactive reference is at `/docs` on a running instance, and the OpenAPI document in [docs/openapi.json](docs/openapi.json). |
| [MCP.md](docs/MCP.md) | Every MCP tool and what it may do. |
| [PRD.md](docs/PRD.md) | The product requirements, split into [Foundations](docs/prd/foundations.md), [Feedback Collection](docs/prd/feedback-collection.md), [Crash Reports](docs/prd/crash-reports.md), [UX Analytics](docs/prd/ux-analytics.md) and [Remote Config](docs/prd/remote-config.md); cited by ID throughout the source. |
| [DECISIONS.md](docs/DECISIONS.md) | Every technical choice, its reasoning, and the rejected alternatives. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Running it for development, the test suites, the load tests and the repository layout. |

## Built with

Node.js 22 · Fastify 5 · Zod 4 · PostgreSQL · Drizzle ORM · ClickHouse · S3-compatible storage ·
sharp · React 19 · Vite · Tailwind 4 · TanStack Query · Vitest · Playwright

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For
anything security-related, please read [SECURITY.md](SECURITY.md) first rather than
opening a public issue.

## License

[MIT](LICENSE).
