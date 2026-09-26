import { expect, test, type APIRequestContext } from '@playwright/test';
import { E2E } from '../env';

/**
 * Analytics ingest through the real server (UX Analytics 6.2, 7.1, FD-015), as an application
 * sends it: batches with the project's publishable key, a browser's cross-origin preflight,
 * per-event answers, duplicates on a resend, and the live feed a signed-in reader polls.
 */
const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  name: 'checkout_completed',
  installationId: '0192f5a0-0000-7000-8000-00000000e2e0',
  platform: 'web',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

/** A server just started answers 503 for two seconds after its event store becomes ready. */
async function post(request: APIRequestContext, url: string, key: string, events: unknown[]) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request.post(url, {
      headers: { authorization: `Bearer ${key}`, origin: 'https://shop.example.com' },
      data: { sentAt: new Date().toISOString(), events },
    });
    if (response.status() !== 503 || attempt === 10) return response;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test('an application sends batches with its publishable key, from another origin', async ({ request, playwright }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Analytics ingest ${Date.now()}` } })).json()).id as string;
  const database = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Shop', timezone: 'Europe/Paris' } })).json()) as { id: string };
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'web' } })).json()).secret as string;
  const url = `/v1/analytics-databases/${database.id}/batch`;

  // A client with no session, as a browser on the integrator's origin is.
  const app = await playwright.request.newContext({ baseURL: E2E.baseUrl });
  try {
    // FD-015: the preflight the browser sends first.
    const preflight = await app.fetch(url, {
      method: 'OPTIONS',
      headers: { origin: 'https://shop.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(preflight.status()).toBe(204);
    expect(preflight.headers()['access-control-allow-origin']).toBe('*');
    expect(preflight.headers()['access-control-allow-methods']).toBe('POST, OPTIONS');
    // The catalog route stays shut.
    const catalog = await app.fetch(`/v1/analytics-databases/${database.id}/events`, {
      method: 'OPTIONS',
      headers: { origin: 'https://shop.example.com', 'access-control-request-method': 'GET' },
    });
    expect(catalog.status()).toBe(404);

    const batch = [event({ name: 'app_started', category: 'standard', params: { trigger: 'launch' } }), event(), event({ name: '1bad' }), { ...event(), extra: true }];
    const sent = await post(app, url, key, batch);
    expect(sent.status(), await sent.text()).toBe(200);
    expect(sent.headers()['access-control-allow-origin']).toBe('*');
    expect(await sent.json()).toEqual({
      accepted: 2,
      duplicates: 0,
      rejected: [
        { index: 2, code: 'invalid_event', field: 'name' },
        { index: 3, code: 'unknown_field', field: 'extra' },
      ],
      warnings: [],
    });

    // AN-013: the same batch again stores nothing more.
    expect(await (await post(app, url, key, batch)).json()).toMatchObject({ accepted: 0, duplicates: 2 });

    // AN-023: the publishable key reads nothing.
    expect((await app.get(`/v1/analytics-databases/${database.id}/live`, { headers: { authorization: `Bearer ${key}` } })).status()).toBe(403);
  } finally {
    await app.dispose();
  }

  // AN-058: a signed-in reader sees both stored events once, newest first.
  const live = (await (await request.get(`/v1/analytics-databases/${database.id}/live`)).json()) as { events: { name: string; platform: string }[]; cursor: string };
  expect(live.events.map((entry) => entry.name)).toEqual(['checkout_completed', 'app_started']);
  expect(live.events[0]!.platform).toBe('web');
  expect((await (await request.get(`/v1/analytics-databases/${database.id}/live?after=${live.cursor}`)).json()).events).toEqual([]);
});
