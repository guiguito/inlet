import type { JsonValue } from '@inlet/shared/config-core';
import { CLIENT_SLOT } from '../src/config/client.js';
import { resetSharedIdentity } from '../src/identity.js';
import { FakeInlet, json } from './analytics-helpers.js';

/**
 * Fakes for the config unit tests (Remote Config RC-110 to RC-128): an Inlet that answers the
 * fetch route of PRD section 9.2 with whatever is published, "not modified" for the ETag it
 * would send, and delegates the health probe and the crash and analytics routes to the
 * analytics tests' `FakeInlet`.
 */

export type Published = { version: number | null; values: Record<string, JsonValue>; experiments?: Record<string, string>; live?: string[] };
export type Fetched = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

export class FakeConfig {
  readonly inlet = new FakeInlet(['config', 'crash', 'analytics', 'feedback']);
  published: Published = { version: null, values: {} };
  interval = 3600;
  readonly fetches: Fetched[] = [];
  /** Answers a fetch instead of the default; return undefined to answer normally. */
  respond: ((body: Record<string, unknown>) => Response | undefined) | null = null;
  /** Per-user answers, for the change-of-user tests. */
  byUser: Record<string, Published> = {};
  offline = false;
  private readonly etags = new Map<string, string>();

  get caps(): string[] {
    return this.inlet.caps;
  }
  set caps(value: string[]) {
    this.inlet.caps = value;
  }

  publish(published: Published): void {
    this.published = published;
  }

  answerFor(body: Record<string, unknown>) {
    const published = (typeof body.userId === 'string' && this.byUser[body.userId]) || this.published;
    const values = published.version === null ? {} : published.values;
    const experiments = published.version === null ? {} : (published.experiments ?? {});
    const live = published.version === null ? [] : (published.live ?? []);
    const content = JSON.stringify([values, experiments, live]);
    let etag = this.etags.get(content);
    if (!etag) this.etags.set(content, (etag = `etag-${this.etags.size + 1}`));
    return { version: published.version, values, experiments, live, etag, refreshIntervalSeconds: this.interval, warnings: [] };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.offline) throw new TypeError('fetch failed');
    const url = String(input);
    if (!url.includes('/v1/config-databases/')) return this.inlet.fetch(input, init);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    this.fetches.push({ url, body, headers: { ...(init?.headers as Record<string, string>) } });
    const custom = this.respond?.(body);
    if (custom) return custom;
    const answer = this.answerFor(body);
    if (body.etag === answer.etag) return json(200, { notModified: true, refreshIntervalSeconds: this.interval });
    return json(200, answer);
  };
}

/** Fresh globals: the config, crash and analytics slots, the config's experiments (RC-129) and the shared identity. */
export function resetConfigSlots(): void {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  for (const name of ['inlet-sdk.analytics.current', 'inlet-sdk.crash.current', 'inlet-sdk.config.experiments']) delete holder[Symbol.for(name)];
  delete holder[CLIENT_SLOT];
  resetSharedIdentity();
}

/** Lets pending promise chains and zero-delay timers run under fake timers. */
export async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  const { vi } = await import('vitest');
  await vi.advanceTimersByTimeAsync(0);
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
