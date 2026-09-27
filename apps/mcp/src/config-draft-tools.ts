import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InletClient, InletError } from './client.js';

/**
 * The Remote Config draft tools (PRD section 8.3, RC-090): read, replace, the per-part
 * changes, reshuffle, validate, import and the exports. Each is one HTTP request to the
 * routes of `apps/api/src/routes/config-draft.ts`, so an agent can do what a secret key can.
 */

const configDatabaseId = z.string().describe('The config database identifier, like cfg_9rdayr4rstbv.');
const conditionId = z.string().describe('The condition ID: cnd_ followed by 1 to 32 lower-case letters and digits, like cnd_beta.');
const source = z
  .union([z.enum(['draft', 'active']), z.int().min(1)])
  .default('draft')
  .describe('draft (default), active, or a version number.');

/** RC-090: what every draft tool's description states. */
const RULE =
  'Evaluation: conditions are taken in priority order, and for each parameter the first true condition that holds a value for it decides it; a split gives a value only for the variant it assigned the unit, so a split’s control variant usually holds no value and control units fall through to the next condition or the default; with no such condition the default applies. Targeting is not access control: anyone with the publishable key can ask for the values of any user.';
const PUBLISH = 'Every change returns the new `revision`; publishing needs the revision you last read, so read or keep it before publishing.';
const PROBLEMS = 'A change the save checks refuse fails with config_template_invalid, each problem with its path; the answer lists `problems` publishing would still refuse and `warnings` against the active version.';

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}
function describe(error: unknown): CallToolResult {
  if (error instanceof InletError) {
    const detail = error.details === undefined ? '' : `\n\n${JSON.stringify(error.details, null, 2)}`;
    return { content: [{ type: 'text', text: `${error.message}\n\ncode: ${error.code} (HTTP ${error.status})${detail}` }], isError: true };
  }
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
}
function guard(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return handler().catch(describe);
}

const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const read = { readOnlyHint: true, openWorldHint: false } as const;

export function registerConfigDraftTools(server: McpServer, client: InletClient): void {
  const draft = (id: string) => `/v1/config-databases/${id}/draft`;

  server.registerTool(
    'get_config_draft',
    {
      title: 'Read the config draft',
      description: `The draft's template (parameters, and conditions in priority order, the first the highest), its \`revision\`, who changed it last, the \`problems\` publishing would refuse, the \`warnings\` against the active version, whether it differs from the active version and by how many changes, and \`conditionUsage\`: per condition, the parameters holding a value under it. ${RULE} ${PUBLISH}`,
      inputSchema: { configDatabaseId },
      annotations: read,
    },
    async ({ configDatabaseId: id }) => guard(async () => json(await client.request('GET', draft(id)))),
  );

  server.registerTool(
    'save_config_draft',
    {
      title: 'Replace the whole config draft',
      description: `Replaces the whole draft with a template {parameters: [...], conditions: [...]}. Prefer the per-part tools (set_config_parameter, set_config_condition…), which leave the rest of the draft as it is, so two agents or people editing different parameters never overwrite each other; this one is last-write-wins unless you pass expectedRevision. A condition may omit its id; the server always draws the salt, and an existing condition keeps its stored one. ${PROBLEMS} ${RULE} ${PUBLISH}`,
      inputSchema: {
        configDatabaseId,
        template: z.object({ parameters: z.array(z.record(z.string(), z.unknown())), conditions: z.array(z.record(z.string(), z.unknown())) }),
        expectedRevision: z.int().min(0).optional().describe('Refuse with stale_draft_revision if the draft moved past it.'),
      },
      annotations: { ...write, idempotentHint: true },
    },
    async ({ configDatabaseId: id, ...body }) => guard(async () => json(await client.request('PUT', draft(id), body))),
  );

  server.registerTool(
    'set_config_parameter',
    {
      title: 'Create or replace one config parameter',
      description: `Creates the parameter with this key, or replaces it in place. \`type\` is string, number, boolean or json, and every value must be of it; \`default\` is what a context receives when no condition gives it another; \`conditional\` lists {condition, value} or, for a split, {condition, variant, value}; \`live: true\` makes applications apply a change as soon as they fetch it (a kill switch). Keys match ^[A-Za-z][A-Za-z0-9_.-]{0,127}$. ${PROBLEMS} ${RULE} ${PUBLISH}`,
      inputSchema: {
        configDatabaseId,
        key: z.string().describe('The parameter key, like new_checkout.'),
        type: z.enum(['string', 'number', 'boolean', 'json']),
        default: z.unknown().describe('The default value, of the parameter’s type.'),
        description: z.string().max(500).optional(),
        live: z.boolean().optional(),
        schema: z.unknown().optional().describe('json only: a JSON Schema (2020-12, no pattern or patternProperties) every value must satisfy at publish.'),
        conditional: z.array(z.object({ condition: z.string(), variant: z.string().optional(), value: z.unknown() })).optional(),
      },
      annotations: { ...write, idempotentHint: true },
    },
    async ({ configDatabaseId: id, key, ...parameter }) =>
      guard(async () => json(await client.request('PUT', `${draft(id)}/parameters/${encodeURIComponent(key)}`, parameter))),
  );

  server.registerTool(
    'delete_config_parameter',
    {
      title: 'Delete one config parameter',
      description: `Removes the parameter from the draft (config_parameter_not_found if absent). Once published, applications that read it use their in-app default; validate_config_draft warns of it. ${PUBLISH}`,
      inputSchema: { configDatabaseId, key: z.string() },
      annotations: { ...write, destructiveHint: true },
    },
    async ({ configDatabaseId: id, key }) => guard(async () => json(await client.request('DELETE', `${draft(id)}/parameters/${encodeURIComponent(key)}`))),
  );

  server.registerTool(
    'set_config_condition',
    {
      title: 'Create or replace one config condition',
      description: `Creates the condition with this ID (you choose it; appended at the lowest priority) or replaces it in place. kind "match": 1 to 10 rules, all must be true, e.g. {attribute: "appVersion", operator: "versionGte", value: "1.4.0"} or {attribute: "percentage", operator: "lt", value: 1000} (hundredths of a percent: 10%). kind "split": 0 to 10 population rules, 2 to 5 variants {key, weight} with weights summing to 10000, an experiment key and a unit (installation or user). The server draws and keeps the salt; reshuffle_config_condition changes it. ${PROBLEMS} ${RULE} ${PUBLISH}`,
      inputSchema: {
        configDatabaseId,
        conditionId,
        name: z.string().min(1).max(64),
        kind: z.enum(['match', 'split']),
        rules: z.array(z.object({ attribute: z.string(), operator: z.string(), value: z.unknown().optional(), unit: z.enum(['installation', 'user']).optional() })),
        experiment: z.string().optional().describe('split only.'),
        unit: z.enum(['installation', 'user']).optional().describe('split only.'),
        variants: z.array(z.object({ key: z.string(), weight: z.int() })).optional().describe('split only.'),
      },
      annotations: { ...write, idempotentHint: true },
    },
    async ({ configDatabaseId: id, conditionId: cid, ...condition }) =>
      guard(async () => json(await client.request('PUT', `${draft(id)}/conditions/${encodeURIComponent(cid)}`, condition))),
  );

  server.registerTool(
    'delete_config_condition',
    {
      title: 'Delete one config condition',
      description: `Removes the condition and every conditional value naming it; the answer's \`affectedParameters\` lists the parameters that held one. To see them before deleting, read get_config_draft's \`conditionUsage\`. ${PUBLISH}`,
      inputSchema: { configDatabaseId, conditionId },
      annotations: { ...write, destructiveHint: true },
    },
    async ({ configDatabaseId: id, conditionId: cid }) => guard(async () => json(await client.request('DELETE', `${draft(id)}/conditions/${encodeURIComponent(cid)}`))),
  );

  server.registerTool(
    'reorder_config_conditions',
    {
      title: 'Set the config conditions’ priority order',
      description: `Lists every condition ID of the draft exactly once, the highest priority first (else config_condition_order_mismatch). Order decides which true condition gives a parameter its value. ${RULE} ${PUBLISH}`,
      inputSchema: { configDatabaseId, order: z.array(z.string()) },
      annotations: { ...write, idempotentHint: true },
    },
    async ({ configDatabaseId: id, order }) => guard(async () => json(await client.request('PUT', `${draft(id)}/conditions/order`, { order }))),
  );

  server.registerTool(
    'reshuffle_config_condition',
    {
      title: 'Draw a new salt for a config condition',
      description: `Once published, every unit's bucket for this condition changes: a percentage rollout reaches different installations or users, and a split reassigns its variants. Confirm with the user first. ${PUBLISH}`,
      inputSchema: { configDatabaseId, conditionId },
      annotations: write,
    },
    async ({ configDatabaseId: id, conditionId: cid }) => guard(async () => json(await client.request('POST', `${draft(id)}/conditions/${encodeURIComponent(cid)}/reshuffle`))),
  );

  server.registerTool(
    'validate_config_draft',
    {
      title: 'Check the config draft as publishing would',
      description: `The \`problems\` publishing the current revision would refuse (values failing their schema, conditional values naming no condition or variant, weights not summing to 10000, answers past 512 KiB…), each with its path, and the \`warnings\` against the active version (a parameter removed or changing type, whose readers will use their in-app default). Publishes nothing. ${PUBLISH}`,
      inputSchema: { configDatabaseId },
      annotations: read,
    },
    async ({ configDatabaseId: id }) => guard(async () => json(await client.request('POST', `${draft(id)}/validate`))),
  );

  server.registerTool(
    'import_config_template',
    {
      title: 'Import a template into the config draft',
      description: `Replaces the draft with a template export ({format: 1, parameters, conditions}, as export_config_template gives it), keeping its condition IDs and salts so units fall in the same buckets as in the database it came from: the way to promote staging to production. ${PROBLEMS} ${PUBLISH}`,
      inputSchema: {
        configDatabaseId,
        template: z.object({ format: z.literal(1), parameters: z.array(z.record(z.string(), z.unknown())), conditions: z.array(z.record(z.string(), z.unknown())) }),
      },
      annotations: write,
    },
    async ({ configDatabaseId: id, template }) => guard(async () => json(await client.request('POST', `${draft(id)}/import`, template))),
  );

  server.registerTool(
    'export_config_template',
    {
      title: 'Export a config template',
      description: 'The template of the draft, the active version or a numbered version, as JSON with `format: 1`, which import_config_template takes back into any config database.',
      inputSchema: { configDatabaseId, source },
      annotations: read,
    },
    async ({ configDatabaseId: id, source: from }) => guard(async () => text(await client.text(`/v1/config-databases/${id}/export?source=${from}&format=json`))),
  );

  server.registerTool(
    'export_config_defaults',
    {
      title: 'Export a config’s defaults for application code',
      description: 'Each parameter’s default value, as TypeScript (`ts`, the default: a type and a `configDefaults` object to pass to the SDK’s init) or as JSON (`json`), from the draft, the active version or a numbered version. The in-app defaults are what an application uses before its first fetch, offline, and when nothing is published.',
      inputSchema: { configDatabaseId, source, format: z.enum(['ts', 'json']).default('ts') },
      annotations: read,
    },
    async ({ configDatabaseId: id, source: from, format }) =>
      guard(async () => text(await client.text(`/v1/config-databases/${id}/export?source=${from}&format=${format === 'ts' ? 'ts' : 'defaults'}`))),
  );
}
