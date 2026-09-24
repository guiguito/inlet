/**
 * The deployment's capabilities, read from `/v1/health` (Foundations FD-013, FD-015,
 * FD-016).
 *
 * Shared by every module, cached per fetch implementation and origin for the life of the
 * page or process, and read again after a failed probe, so that a module sends the
 * identity fields only to a deployment that lists `identity` without asking before every
 * request. Only a probe that answered is cached: a deployment that was unreachable at
 * startup is asked again on the next send.
 *
 * Keyed by the fetch implementation too, so two clients given different `fetch` functions
 * (every test, and an integrator's instrumented fetch) never read each other's answer.
 */

const cache = new WeakMap<typeof fetch, Map<string, Promise<string[] | null>>>();

/** The one default fetch, so the modules of one application share one probe. */
export const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

/** The capability list, or null when the probe failed. */
export function capabilities(baseUrl: string, impl: typeof fetch, timeoutMs = 20_000): Promise<string[] | null> {
  let byOrigin = cache.get(impl);
  if (!byOrigin) {
    byOrigin = new Map();
    cache.set(impl, byOrigin);
  }
  const key = baseUrl.replace(/\/$/, '');
  const known = byOrigin.get(key);
  if (known) return known;
  const probe = (async () => {
    const timeout = timeoutSignal(timeoutMs);
    try {
      const response = await impl(`${key}/v1/health`, { method: 'GET', ...(timeout.signal ? { signal: timeout.signal } : {}) });
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as { capabilities?: unknown } | null;
      return Array.isArray(body?.capabilities) ? body.capabilities.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return null;
    } finally {
      timeout.clear();
    }
  })();
  byOrigin.set(key, probe);
  void probe.then((result) => {
    if (result === null && byOrigin.get(key) === probe) byOrigin.delete(key);
  });
  return probe;
}

/**
 * A request timeout without `AbortSignal.timeout`, which React Native lacks (CR-120,
 * FR-211). The timer is unref'd so it never keeps a Node process alive, and cleared once
 * the request settles. No signal at all where `AbortController` is missing.
 */
export function timeoutSignal(ms: number): { signal?: AbortSignal; clear: () => void } {
  if (typeof AbortController === 'undefined') return { clear: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  (timer as { unref?: () => void }).unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
