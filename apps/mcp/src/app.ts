import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InletClient } from './client.js';
import { registerTools } from './tools.js';

export type McpConfig = { baseUrl: string; secretKey: string; timeoutMs?: number };

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
      ].join('\n'),
    },
  );

  registerTools(server, new InletClient(config));
  return server;
}
