import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  BRANDING_LIMITS,
  COLOR_SCHEMES,
  NOTIFICATION_LIMITS,
  SLACK_CONTENT_LEVELS,
  CORNER_RADII,
  EMBEDDING_MODES,
  TYPEFACES,
  formDefinitionSchema,
  hexColorSchema,
  originSchema,
  ROLES,
  slugSchema,
} from '@inlet/shared';
import { InletClient, InletError } from './client.js';

/**
 * The MCP tool surface (FR-120 to FR-125).
 *
 * FR-121 is the governing constraint: exactly the section 9.6 rows marked for a secret
 * server key, and no others. So there is deliberately no tool to create a project or
 * to touch project credentials, because the matrix marks both unavailable to keys, and
 * none to edit a submission, because FR-124 makes submissions immutable and section
 * 9.6 lists that row as unsupported for everyone.
 *
 * FR-122: responses carry the raw permitted data, including collected email addresses,
 * client context and stable authenticated screenshot URLs. An agent acting for a
 * project Admin is entitled to exactly what that Admin can see, so nothing is
 * redacted here that the API would have returned.
 *
 * Safeguards on destructive writes (PRD section 19, step 2): each one is annotated
 * `destructiveHint` and, more importantly, requires the caller to echo the name of the
 * thing being destroyed. An agent following a vague instruction cannot delete a
 * project without having first read its name, and a mistyped identifier fails closed.
 */

const projectId = z.string().describe('The project identifier, like prj_5waxfxyby3st.');
const databaseId = z
  .string()
  .describe('The feedback database identifier, like fdb_n8b3mj3axdfh.');
const submissionId = z.string().describe('The submission identifier, like sub_bzq1whs3129d.');
const userId = z.string().describe('The account identifier, like usr_bz33m9801wz9.');
const roleArg = z.enum(ROLES).describe('admin, creator or viewer.');

/** JSON in a text block, which is what an agent can actually read. */
function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Turns an API failure into something an agent can act on.
 *
 * The stable error code goes in the message on purpose: an agent that sees
 * `form_not_published` can publish the form, where "the request failed" leaves it
 * guessing.
 */
function describe(error: unknown): CallToolResult {
  if (error instanceof InletError) {
    const detail =
      error.details === undefined ? '' : `\n\n${JSON.stringify(error.details, null, 2)}`;
    return failure(`${error.message}\n\ncode: ${error.code} (HTTP ${error.status})${detail}`);
  }
  return failure(error instanceof Error ? error.message : String(error));
}

/** Wraps every handler, so no tool crashes the transport on a failed request. */
function guard(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return handler().catch(describe);
}

/**
 * The confirmation a destructive tool demands: the caller must echo the exact name of
 * what it is about to destroy.
 */
function assertConfirmed(expected: string, given: string): void {
  if (given.trim() === expected) return;
  throw new InletError(
    400,
    'confirmation_mismatch',
    `Refusing to continue. This is named "${expected}", but the confirmation said "${given.trim()}". Read the resource first, then pass its exact name.`,
  );
}

export function registerTools(server: McpServer, client: InletClient): void {
  // --- Reading ------------------------------------------------------------

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'The project this key belongs to. A secret server key reaches exactly one project (FR-083), so this returns one entry.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => json(await client.request('GET', '/v1/projects'))),
  );

  server.registerTool(
    'get_project',
    {
      title: 'Read a project',
      description: 'Its name, your role on it, and how many feedback databases it holds.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId: id }) =>
      guard(async () => json(await client.request('GET', `/v1/projects/${id}`))),
  );

  server.registerTool(
    'list_feedback_databases',
    {
      title: 'List feedback databases',
      description:
        'Every feedback database in a project, with its published form version and how many responses it holds.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId: id }) =>
      guard(async () =>
        json(await client.request('GET', `/v1/projects/${id}/feedback-databases`)),
      ),
  );

  server.registerTool(
    'get_feedback_database',
    {
      title: 'Read a feedback database',
      inputSchema: { databaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ databaseId: id }) =>
      guard(async () => json(await client.request('GET', `/v1/feedback-databases/${id}`))),
  );

  server.registerTool(
    'get_published_form',
    {
      title: 'Read the published form',
      description:
        'The active published definition a client would render, in authored order. Fails with form_not_published when there is none.',
      inputSchema: { databaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ databaseId: id }) =>
      guard(async () => json(await client.request('GET', `/v1/feedback-databases/${id}/form`))),
  );

  server.registerTool(
    'get_form_draft',
    {
      title: 'Read the form draft',
      description:
        'The autosaved draft, its revision, and the problems that stop it being published. Pass the revision to publish_form to be refused if it has moved since.',
      inputSchema: { databaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ databaseId: id }) =>
      guard(async () =>
        json(await client.request('GET', `/v1/feedback-databases/${id}/form/draft`)),
      ),
  );

  server.registerTool(
    'list_form_versions',
    {
      title: 'List published form versions',
      description: 'Newest first. Published versions are immutable.',
      inputSchema: { databaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ databaseId: id }) =>
      guard(async () =>
        json(await client.request('GET', `/v1/feedback-databases/${id}/form/versions`)),
      ),
  );

  server.registerTool(
    'list_submissions',
    {
      title: 'List submissions',
      description:
        'Newest first, keyset-paginated. Carries raw answers including any collected email address, the observed IP and the client context (FR-122). Follow nextCursor until it is null.',
      inputSchema: {
        databaseId,
        limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
        cursor: z.string().optional().describe('The nextCursor from a previous call.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ databaseId: id, limit, cursor }) =>
      guard(async () => {
        const params = new URLSearchParams();
        if (limit !== undefined) params.set('limit', String(limit));
        if (cursor) params.set('cursor', cursor);
        const query = params.size > 0 ? `?${params.toString()}` : '';
        return json(
          await client.request('GET', `/v1/feedback-databases/${id}/submissions${query}`),
        );
      }),
  );

  server.registerTool(
    'get_submission',
    {
      title: 'Read one submission',
      description:
        'Includes the definition of the form version it was answered against, so answers can be read with the labels the respondent actually saw (FR-065), and the stable authenticated URL of each screenshot.',
      inputSchema: { databaseId, submissionId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ databaseId: id, submissionId: submission }) =>
      guard(async () =>
        json(
          await client.request('GET', `/v1/feedback-databases/${id}/submissions/${submission}`),
        ),
      ),
  );

  server.registerTool(
    'export_submissions',
    {
      title: 'Export submissions',
      description:
        'Every submission as JSON or CSV. Contains data only: screenshot files are never bundled, only their URLs (FR-112).',
      inputSchema: {
        databaseId,
        format: z.enum(['json', 'csv']).default('json'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ databaseId: id, format }) =>
      guard(async () =>
        text(
          await client.text(
            `/v1/feedback-databases/${id}/submissions/export?format=${format ?? 'json'}`,
          ),
        ),
      ),
  );

  server.registerTool(
    'get_screenshot',
    {
      title: 'Download a screenshot',
      description:
        'The image itself, as WebP. The URL is stable but every request is authorized afresh (FR-069).',
      inputSchema: {
        attachmentId: z.string().describe('The attachment identifier, like att_f28s3688z9b3.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ attachmentId }) =>
      guard(async () => {
        const image = await client.bytes(`/v1/attachments/${attachmentId}`);
        return {
          content: [
            {
              type: 'image',
              data: image.data.toString('base64'),
              mimeType: image.mediaType,
            },
          ],
        };
      }),
  );

  server.registerTool(
    'get_deletion_impact',
    {
      title: 'Check what deleting a feedback database would destroy',
      description:
        'How many responses and screenshots would go. Read this before delete_feedback_database.',
      inputSchema: { databaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ databaseId: id }) =>
      guard(async () =>
        json(await client.request('GET', `/v1/feedback-databases/${id}/deletion-impact`)),
      ),
  );

  // --- Access -------------------------------------------------------------

  server.registerTool(
    'list_members',
    {
      title: 'List who has access',
      description:
        'Members of a project, or of one feedback database with the effective role of FR-071 resolved for each. Pass exactly one of projectId or databaseId.',
      inputSchema: {
        projectId: projectId.optional(),
        databaseId: databaseId.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId: project, databaseId: database }) =>
      guard(async () => {
        const path = scopePath(project, database, 'members');
        return json(await client.request('GET', path));
      }),
  );

  server.registerTool(
    'list_invitations',
    {
      title: 'List invitations',
      description:
        'Pending, redeemed, revoked and expired invitations at one scope. Pass exactly one of projectId or databaseId.',
      inputSchema: {
        projectId: projectId.optional(),
        databaseId: databaseId.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId: project, databaseId: database }) =>
      guard(async () => json(await client.request('GET', scopePath(project, database, 'invitations')))),
  );

  server.registerTool(
    'invite_member',
    {
      title: 'Invite someone',
      description:
        'Creates a single-use expiring link for a role at a scope, and returns it. Inlet sends no email: pass the link on yourself. Pass exactly one of projectId or databaseId.',
      inputSchema: {
        role: roleArg,
        projectId: projectId.optional(),
        databaseId: databaseId.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ role, projectId: project, databaseId: database }) =>
      guard(async () =>
        json(await client.request('POST', scopePath(project, database, 'invitations'), { role })),
      ),
  );

  server.registerTool(
    'set_member_role',
    {
      title: 'Change someone’s role',
      description: [
        'With projectId, changes their project role. Downgrading the last Admin is refused (FR-014).',
        'With databaseId, assigns a role on that feedback database only, overriding their project role (FR-071). Refused for a project Admin, whose access cannot be narrowed (FR-071A).',
      ].join('\n'),
      inputSchema: {
        userId,
        role: roleArg,
        projectId: projectId.optional(),
        databaseId: databaseId.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ userId: user, role, projectId: project, databaseId: database }) =>
      guard(async () => {
        if (project) {
          return json(
            await client.request('PATCH', `/v1/projects/${project}/members/${user}`, { role }),
          );
        }
        if (database) {
          return json(
            await client.request('PUT', `/v1/feedback-databases/${database}/members/${user}`, {
              role,
            }),
          );
        }
        throw scopeRequired();
      }),
  );

  // --- Forms --------------------------------------------------------------

  server.registerTool(
    'create_feedback_database',
    {
      title: 'Create a feedback database',
      description: 'One logical form and the responses it will collect. Starts with an empty draft.',
      inputSchema: { projectId, name: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectId: id, name }) =>
      guard(async () =>
        json(await client.request('POST', `/v1/projects/${id}/feedback-databases`, { name })),
      ),
  );

  server.registerTool(
    'rename_project',
    {
      title: 'Rename a project',
      inputSchema: { projectId, name: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId: id, name }) =>
      guard(async () => json(await client.request('PATCH', `/v1/projects/${id}`, { name }))),
  );

  server.registerTool(
    'rename_feedback_database',
    {
      title: 'Rename a feedback database',
      description: 'The identifier never changes, so integrated clients keep working.',
      inputSchema: { databaseId, name: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ databaseId: id, name }) =>
      guard(async () =>
        json(await client.request('PATCH', `/v1/feedback-databases/${id}`, { name })),
      ),
  );

  server.registerTool(
    'save_form_draft',
    {
      title: 'Replace the form draft',
      description: [
        'Writes the whole definition and increments its revision. Read the draft first: this replaces it rather than merging.',
        '',
        'A page holds one ordered list of elements, so content can sit before, between or after questions. Element types: title, subtitle, body_text, choice, text, email, screenshot.',
      ].join('\n'),
      inputSchema: {
        databaseId,
        definition: formDefinitionSchema.describe('The complete form definition.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ databaseId: id, definition }) =>
      guard(async () =>
        json(
          await client.request('PUT', `/v1/feedback-databases/${id}/form/draft`, { definition }),
        ),
      ),
  );

  server.registerTool(
    'publish_form',
    {
      title: 'Publish the draft',
      description:
        'Creates an immutable version from the current draft and makes it active. Pass expectedRevision from get_form_draft to be refused if the draft moved since you read it. Submission intents already issued keep their pinned version (FR-042G).',
      inputSchema: {
        databaseId,
        expectedRevision: z
          .number()
          .int()
          .optional()
          .describe('The revision you last read. Recommended.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ databaseId: id, expectedRevision }) =>
      guard(async () =>
        json(
          await client.request(
            'POST',
            `/v1/feedback-databases/${id}/form/publish`,
            expectedRevision === undefined ? {} : { expectedRevision },
          ),
        ),
      ),
  );

  server.registerTool(
    'unpublish_form',
    {
      title: 'Unpublish the active version',
      description:
        'Blocks client retrieval and new submissions. Versions and existing responses are untouched, and any submission already in progress still completes (FR-042F).',
      inputSchema: { databaseId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ databaseId: id }) =>
      guard(async () =>
        json(await client.request('POST', `/v1/feedback-databases/${id}/form/unpublish`)),
      ),
  );

  server.registerTool(
    'rollback_form',
    {
      title: 'Reactivate an earlier version',
      description: 'Defaults to the most recent version that is not already active.',
      inputSchema: {
        databaseId,
        version: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ databaseId: id, version }) =>
      guard(async () =>
        json(
          await client.request(
            'POST',
            `/v1/feedback-databases/${id}/form/rollback`,
            version === undefined ? {} : { version },
          ),
        ),
      ),
  );

  // --- Collecting, for testing a form end to end --------------------------

  server.registerTool(
    'create_submission_intent',
    {
      title: 'Open a submission intent',
      description:
        'A short-lived authorization to submit one response, pinned to one published version. Useful for checking a form works. Screenshot upload is not exposed over MCP because it needs a binary body; use the HTTP endpoint for that.',
      inputSchema: {
        databaseId,
        formVersion: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ databaseId: id, formVersion }) =>
      guard(async () =>
        json(
          await client.request(
            'POST',
            `/v1/feedback-databases/${id}/submission-intents`,
            formVersion === undefined ? {} : { formVersion },
          ),
        ),
      ),
  );

  server.registerTool(
    'submit_feedback',
    {
      title: 'Finalize a submission intent',
      description: [
        'Submits a complete response in one call. Answers are keyed by stable question ID:',
        '',
        'single-select choice: {"optionId": "op_…"}',
        'multi-select choice:  {"optionIds": ["op_…"]}',
        'text or email:        {"value": "…"}',
        '',
        'Repeating this with the same payload returns the original result; a different payload is a conflict.',
      ].join('\n'),
      inputSchema: {
        databaseId,
        intentId: z.string().describe('From create_submission_intent.'),
        token: z.string().describe('From create_submission_intent.'),
        formVersion: z.number().int().min(1).describe('Must equal the intent’s pinned version.'),
        answers: z.record(z.string(), z.unknown()).describe('Answers keyed by question ID.'),
        clientContext: z.unknown().optional().describe('Arbitrary JSON, at most 16 KiB.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ databaseId: id, intentId, token, formVersion, answers, clientContext }) =>
      guard(async () =>
        // The intent token is a second factor beside the key, so it travels as its own
        // header exactly as a browser client would send it.
        json(
          await client.finalize(
            `/v1/feedback-databases/${id}/submission-intents/${intentId}/submit`,
            token,
            {
              formVersion,
              answers,
              ...(clientContext === undefined ? {} : { clientContext }),
            },
          ),
        ),
      ),
  );

  // --- Destructive, each requiring the name to be echoed ------------------

  server.registerTool(
    'delete_submission',
    {
      title: 'Permanently delete one submission',
      description:
        'Deletes its answers, any collected email address, and its screenshots. Pass the submission ID again as confirm. If the original client retries its submission afterwards it is told the response was deleted, not given a new one (FR-092G).',
      inputSchema: {
        databaseId,
        submissionId,
        confirm: z.string().describe('Repeat the submissionId to confirm.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ databaseId: id, submissionId: submission, confirm }) =>
      guard(async () => {
        assertConfirmed(submission, confirm);
        return json(
          await client.request(
            'DELETE',
            `/v1/feedback-databases/${id}/submissions/${submission}`,
          ),
        );
      }),
  );

  server.registerTool(
    'delete_feedback_database',
    {
      title: 'Permanently delete a feedback database',
      description:
        'Deletes its form, every published version, every response and every screenshot. Read get_deletion_impact first, and export anything worth keeping: screenshots are not in an export. Pass the feedback database’s exact name as confirm.',
      inputSchema: {
        databaseId,
        confirm: z.string().describe('The feedback database’s exact name.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ databaseId: id, confirm }) =>
      guard(async () => {
        const database = await client.request<{ name: string }>(
          'GET',
          `/v1/feedback-databases/${id}`,
        );
        assertConfirmed(database.name, confirm);
        return json(await client.request('DELETE', `/v1/feedback-databases/${id}`));
      }),
  );

  server.registerTool(
    'delete_project',
    {
      title: 'Permanently delete a project',
      description:
        'Deletes every feedback database, form version, response, screenshot and API key it contains, including the key you are using. Pass the project’s exact name as confirm.',
      inputSchema: { projectId, confirm: z.string().describe('The project’s exact name.') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ projectId: id, confirm }) =>
      guard(async () => {
        const project = await client.request<{ name: string }>('GET', `/v1/projects/${id}`);
        assertConfirmed(project.name, confirm);
        return json(await client.request('DELETE', `/v1/projects/${id}`));
      }),
  );

  server.registerTool(
    'remove_member',
    {
      title: 'Remove someone’s access',
      description: [
        'With projectId, removes them from the project and drops their feedback-database assignments inside it. Removing the last Admin is refused (FR-014).',
        'With databaseId, clears their assignment on that database only; they keep whatever their project role gives them.',
        '',
        'Pass their email address as confirm.',
      ].join('\n'),
      inputSchema: {
        userId,
        confirm: z.string().describe('The member’s exact email address.'),
        projectId: projectId.optional(),
        databaseId: databaseId.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ userId: user, confirm, projectId: project, databaseId: database }) =>
      guard(async () => {
        const members = await client.request<{ userId: string; email: string }[]>(
          'GET',
          scopePath(project, database, 'members'),
        );
        const member = members.find((entry) => entry.userId === user);
        if (!member) {
          throw new InletError(404, 'not_found', 'That person has no access at this scope.');
        }
        assertConfirmed(member.email, confirm);
        return json(await client.request('DELETE', scopePath(project, database, `members/${user}`)));
      }),
  );

  server.registerTool(
    'revoke_invitation',
    {
      title: 'Revoke an unredeemed invitation',
      description: 'The link stops working. An invitation already redeemed cannot be revoked.',
      inputSchema: {
        invitationId: z.string(),
        projectId: projectId.optional(),
        databaseId: databaseId.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ invitationId, projectId: project, databaseId: database }) =>
      guard(async () =>
        json(
          await client.request(
            'POST',
            scopePath(project, database, `invitations/${invitationId}/revoke`),
          ),
        ),
      ),
  );

  // --- The hosted form (FR-151) -------------------------------------------

  server.registerTool(
    'get_hosted_form',
    {
      title: 'Read the hosted form',
      description:
        'The public link for a feedback database, its branding, its wording and its embedding rules. Reading it creates a disabled hosted form with a generated address if there was none, so this is safe to call to find out what the address would be. The hosted form is a second way to collect, beside the client API; both can be used at once.',
      inputSchema: { databaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ databaseId: id }) =>
      guard(async () =>
        json(await client.request('GET', `/v1/feedback-databases/${id}/hosted-form`)),
      ),
  );

  server.registerTool(
    'update_hosted_form',
    {
      title: 'Update the hosted form',
      description:
        'Enables or disables collection through the link, and sets the address, the branding, the wording and the embedding rules. Only the fields you pass change. Branding is presentation only: it cannot change what is asked, what is validated or what is stored.',
      inputSchema: {
        databaseId,
        enabled: z
          .boolean()
          .optional()
          .describe('Whether the link collects responses. Disabling keeps every setting.'),
        slug: slugSchema
          .optional()
          .describe(
            'A custom address, lowercase letters, digits and hyphens. Changing it stops the previous link working.',
          ),
        accentColor: hexColorSchema
          .optional()
          .describe('A hex colour like #C2410C. The readable text colour on it is derived.'),
        colorScheme: z.enum(COLOR_SCHEMES).optional(),
        cornerRadius: z.enum(CORNER_RADII).optional(),
        typeface: z.enum(TYPEFACES).optional(),
        logoAlt: z
          .string()
          .max(BRANDING_LIMITS.logoAltMaxLength)
          .nullable()
          .optional()
          .describe('How the logo reads to a screen reader. Upload the logo itself through the API or the interface.'),
        submitLabel: z.string().max(BRANDING_LIMITS.submitLabelMaxLength).optional(),
        thankYouTitle: z.string().max(BRANDING_LIMITS.thankYouTitleMaxLength).optional(),
        thankYouBody: z.string().max(BRANDING_LIMITS.thankYouBodyMaxLength).optional(),
        closedMessage: z
          .string()
          .max(BRANDING_LIMITS.closedMessageMaxLength)
          .optional()
          .describe('Shown when the link is disabled or no version is published.'),
        redirectUrl: z
          .string()
          .url()
          .nullable()
          .optional()
          .describe('Where to send a respondent after a successful submission. Null shows the thank-you message instead.'),
        showProgress: z.boolean().optional(),
        embedding: z
          .enum(EMBEDDING_MODES)
          .optional()
          .describe('anywhere, listed or nowhere. Enforced by the browser through the page\u2019s own headers.'),
        allowedOrigins: z
          .array(originSchema)
          .max(BRANDING_LIMITS.allowedOriginsMax)
          .optional()
          .describe('Origins allowed to frame the page when embedding is "listed", like https://app.example.com.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ databaseId: id, ...patch }) =>
      guard(async () => {
        const body = Object.fromEntries(
          Object.entries(patch).filter(([, value]) => value !== undefined),
        );
        if (Object.keys(body).length === 0) {
          throw new InletError(
            400,
            'validation_failed',
            'Pass at least one setting to change.',
          );
        }
        return json(
          await client.request('PATCH', `/v1/feedback-databases/${id}/hosted-form`, body),
        );
      }),
  );

  server.registerTool(
    'rotate_hosted_form_address',
    {
      title: 'Change the hosted form address',
      description:
        'Issues a new address and retires the current one immediately. Every shared link and embedded frame using the old address stops working, which is the point: this is how a leaked link is revoked. Confirm with the current address.',
      inputSchema: {
        databaseId,
        confirm: z
          .string()
          .describe('The current address, exactly as get_hosted_form reports its slug.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ databaseId: id, confirm }) =>
      guard(async () => {
        const current = (await client.request(
          'GET',
          `/v1/feedback-databases/${id}/hosted-form`,
        )) as { slug: string };
        assertConfirmed(current.slug, confirm);
        return json(
          await client.request(
            'POST',
            `/v1/feedback-databases/${id}/hosted-form/rotate-slug`,
          ),
        );
      }),
  );

  // --- Slack notifications (FR-167) ---------------------------------------

  server.registerTool(
    'get_slack_notifications',
    {
      title: 'Read the Slack notification settings',
      description:
        'Whether a feedback database posts to Slack when a response arrives, and how the message is shaped. The webhook URL itself is never returned in full: only whether one is saved and a masked hint. Also reports the last delivery, the last Slack error, and how many notifications gave up.',
      inputSchema: { databaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ databaseId: id }) =>
      guard(async () =>
        json(await client.request('GET', `/v1/feedback-databases/${id}/slack-notifications`)),
      ),
  );

  server.registerTool(
    'update_slack_notifications',
    {
      title: 'Update the Slack notification settings',
      description:
        'Switches notifications on or off and shapes the message. Only the fields you pass change.\n\nThe webhook URL is deliberately not settable here. A secret server key can already read and export everything, but a webhook it installed would keep delivering after the key was revoked, so installing one requires a signed-in person. Ask the operator to paste the URL on the Notify tab, then use this to configure the rest.',
      inputSchema: {
        databaseId,
        enabled: z
          .boolean()
          .optional()
          .describe('Cannot be switched on until a webhook URL has been saved by a person.'),
        contentLevel: z
          .enum(SLACK_CONTENT_LEVELS)
          .optional()
          .describe(
            'How much of a response the message carries. "link_only" sends no answer content at all. "answers" sends the answers but withholds any collected email address. "answers_with_email" sends the address too. Slack keeps its own copy of whatever is sent, and deleting a response in Inlet does not remove a message already delivered, so raising this level is a decision to make with the operator rather than for them.',
          ),
        messageTitle: z
          .string()
          .max(NOTIFICATION_LIMITS.messageTitleMaxLength)
          .nullable()
          .optional()
          .describe('Replaces the default heading. May contain Slack mention syntax such as <!here>.'),
        channel: z
          .string()
          .nullable()
          .optional()
          .describe(
            'A channel like #feedback or a person like @someone. Honoured by legacy custom integration webhooks and silently ignored by Slack app webhooks.',
          ),
        username: z.string().nullable().optional(),
        iconEmoji: z.string().nullable().optional().describe('An emoji name like :inbox_tray:.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ databaseId: id, ...patch }) =>
      guard(async () => {
        const body = Object.fromEntries(
          Object.entries(patch).filter(([, value]) => value !== undefined),
        );
        if (Object.keys(body).length === 0) {
          throw new InletError(400, 'validation_failed', 'Pass at least one setting to change.');
        }
        return json(
          await client.request('PATCH', `/v1/feedback-databases/${id}/slack-notifications`, body),
        );
      }),
  );

  server.registerTool(
    'send_slack_test_message',
    {
      title: 'Send a test message to Slack',
      description:
        'Posts a real message into the operator\u2019s Slack channel, using the saved settings, and reports what Slack said. The content is placeholder text rather than a real response. This is the only tool here that reaches a third party and the only one whose effect other people see, so it asks for the feedback database\u2019s name as confirmation.',
      inputSchema: {
        databaseId,
        confirm: z
          .string()
          .describe('The feedback database\u2019s exact name, as get_feedback_database reports it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ databaseId: id, confirm }) =>
      guard(async () => {
        const database = (await client.request('GET', `/v1/feedback-databases/${id}`)) as {
          name: string;
        };
        assertConfirmed(database.name, confirm);
        return json(
          await client.request('POST', `/v1/feedback-databases/${id}/slack-notifications/test`),
        );
      }),
  );
}

/** Every scoped operation takes exactly one of the two scopes. */
function scopePath(
  project: string | undefined,
  database: string | undefined,
  suffix: string,
): string {
  if (project && database) {
    throw new InletError(
      400,
      'validation_failed',
      'Pass either projectId or databaseId, not both. A project scope covers every feedback database in it.',
    );
  }
  if (project) return `/v1/projects/${project}/${suffix}`;
  if (database) return `/v1/feedback-databases/${database}/${suffix}`;
  throw scopeRequired();
}

function scopeRequired(): InletError {
  return new InletError(
    400,
    'validation_failed',
    'Pass either projectId or databaseId to say which scope you mean.',
  );
}
