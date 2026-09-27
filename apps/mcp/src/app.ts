import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InletClient, type ClientOptions } from './client.js';
import { registerTools } from './tools.js';

/**
 * Everything the client needs, including the optional `fetch` the API supplies when it
 * serves these same tools over Streamable HTTP (DECISIONS 27).
 */
export type McpConfig = ClientOptions;

/**
 * Reads and checks the configuration, with messages an operator can act on rather
 * than a stack trace on a missing variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv): McpConfig {
  const baseUrl = env.INLET_URL?.trim();
  const secretKey = env.INLET_SECRET_KEY?.trim();

  if (!baseUrl) {
    throw new Error('Set INLET_URL to your deployment, for example https://inlet.example.com');
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`INLET_URL is not a valid URL: ${baseUrl}`);
  }
  if (!secretKey) {
    throw new Error(
      'Set INLET_SECRET_KEY to a secret server key. Create one under a project’s API keys; it is shown once.',
    );
  }
  if (!secretKey.startsWith('isk_')) {
    // A publishable key would fail on the first call with insufficient_scope, which
    // is a confusing way to learn you pasted the wrong one.
    throw new Error(
      'INLET_SECRET_KEY must be a secret server key, which starts with "isk_". A publishable client key (ipk_) authorizes only the feedback flow.',
    );
  }

  const timeout = env.INLET_TIMEOUT_MS ? Number(env.INLET_TIMEOUT_MS) : undefined;
  return {
    baseUrl,
    secretKey,
    ...(timeout !== undefined && Number.isFinite(timeout) ? { timeoutMs: timeout } : {}),
  };
}

export function createServer(config: McpConfig): McpServer {
  const server = new McpServer(
    { name: 'inlet-mcp', version: '0.1.0' },
    {
      instructions: [
        'Inlet is a self-hosted feedback collector. This server acts with project Admin',
        'authority inside one project, the one its secret server key belongs to.',
        '',
        'Shape of the data: a project holds feedback databases; each feedback database is',
        'one form and the responses it collected. A form has an autosaved draft and any',
        'number of immutable published versions. Every submission records which version it',
        'was answered against, so read a submission with get_submission and it comes back',
        'with that version’s definition, letting you show the labels the respondent saw.',
        '',
        'Before deleting anything, read it first: the destructive tools require you to',
        'echo the exact name of what you are about to destroy. Exports never contain the',
        'screenshot files, only their URLs, so download anything worth keeping before',
        'deleting a feedback database.',
        '',
        'Submissions are immutable. There is no tool to edit one, and none to create a',
        'project or manage API keys, because a server key is not permitted those.',
        '',
        'A project can also hold crash databases (cdb_…), which collect crash reports from',
        'an application and group them by fingerprint. Triage with list_crash_groups, read a',
        'group and its timeline with get_crash_group, then update_crash_group_state to',
        'resolve it in a release; a report from a later release reopens it as a regression.',
        'Reports are immutable and expire under the database’s retention; groups and their',
        'counts do not. The shared tools for members, invitations, Slack settings and the',
        'deletion impact accept a crash database ID where they take a database ID.',
        '',
        'A project can also hold analytics databases (adb_…), which count how an application',
        'is used. An installation is one install of an app on one device or browser profile,',
        'with a random ID the SDK creates; it is the default unit of every unique count, and a',
        'user ID, which the integrator sets after sign-in, is the other. Every analytics',
        'answer covers the database’s storage window (13 months or 500 million events by',
        'default) and states the range it covers; a range preset such as last30Days ends',
        'today and includes it. Periods are calendar days, ISO weeks, months and years in the',
        'database’s reporting timezone, which never changes. While the event store is',
        'unreachable, analytics tools answer analytics_unavailable and everything else works.',
        'The shared tools accept an analytics database ID too.',
        'Read the catalog first with list_analytics_events: it is the tracking plan, each event',
        'and param with the team’s description. query_analytics_trends charts events by the',
        'metric each series names, a unique count counting each installation or user ID once per',
        'period, production events only unless a filter names an environment, the last 30 days',
        'by day unless a range says otherwise; a split by app version or an experiment compares',
        'versions or variants. A point is incomplete while its period is under way, or while',
        'the range covered holds only part of it. run_analytics_cohort groups units by the period',
        'they started in and reads who came back in each later one; the standard Retention cohort',
        '(installs, then app_started, by week) cannot be edited, but a run may change its',
        'granularity, range and population filters. Queries share a few slots: an',
        'analytics_busy answer means retry shortly, query_limit_exceeded a shorter range or a',
        'coarser interval.',
        'get_analytics_overview answers the home screen in one call. run_analytics_funnel finds',
        'where units stop (closed, a 7-day window from entry, by default), and',
        'list_analytics_funnel_units lists who dropped at a step, ready for get_analytics_profile,',
        'which links an installation or a user ID to the crash reports and submissions carrying',
        'it. To delete someone’s data, call preview_erasure first, then erase_identity with the ID',
        'repeated. get_analytics_storage says what the storage window keeps at the measured volume.',
        '',
        'A project can also hold config databases (cfg_…), which deliver remote configuration:',
        'named, typed parameters and the conditions that give them other values. A fetch returns',
        'resolved values only, never the rules or other contexts’ values. The evaluation rule:',
        'conditions are tested in priority order, and for each parameter the first true condition',
        'holding a value for it decides that value, else the parameter takes its default; a',
        'split assigns each unit one variant, and its control variant usually holds no value, so',
        'its units fall through to the next true condition holding a value, else to the default.',
        'Applications apply new values at their next launch, and at',
        'once for live parameters, a kill switch typically; the refresh interval is how often a',
        'running application fetches. Preview a change against a context before publishing it;',
        'publishing needs the draft revision you last read, so read the draft again after a',
        'stale_draft_revision. The shared tools accept a config database ID too.',
      ].join('\n'),
    },
  );

  registerTools(server, new InletClient(config));
  return server;
}
