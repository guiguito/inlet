import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createServer } from '../../apps/mcp/src/app.js';
import { E2E } from '../env';

/**
 * Crash Reports through MCP (CR-060, CR-061, journey 5.3): a real MCP client, a real
 * server, the real API behind it. An agent lists open groups, reads one with its
 * breakdowns and a report, resolves it in a release, and is refused the destructive
 * tools without the exact confirmation.
 */

type Session = { client: Client; close: () => Promise<void> };

async function connect(secretKey: string): Promise<Session> {
  const server = createServer({ baseUrl: E2E.baseUrl, secretKey });
  const client = new Client({ name: 'inlet-mcp-crash-test', version: '0.1.0' });
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

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
}
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;
const parsed = <T>(result: unknown): T => JSON.parse(textOf(result)) as T;

async function fixture(request: APIRequestContext, name: string) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const project = await request.post('/v1/projects', { data: { name } });
  const projectId = (await project.json()).id as string;
  const secret = await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'secret', label: 'agent' } });
  const publishable = await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } });
  return { projectId, secretKey: (await secret.json()).secret as string, publishableKey: (await publishable.json()).secret as string };
}

async function report(request: APIRequestContext, databaseId: string, key: string, version: string, sessionId?: string) {
  const response = await request.post(`/v1/crash-databases/${databaseId}/reports`, {
    headers: { authorization: `Bearer ${key}` },
    data: {
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sdk: { name: 'e2e', version: '1' },
      kind: 'exception',
      release: { version },
      os: { name: 'Windows', arch: 'x64' },
      ...(sessionId ? { sessionId } : {}),
      exception: { type: 'RangeError', message: 'Maximum call stack size exceeded', handled: false, frames: [{ function: 'render', file: 'ui.js', inApp: true }] },
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { groupId: string; isRegression: boolean };
}

test('an agent triages a crash group end to end', async ({ request }) => {
  const f = await fixture(request, `Crash MCP ${Date.now()}`);
  const session = await connect(f.secretKey);
  try {
    const created = await session.client.callTool({ name: 'create_crash_database', arguments: { projectId: f.projectId, name: 'Agent app' } });
    expect(isError(created), textOf(created)).toBe(false);
    const database = parsed<{ id: string; type: string; retention: { maxReports: number } }>(created);
    expect(database.id).toMatch(/^cdb_/);
    expect(database.type).toBe('crash');

    const sessionId = crypto.randomUUID();
    for (let i = 0; i < 3; i += 1) await report(request, database.id, f.publishableKey, '2.0.0', i === 0 ? sessionId : undefined);

    const listed = parsed<{ groups: { id: string; count: number; exceptionType: string }[]; total: number }>(
      await session.client.callTool({ name: 'list_crash_groups', arguments: { crashDatabaseId: database.id, state: 'open', sort: 'lastSeen' } }),
    );
    expect(listed.total).toBe(1);
    expect(listed.groups[0]).toMatchObject({ count: 3, exceptionType: 'RangeError' });
    const groupId = listed.groups[0]!.id;

    const detail = parsed<{ byRelease: { version: string; count: number }[]; byOs: { os: string; count: number }[]; timeline: { days: unknown[] } }>(
      await session.client.callTool({ name: 'get_crash_group', arguments: { crashDatabaseId: database.id, groupId, days: 7 } }),
    );
    expect(detail.byRelease).toEqual([{ version: '2.0.0', count: 3 }]);
    expect(detail.byOs).toEqual([{ os: 'Windows', count: 3 }]);
    expect(detail.timeline.days).toHaveLength(7);

    const reports = parsed<{ reports: { id: string; envelope: { exception: { type: string } } }[] }>(
      await session.client.callTool({ name: 'list_crash_reports', arguments: { crashDatabaseId: database.id, groupId, limit: 5 } }),
    );
    expect(reports.reports).toHaveLength(3);
    const one = parsed<{ envelope: { exception: { type: string } } }>(
      await session.client.callTool({ name: 'get_crash_report', arguments: { crashDatabaseId: database.id, reportId: reports.reports[0]!.id } }),
    );
    expect(one.envelope.exception.type).toBe('RangeError');

    // CR-118: the identity is on the report, and both list tools filter by it.
    const bySession = parsed<{ total: number }>(
      await session.client.callTool({ name: 'list_crash_groups', arguments: { crashDatabaseId: database.id, sessionId } }),
    );
    expect(bySession.total).toBe(1);
    const sessionReports = parsed<{ reports: { id: string; sessionId: string }[] }>(
      await session.client.callTool({ name: 'list_crash_reports', arguments: { crashDatabaseId: database.id, groupId, sessionId } }),
    );
    expect(sessionReports.reports).toHaveLength(1);
    const withIdentity = parsed<{ sessionId: string; installationId: string | null }>(
      await session.client.callTool({ name: 'get_crash_report', arguments: { crashDatabaseId: database.id, reportId: sessionReports.reports[0]!.id } }),
    );
    expect(withIdentity).toMatchObject({ sessionId, installationId: null });

    const resolved = parsed<{ state: string; resolvedInRelease: string }>(
      await session.client.callTool({
        name: 'update_crash_group_state',
        arguments: { crashDatabaseId: database.id, groupIds: [groupId], change: { state: 'resolved', resolvedInRelease: '2.0.0' } },
      }),
    );
    expect(resolved).toMatchObject({ state: 'resolved', resolvedInRelease: '2.0.0' });
    expect((await report(request, database.id, f.publishableKey, '2.0.1')).isRegression).toBe(true);

    const releases = parsed<{ releases: { version: string; order: number }[] }>(
      await session.client.callTool({ name: 'list_crash_releases', arguments: { crashDatabaseId: database.id } }),
    );
    expect(releases.releases.map((r) => r.version)).toEqual(['2.0.0', '2.0.1']);

    const stats = parsed<{ days: { reports: number }[] }>(
      await session.client.callTool({ name: 'get_crash_stats', arguments: { crashDatabaseId: database.id, days: 7 } }),
    );
    expect(stats.days.at(-1)?.reports).toBe(4);

    const csv = textOf(await session.client.callTool({ name: 'export_crash_groups', arguments: { crashDatabaseId: database.id, format: 'csv' } }));
    expect(csv).toContain('id,state,regressed,kind');
    const ndjson = textOf(await session.client.callTool({ name: 'export_crash_reports', arguments: { crashDatabaseId: database.id } }));
    expect(ndjson.trim().split('\n')).toHaveLength(4);

    // Shared tools accept the crash database ID (FD-002).
    const members = parsed<{ userId: string }[]>(await session.client.callTool({ name: 'list_members', arguments: { databaseId: database.id } }));
    expect(members.length).toBeGreaterThan(0);
    const impact = parsed<{ groups: number; reports: number }>(await session.client.callTool({ name: 'get_deletion_impact', arguments: { databaseId: database.id } }));
    expect(impact).toMatchObject({ groups: 1, reports: 4 });

    // CR-061: destructive tools demand the exact name or ID.
    const wrongGroup = await session.client.callTool({ name: 'delete_crash_group', arguments: { crashDatabaseId: database.id, groupId, confirm: 'cgr_other' } });
    expect(isError(wrongGroup)).toBe(true);
    expect(textOf(wrongGroup)).toContain('confirmation_mismatch');
    const wrongName = await session.client.callTool({ name: 'delete_crash_database', arguments: { crashDatabaseId: database.id, confirm: 'agent app' } });
    expect(isError(wrongName)).toBe(true);
    expect(textOf(wrongName)).toContain('confirmation_mismatch');
    const deleted = await session.client.callTool({ name: 'delete_crash_database', arguments: { crashDatabaseId: database.id, confirm: 'Agent app' } });
    expect(isError(deleted), textOf(deleted)).toBe(false);
    const gone = await session.client.callTool({ name: 'get_crash_database', arguments: { crashDatabaseId: database.id } });
    expect(isError(gone)).toBe(true);
    expect(textOf(gone)).toContain('crash_database_not_found');
  } finally {
    await session.close();
  }
});

test('a secret key from another project cannot reach the crash database, and cannot ingest into it', async ({ request }) => {
  const owner = await fixture(request, `Crash MCP owner ${Date.now()}`);
  const other = await fixture(request, `Crash MCP other ${Date.now()}`);
  const created = await request.post(`/v1/projects/${owner.projectId}/crash-databases`, { data: { name: 'Owned' } });
  const databaseId = (await created.json()).id as string;

  const session = await connect(other.secretKey);
  try {
    const read = await session.client.callTool({ name: 'get_crash_database', arguments: { crashDatabaseId: databaseId } });
    expect(isError(read)).toBe(true);
    expect(textOf(read)).toContain('crash_database_not_found');
    const test = await session.client.callTool({ name: 'send_crash_test_report', arguments: { crashDatabaseId: databaseId } });
    expect(isError(test)).toBe(true);
    expect(textOf(test)).toContain('crash_database_inaccessible');
  } finally {
    await session.close();
  }
});
