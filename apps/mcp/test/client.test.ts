import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_TIMEOUT_MS, InletClient, InletError } from '../src/client.js';

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

  describe('timeouts', () => {
    afterEach(() => vi.useRealTimers());

    /** A deployment that answers only when the client gives up. */
    const hanging = () =>
      new InletClient({
        baseUrl: 'https://inlet.example.com',
        secretKey: 'isk_test',
        fetch: (_input, init) =>
          new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      });

    it('gives up on an ordinary call after 30 seconds', async () => {
      vi.useFakeTimers();
      const call = hanging().request('GET', '/v1/projects').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await call).toMatchObject({ status: 504, message: 'Inlet did not answer within 30000ms.' });
    });

    it('waits past a funnel trend’s 120-second limit on analytics calls (AN-205)', async () => {
      vi.useFakeTimers();
      expect(ANALYTICS_TIMEOUT_MS).toBeGreaterThan(130_000);
      let settled: unknown = 'pending';
      const call = hanging()
        .request('POST', '/v1/analytics-databases/adb_x/funnels/run', {})
        .catch((error: unknown) => (settled = error));
      await vi.advanceTimersByTimeAsync(130_000);
      // Still waiting where the ordinary timeout would long have cut it.
      expect(settled).toBe('pending');
      await vi.advanceTimersByTimeAsync(ANALYTICS_TIMEOUT_MS - 130_000);
      await call;
      expect(settled).toMatchObject({ status: 504, message: `Inlet did not answer within ${ANALYTICS_TIMEOUT_MS}ms.` });
    });

    it('treats the erasure preview as an analytics call', async () => {
      vi.useFakeTimers();
      let settled: unknown = 'pending';
      void hanging()
        .request('POST', '/v1/projects/prj_x/erasures/preview', {})
        .catch((error: unknown) => (settled = error));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe('pending');
      await vi.advanceTimersByTimeAsync(ANALYTICS_TIMEOUT_MS);
      expect(settled).toMatchObject({ status: 504 });
    });

    it('treats the erasure itself as an analytics call: it counts the events as the preview does', async () => {
      vi.useFakeTimers();
      let settled: unknown = 'pending';
      void hanging()
        .request('POST', '/v1/projects/prj_x/erasures', {})
        .catch((error: unknown) => (settled = error));
      await vi.advanceTimersByTimeAsync(60_000);
      // A 30-second cut here reported an error for an erasure the server went on to apply.
      expect(settled).toBe('pending');
      await vi.advanceTimersByTimeAsync(ANALYTICS_TIMEOUT_MS);
      expect(settled).toMatchObject({ status: 504 });
    });
  });
});
