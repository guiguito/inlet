import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createServer } from '../../apps/mcp/src/app.js';
import { E2E } from '../env';

/**
 * MCP access (FR-120 to FR-125), driven by a real MCP client.
 *
 * A real client over an in-memory transport, a real MCP server, and the real Inlet
 * HTTP API behind it. Nothing is mocked, so this proves the whole chain an agent
 * actually uses.
 */

const A = '0123456789abcdefghjkmnpqrstvwxyz';
const id = (prefix: string): string =>
  `${prefix}_${Array.from({ length: 12 }, () => A[Math.floor(Math.random() * A.length)]).join('')}`;

type Session = { client: Client; close: () => Promise<void> };

async function connect(secretKey: string): Promise<Session> {
  const server = createServer({ baseUrl: E2E.baseUrl, secretKey });
  const client = new Client({ name: 'inlet-mcp-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The text a tool returned, so an assertion reads what an agent would read. */
function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function parsed<T>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

/** A project with a published form and a secret server key, built over the API. */
async function fixture(request: APIRequestContext, name: string) {
  await request.post('/v1/auth/sign-in', {
    data: { email: E2E.adminEmail, password: E2E.adminPassword },
  });

  const project = await request.post('/v1/projects', { data: { name } });
  const projectId = (await project.json()).id as string;

  const database = await request.post(`/v1/projects/${projectId}/feedback-databases`, {
    data: { name: `${name} feedback` },
  });
  const databaseId = (await database.json()).id as string;

  const question = id('el');
  const definition = {
    pages: [
      {
        id: id('pg'),
        elements: [
          { id: id('el'), type: 'title', text: 'Tell us how it went' },
          {
            id: question,
            type: 'text',
            label: 'What should we fix first?',
            required: true,
            multiline: true,
            maxLength: 300,
          },
        ],
      },
    ],
  };

  const draft = await request.put(`/v1/feedback-databases/${databaseId}/form/draft`, {
    data: { definition },
  });
  await request.post(`/v1/feedback-databases/${databaseId}/form/publish`, {
    data: { expectedRevision: (await draft.json()).revision },
  });

  const secret = await request.post(`/v1/projects/${projectId}/credentials`, {
    data: { type: 'secret', label: 'Agent' },
  });

  return {
    projectId,
    databaseId,
    question,
    name,
    databaseName: `${name} feedback`,
    secretKey: (await secret.json()).secret as string,
  };
}

test.describe('the MCP server', () => {
  test('exposes the matrix operations and nothing beyond them (FR-121)', async ({ request }) => {
    const f = await fixture(request, 'MCP surface');
    const session = await connect(f.secretKey);

    try {
      const { tools } = await session.client.listTools();
      const names = tools.map((tool) => tool.name).sort();

      // Every tool the section 9.6 matrix marks for a secret server key.
      expect(names).toEqual(
        [
          'create_feedback_database',
          'create_submission_intent',
          'delete_feedback_database',
          'delete_project',
          'delete_submission',
          'export_submissions',
          'get_deletion_impact',
          'get_feedback_database',
          'get_form_draft',
          'get_project',
          'get_published_form',
          'get_screenshot',
          'get_submission',
          'invite_member',
          'list_feedback_databases',
          'list_form_versions',
          'list_invitations',
          'list_members',
          'list_projects',
          'list_submissions',
          'publish_form',
          'remove_member',
          'rename_feedback_database',
          'rename_project',
          'revoke_invitation',
          'rollback_form',
          'save_form_draft',
          'set_member_role',
          'submit_feedback',
          'unpublish_form',
        ].sort(),
      );

      // The matrix marks these unavailable to a key, or unsupported outright.
      for (const forbidden of [
        'create_project',
        'create_credential',
        'list_credentials',
        'rotate_credential',
        'revoke_credential',
        'edit_submission',
        'update_submission',
      ]) {
        expect(names, forbidden).not.toContain(forbidden);
      }

      // Reads are annotated as such, so a client can present them differently.
      const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
      expect(readOnly.length).toBeGreaterThan(10);

      // Every destructive tool says so, and asks for a confirmation.
      for (const name of [
        'delete_project',
        'delete_feedback_database',
        'delete_submission',
        'remove_member',
      ]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool?.annotations?.destructiveHint, name).toBe(true);
        expect(Object.keys(tool?.inputSchema.properties ?? {}), name).toContain('confirm');
      }
    } finally {
      await session.close();
    }
  });

  test('reads a project, its databases, and its published form', async ({ request }) => {
    const f = await fixture(request, 'MCP reads');
    const session = await connect(f.secretKey);

    try {
      const projects = parsed<{ id: string; role: string }[]>(
        await session.client.callTool({ name: 'list_projects', arguments: {} }),
      );
      // FR-123: exactly its own project, with Admin authority.
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({ id: f.projectId, role: 'admin' });

      const databases = parsed<{ id: string; name: string }[]>(
        await session.client.callTool({
          name: 'list_feedback_databases',
          arguments: { projectId: f.projectId },
        }),
      );
      expect(databases.map((d) => d.id)).toContain(f.databaseId);

      const form = parsed<{ formVersion: number; pages: unknown[] }>(
        await session.client.callTool({
          name: 'get_published_form',
          arguments: { databaseId: f.databaseId },
        }),
      );
      expect(form.formVersion).toBe(1);
      expect(form.pages).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  test('cannot reach outside its own project (FR-123)', async ({ request }) => {
    const mine = await fixture(request, 'MCP mine');
    const theirs = await fixture(request, 'MCP theirs');
    const session = await connect(mine.secretKey);

    try {
      for (const [name, args] of [
        ['get_project', { projectId: theirs.projectId }],
        ['list_feedback_databases', { projectId: theirs.projectId }],
        ['get_feedback_database', { databaseId: theirs.databaseId }],
        ['list_submissions', { databaseId: theirs.databaseId }],
        ['get_form_draft', { databaseId: theirs.databaseId }],
        ['export_submissions', { databaseId: theirs.databaseId, format: 'json' }],
      ] as const) {
        const result = await session.client.callTool({ name, arguments: args });
        expect(isError(result), name).toBe(true);
        expect(textOf(result), name).toMatch(/does not exist|not_found/);
      }
    } finally {
      await session.close();
    }
  });

  test('builds, publishes, rolls back and unpublishes a form', async ({ request }) => {
    const f = await fixture(request, 'MCP forms');
    const session = await connect(f.secretKey);

    try {
      const created = parsed<{ id: string }>(
        await session.client.callTool({
          name: 'create_feedback_database',
          arguments: { projectId: f.projectId, name: 'Built by an agent' },
        }),
      );

      const question = id('el');
      const definition = {
        pages: [
          {
            id: id('pg'),
            elements: [
              {
                id: question,
                type: 'choice',
                label: 'Did it work?',
                required: true,
                optionKind: 'text',
                selection: 'single',
                orientation: 'vertical',
                options: [
                  { id: id('op'), label: 'Yes' },
                  { id: id('op'), label: 'No' },
                ],
              },
            ],
          },
        ],
      };

      const draft = parsed<{ revision: number; problems: unknown[] }>(
        await session.client.callTool({
          name: 'save_form_draft',
          arguments: { databaseId: created.id, definition },
        }),
      );
      expect(draft.problems).toEqual([]);

      const published = parsed<{ version: number; active: boolean }>(
        await session.client.callTool({
          name: 'publish_form',
          arguments: { databaseId: created.id, expectedRevision: draft.revision },
        }),
      );
      expect(published).toMatchObject({ version: 1, active: true });

      // A stale revision is refused, and the message names the reason.
      const stale = await session.client.callTool({
        name: 'publish_form',
        arguments: { databaseId: created.id, expectedRevision: 0 },
      });
      expect(isError(stale)).toBe(true);
      expect(textOf(stale)).toContain('stale_draft_revision');

      // Publish a second version, then roll back.
      const second = parsed<{ revision: number }>(
        await session.client.callTool({
          name: 'save_form_draft',
          arguments: { databaseId: created.id, definition },
        }),
      );
      await session.client.callTool({
        name: 'publish_form',
        arguments: { databaseId: created.id, expectedRevision: second.revision },
      });

      const rolled = parsed<{ version: number }>(
        await session.client.callTool({
          name: 'rollback_form',
          arguments: { databaseId: created.id, version: 1 },
        }),
      );
      expect(rolled.version).toBe(1);

      await session.client.callTool({
        name: 'unpublish_form',
        arguments: { databaseId: created.id },
      });
      const afterUnpublish = parsed<{ activeFormVersion: number | null }>(
        await session.client.callTool({
          name: 'get_feedback_database',
          arguments: { databaseId: created.id },
        }),
      );
      expect(afterUnpublish.activeFormVersion).toBeNull();

      // The versions survive unpublishing.
      const versions = parsed<unknown[]>(
        await session.client.callTool({
          name: 'list_form_versions',
          arguments: { databaseId: created.id },
        }),
      );
      expect(versions).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  test('reads collected feedback with its raw contents (FR-122)', async ({ request }) => {
    const f = await fixture(request, 'MCP reading feedback');
    const session = await connect(f.secretKey);

    try {
      // Collect one response through MCP itself, which exercises the intent flow.
      const intent = parsed<{ intentId: string; token: string; formVersion: number }>(
        await session.client.callTool({
          name: 'create_submission_intent',
          arguments: { databaseId: f.databaseId },
        }),
      );

      const submitted = parsed<{ submissionId: string; status: string }>(
        await session.client.callTool({
          name: 'submit_feedback',
          arguments: {
            databaseId: f.databaseId,
            intentId: intent.intentId,
            token: intent.token,
            formVersion: intent.formVersion,
            answers: { [f.question]: { value: 'The agent found this' } },
            clientContext: { via: 'mcp' },
          },
        }),
      );
      expect(submitted.status).toBe('accepted');

      const listed = parsed<{ total: number; submissions: { id: string }[] }>(
        await session.client.callTool({
          name: 'list_submissions',
          arguments: { databaseId: f.databaseId },
        }),
      );
      expect(listed.total).toBe(1);

      const detail = parsed<{
        answers: Record<string, { value?: string }>;
        clientContext: unknown;
        observedIp: string | null;
        formDefinition: { pages: unknown[] };
      }>(
        await session.client.callTool({
          name: 'get_submission',
          arguments: { databaseId: f.databaseId, submissionId: submitted.submissionId },
        }),
      );

      expect(detail.answers[f.question]?.value).toBe('The agent found this');
      expect(detail.clientContext).toEqual({ via: 'mcp' });
      expect(detail.observedIp).toBeTruthy();
      // FR-065: the version's definition travels with the submission.
      expect(detail.formDefinition.pages).toHaveLength(1);

      const exported = textOf(
        await session.client.callTool({
          name: 'export_submissions',
          arguments: { databaseId: f.databaseId, format: 'csv' },
        }),
      );
      expect(exported).toContain('submission_id,submitted_at,form_version,observed_ip');
      expect(exported).toContain('The agent found this');
    } finally {
      await session.close();
    }
  });

  test('refuses a destructive write without the right confirmation', async ({ request }) => {
    const f = await fixture(request, 'MCP guards');
    const session = await connect(f.secretKey);

    try {
      const wrong = await session.client.callTool({
        name: 'delete_feedback_database',
        arguments: { databaseId: f.databaseId, confirm: 'something else' },
      });
      expect(isError(wrong)).toBe(true);
      expect(textOf(wrong)).toContain('Refusing to continue');

      // Still there.
      const stillThere = await session.client.callTool({
        name: 'get_feedback_database',
        arguments: { databaseId: f.databaseId },
      });
      expect(isError(stillThere)).toBe(false);

      const wrongProject = await session.client.callTool({
        name: 'delete_project',
        arguments: { projectId: f.projectId, confirm: 'MCP guard' },
      });
      expect(isError(wrongProject)).toBe(true);
      expect(textOf(wrongProject)).toContain('Refusing to continue');
    } finally {
      await session.close();
    }
  });

  test('deletes with the right confirmation, and reports the deletion to a retry', async ({
    request,
  }) => {
    const f = await fixture(request, 'MCP deletes');
    const session = await connect(f.secretKey);

    try {
      const intent = parsed<{ intentId: string; token: string; formVersion: number }>(
        await session.client.callTool({
          name: 'create_submission_intent',
          arguments: { databaseId: f.databaseId },
        }),
      );
      const payload = {
        databaseId: f.databaseId,
        intentId: intent.intentId,
        token: intent.token,
        formVersion: intent.formVersion,
        answers: { [f.question]: { value: 'About to be deleted' } },
      };
      const submitted = parsed<{ submissionId: string }>(
        await session.client.callTool({ name: 'submit_feedback', arguments: payload }),
      );

      const impact = parsed<{ submissions: number; notice: string }>(
        await session.client.callTool({
          name: 'get_deletion_impact',
          arguments: { databaseId: f.databaseId },
        }),
      );
      expect(impact.submissions).toBe(1);
      expect(impact.notice).toContain('Screenshot files are not included');

      const deleted = parsed<{ deleted: boolean }>(
        await session.client.callTool({
          name: 'delete_submission',
          arguments: {
            databaseId: f.databaseId,
            submissionId: submitted.submissionId,
            confirm: submitted.submissionId,
          },
        }),
      );
      expect(deleted.deleted).toBe(true);

      // FR-092G through MCP: the retry is told, not served.
      const retried = await session.client.callTool({
        name: 'submit_feedback',
        arguments: payload,
      });
      expect(isError(retried)).toBe(true);
      expect(textOf(retried)).toContain('submission_deleted');
      expect(textOf(retried)).not.toContain('About to be deleted');

      // And the whole feedback database goes with the right name.
      const removed = await session.client.callTool({
        name: 'delete_feedback_database',
        arguments: { databaseId: f.databaseId, confirm: f.databaseName },
      });
      expect(isError(removed)).toBe(false);
      expect(
        isError(
          await session.client.callTool({
            name: 'get_feedback_database',
            arguments: { databaseId: f.databaseId },
          }),
        ),
      ).toBe(true);
    } finally {
      await session.close();
    }
  });

  test('manages access, and keeps the last Admin (FR-014)', async ({ request, playwright }) => {
    const f = await fixture(request, 'MCP access');
    const session = await connect(f.secretKey);

    try {
      const invitation = parsed<{ token: string; url: string; role: string }>(
        await session.client.callTool({
          name: 'invite_member',
          arguments: { projectId: f.projectId, role: 'creator' },
        }),
      );
      expect(invitation.role).toBe('creator');
      expect(invitation.url).toContain('/invitations/');

      // Redeem it over HTTP the way a person would: from a context with no session,
      // because a signed-in redeemer attaches the invitation to their own account.
      const email = `agent-invited-${Date.now()}@example.com`;
      const invitee = await playwright.request.newContext({ baseURL: E2E.baseUrl });
      const redeemed = await invitee.post(`/v1/invitations/${invitation.token}/redeem`, {
        data: { email, password: 'a-long-enough-password' },
      });
      expect(redeemed.status()).toBe(200);
      const userId = (await redeemed.json()).id as string;
      await invitee.dispose();

      const members = parsed<{ userId: string; email: string; role: string }[]>(
        await session.client.callTool({
          name: 'list_members',
          arguments: { projectId: f.projectId },
        }),
      );
      expect(members.find((m) => m.userId === userId)?.role).toBe('creator');

      // Narrow them on one feedback database.
      const narrowed = parsed<{ role: string; inherited: boolean }>(
        await session.client.callTool({
          name: 'set_member_role',
          arguments: { databaseId: f.databaseId, userId, role: 'viewer' },
        }),
      );
      expect(narrowed).toMatchObject({ role: 'viewer', inherited: false });

      // Removing needs their email echoed.
      const wrongConfirm = await session.client.callTool({
        name: 'remove_member',
        arguments: { projectId: f.projectId, userId, confirm: 'someone@else.com' },
      });
      expect(isError(wrongConfirm)).toBe(true);

      const removed = await session.client.callTool({
        name: 'remove_member',
        arguments: { projectId: f.projectId, userId, confirm: email },
      });
      expect(textOf(removed), 'remove_member should have succeeded').not.toContain('code:');
      expect(isError(removed)).toBe(false);

      // FR-014: the remaining Admin cannot be removed.
      const admins = parsed<{ userId: string; email: string; role: string }[]>(
        await session.client.callTool({
          name: 'list_members',
          arguments: { projectId: f.projectId },
        }),
      );
      const lastAdmin = admins.find((m) => m.role === 'admin');
      const refused = await session.client.callTool({
        name: 'remove_member',
        arguments: {
          projectId: f.projectId,
          userId: lastAdmin?.userId,
          confirm: lastAdmin?.email,
        },
      });
      expect(isError(refused)).toBe(true);
      expect(textOf(refused)).toContain('last_admin_removal');
    } finally {
      await session.close();
    }
  });

  test('refuses a publishable key with a message that says why', async ({ request }) => {
    await request.post('/v1/auth/sign-in', {
      data: { email: E2E.adminEmail, password: E2E.adminPassword },
    });
    const project = await request.post('/v1/projects', { data: { name: 'MCP wrong key' } });
    const projectId = (await project.json()).id as string;
    const publishable = await request.post(`/v1/projects/${projectId}/credentials`, {
      data: { type: 'publishable', label: 'Web' },
    });
    const key = (await publishable.json()).secret as string;

    // The server refuses to start with one, rather than failing on the first call.
    const { loadConfig } = await import('../../apps/mcp/src/app.js');
    expect(() => loadConfig({ INLET_URL: E2E.baseUrl, INLET_SECRET_KEY: key })).toThrow(
      /must be a secret server key/,
    );
  });

  test('asks for exactly one scope where two would be ambiguous', async ({ request }) => {
    const f = await fixture(request, 'MCP scopes');
    const session = await connect(f.secretKey);

    try {
      const neither = await session.client.callTool({ name: 'list_members', arguments: {} });
      expect(isError(neither)).toBe(true);
      expect(textOf(neither)).toContain('projectId or databaseId');

      const both = await session.client.callTool({
        name: 'list_members',
        arguments: { projectId: f.projectId, databaseId: f.databaseId },
      });
      expect(isError(both)).toBe(true);
      expect(textOf(both)).toContain('not both');
    } finally {
      await session.close();
    }
  });

  test('reports an unreachable deployment instead of hanging', async () => {
    // A port nothing listens on.
    const server = createServer({
      baseUrl: 'http://127.0.0.1:1',
      secretKey: 'isk_whatever',
      timeoutMs: 2000,
    });
    const client = new Client({ name: 'inlet-mcp-test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({ name: 'list_projects', arguments: {} });
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('could not be reached');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
