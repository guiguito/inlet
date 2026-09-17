import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import { InletError, type InletClient } from '../src/client.js';

/**
 * The tool layer, exercised against a recording client.
 *
 * `inlet-mcp` is a thin proxy over the HTTP API (FR-123), so what is worth asserting
 * here is the translation: which request a tool builds from its arguments, and what an
 * agent is told when that request fails.
 */

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/** Captures what `registerTools` registers, so a handler can be called directly. */
function register(client: Partial<InletClient>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  registerTools(
    server as unknown as Parameters<typeof registerTools>[0],
    client as InletClient,
  );
  return handlers;
}

describe('get_screenshot', () => {
  /** Records the path each call asks for, and hands back a one-pixel answer. */
  function recordingClient(paths: string[]): Partial<InletClient> {
    return {
      bytes: async (path: string) => {
        paths.push(path);
        return { data: Buffer.from([1, 2, 3]), mediaType: 'image/webp' };
      },
    };
  }

  it('asks for the stored image when no width is given', async () => {
    const paths: string[] = [];
    const handlers = register(recordingClient(paths));
    const result = await handlers.get('get_screenshot')!({ attachmentId: 'att_abc' });

    expect(paths).toEqual(['/v1/attachments/att_abc']);
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/webp' });
  });

  /**
   * Section 24.6 grants a secret server key a resized screenshot, and FD-021 asks for
   * one tool per permitted operation — so the width the HTTP API accepts has to be
   * reachable from MCP too. Without it an agent can only pull full-size images.
   */
  it('passes a requested width through to the API (FR-177, 24.6)', async () => {
    const paths: string[] = [];
    const handlers = register(recordingClient(paths));
    await handlers.get('get_screenshot')!({ attachmentId: 'att_abc', width: 88 });

    expect(paths).toEqual(['/v1/attachments/att_abc?width=88']);
  });
});

describe('a failed tool call', () => {
  /**
   * FD-023: the stable error code travels in the message. An agent that reads
   * `form_not_published` can publish the form; "the request failed" leaves it guessing.
   */
  it('carries the API error code and status (FD-023)', async () => {
    const handlers = register({
      request: async () => {
        throw new InletError(409, 'form_not_published', 'This form is not published.');
      },
    });

    const result = await handlers.get('get_published_form')!({ databaseId: 'fdb_x' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('code: form_not_published');
    expect(text).toContain('HTTP 409');
  });
});

describe('a destructive tool', () => {
  /**
   * FD-022: the caller must echo the exact name, and a mismatch fails with
   * `confirmation_mismatch` — the code, not merely a sternly worded sentence.
   */
  it('refuses a mismatched confirmation with confirmation_mismatch (FD-022)', async () => {
    const handlers = register({
      request: async (_method: string, path: string) => {
        if (path === '/v1/projects/prj_x') return { id: 'prj_x', name: 'Real name' };
        throw new Error(`unexpected call to ${path}`);
      },
    });

    const result = await handlers.get('delete_project')!({
      projectId: 'prj_x',
      confirm: 'Wrong name',
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('code: confirmation_mismatch');
  });
});
