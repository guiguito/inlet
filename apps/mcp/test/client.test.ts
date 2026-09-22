import { describe, expect, it } from 'vitest';
import { InletClient, InletError } from '../src/client.js';

/**
 * The client's transport is a parameter (FD-025). The stdio server leaves it alone and
 * gets the global `fetch`; the API supplies one that re-enters its own HTTP stack when
 * it serves these tools over Streamable HTTP.
 */
describe('the Inlet client', () => {
  it('uses the supplied fetch, with the key and the base URL', async () => {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const client = new InletClient({
      baseUrl: 'https://inlet.example.com/',
      secretKey: 'isk_test',
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          headers: init?.headers as Record<string, string>,
          ...(init?.body === undefined ? {} : { body: init.body as string }),
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(await client.request('POST', '/v1/projects', { name: 'x' })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    // The trailing slash is trimmed, so paths are joined exactly once.
    expect(calls[0]?.url).toBe('https://inlet.example.com/v1/projects');
    expect(calls[0]?.headers.authorization).toBe('Bearer isk_test');
    expect(calls[0]?.body).toBe('{"name":"x"}');
  });

  it('surfaces the stable error code from the body (FD-023)', async () => {
    const client = new InletClient({
      baseUrl: '',
      secretKey: 'isk_test',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'project_not_found', message: 'No.' } }), {
          status: 404,
        }),
    });

    await expect(client.request('GET', '/v1/projects/p')).rejects.toMatchObject({
      code: 'project_not_found',
    });
  });

  it('defaults to the global fetch when none is supplied', async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      await new InletClient({ baseUrl: 'https://inlet.example.com', secretKey: 'isk_test' }).request(
        'GET',
        '/v1/projects',
      );
    } finally {
      globalThis.fetch = original;
    }
    expect(called).toBe(true);
  });

  it('reports an unreachable deployment rather than throwing a raw network error', async () => {
    const client = new InletClient({
      baseUrl: 'https://inlet.example.com',
      secretKey: 'isk_test',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(client.request('GET', '/v1/projects')).rejects.toBeInstanceOf(InletError);
  });
});
