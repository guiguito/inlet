import type { ClientFormPage } from '@inlet/shared/feedback-core';

/**
 * A fake Inlet for the feedback unit tests.
 *
 * It answers the four collection routes and the health probe with the shapes section 9.2
 * documents, and nothing more: the rules it enforces are the ones the SDK is not allowed
 * to enforce by itself — intent expiry, the payload-conflict contract, the duplicate
 * result — so that a test can prove the SDK asks the server rather than guessing. Anything
 * about answers is the shared validator's job and is exercised against the real server in
 * `e2e/api/sdk-feedback.spec.ts`.
 */

export const QUESTION = {
  mood: 'el_aaaaaaaaaaaa',
  detail: 'el_bbbbbbbbbbbb',
  email: 'el_cccccccccccc',
  shot: 'el_dddddddddddd',
} as const;

export const PAGES: ClientFormPage[] = [
  {
    id: 'pg_aaaaaaaaaaaa',
    elements: [
      { id: 'el_tttttttttttt', type: 'title', text: 'How did it go?' },
      {
        id: QUESTION.mood,
        type: 'choice',
        label: 'Mood',
        required: true,
        optionKind: 'emoji',
        selection: 'single',
        orientation: 'horizontal',
        options: [
          { id: 'op_aaaaaaaaaaaa', label: 'Good', emoji: '🙂' },
          { id: 'op_bbbbbbbbbbbb', label: 'Bad', emoji: '🙁' },
        ],
      },
    ],
  },
  {
    id: 'pg_bbbbbbbbbbbb',
    elements: [
      { id: QUESTION.detail, type: 'text', label: 'What happened?', required: true, multiline: true, maxLength: 500, placeholder: 'Tell us more' },
      { id: QUESTION.email, type: 'email', label: 'Email', required: false },
      {
        id: QUESTION.shot,
        type: 'screenshot',
        label: 'Screenshot',
        required: false,
        maxCount: 2,
        acceptedMediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
        maxFileBytes: 10 * 1024 * 1024,
      },
    ],
  },
];

export type Call = { method: string; url: string; body?: unknown; headers: Record<string, string> };

export type FakeServerOptions = {
  /** Answers every route with this error instead. */
  form?: { code: string; message: string; status: number } | null;
  /** How long an intent lives, in milliseconds. */
  intentTtlMs?: number;
  capabilities?: string[];
  now?: () => number;
};

type Intent = { intentId: string; token: string; formVersion: number; expiresAt: number; finalized?: { key: string; result: unknown } };

export class FakeInlet {
  readonly calls: Call[] = [];
  readonly intents = new Map<string, Intent>();
  /** Set to make the next N requests fail as if the network were down. */
  offline = 0;
  /** Set to make the next N finalizations fail on transport, the intent already created. */
  offlineSubmits = 0;
  /** Set to answer the next finalization with 429 and this Retry-After. */
  rateLimit: number | null = null;
  /** Set to answer the next finalization with a 500. */
  serverError = 0;
  formVersion = 1;
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly options: FakeServerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  get fetch(): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => this.handle(String(input), init ?? {})) as typeof fetch;
  }

  /** Requests to the collection routes, excluding the health probe. */
  collectionCalls(): Call[] {
    return this.calls.filter((call) => !call.url.endsWith('/v1/health'));
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body;
    this.calls.push({ method, url, ...(body === undefined ? {} : { body }), headers });

    if (url.endsWith('/v1/health')) {
      return json(200, { status: 'ok', capabilities: this.options.capabilities ?? ['feedback', 'crash', 'feedback-cross-origin'] });
    }
    if (this.offline > 0) {
      this.offline -= 1;
      throw new TypeError('fetch failed');
    }
    if (url.endsWith('/form')) {
      if (this.options.form) {
        return json(this.options.form.status, { error: { code: this.options.form.code, message: this.options.form.message } });
      }
      return json(200, {
        feedbackDatabaseId: 'fdb_test',
        formVersionId: 'fv_test',
        formVersion: this.formVersion,
        publishedAt: new Date(0).toISOString(),
        pages: PAGES,
      });
    }
    if (url.endsWith('/submission-intents') && method === 'POST') {
      const intent: Intent = {
        intentId: `si_${++this.seq}`,
        token: `tok_${this.seq}`,
        formVersion: this.formVersion,
        expiresAt: this.now() + (this.options.intentTtlMs ?? 30 * 60_000),
      };
      this.intents.set(intent.intentId, intent);
      return json(201, { ...intent, expiresAt: new Date(intent.expiresAt).toISOString() });
    }

    const match = /\/submission-intents\/([^/]+)\/(attachments(?:\/([^/]+))?|submit)$/.exec(url);
    if (!match) return json(404, { error: { code: 'not_found', message: 'no route' } });
    const intent = this.intents.get(match[1]!);
    if (!intent) return json(404, { error: { code: 'intent_not_found', message: 'unknown intent' } });
    if (headers['x-inlet-intent-token'] !== intent.token) {
      return json(401, { error: { code: 'intent_invalid_token', message: 'bad token' } });
    }

    if (match[2]!.startsWith('attachments')) {
      // FR-092F: expiry applies to an intent that is still active.
      if (!intent.finalized && this.now() >= intent.expiresAt) {
        return json(410, { error: { code: 'intent_expired', message: 'expired' } });
      }
      if (method === 'DELETE') return json(200, { ok: true });
      return json(201, {
        attachmentId: `att_${++this.seq}`,
        status: 'uploaded',
        mediaType: 'image/webp',
        originalMediaType: 'image/png',
        width: 640,
        height: 480,
        bytes: 12_345,
        originalBytes: 54_321,
        scanStatus: 'skipped',
      });
    }

    // Finalization.
    if (this.offlineSubmits > 0) {
      this.offlineSubmits -= 1;
      throw new TypeError('fetch failed');
    }
    if (this.rateLimit !== null) {
      const seconds = this.rateLimit;
      this.rateLimit = null;
      return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(seconds) },
      });
    }
    if (this.serverError > 0) {
      this.serverError -= 1;
      return json(503, { error: { code: 'internal_error', message: 'unavailable' } });
    }

    const key = JSON.stringify(body);
    if (intent.finalized) {
      // FR-092C: the same payload replays, a different one conflicts.
      if (intent.finalized.key !== key) {
        return json(409, { error: { code: 'intent_payload_conflict', message: 'different answers' } });
      }
      return json(200, { ...(intent.finalized.result as object), status: 'duplicate' });
    }
    if (this.now() >= intent.expiresAt) {
      return json(410, { error: { code: 'intent_expired', message: 'expired' } });
    }
    const payload = body as { formVersion: number };
    if (payload.formVersion !== intent.formVersion) {
      return json(409, { error: { code: 'form_version_mismatch', message: `pinned to ${intent.formVersion}` } });
    }
    const result = { submissionId: `sub_${++this.seq}`, formVersion: intent.formVersion, createdAt: new Date(this.now()).toISOString() };
    intent.finalized = { key, result };
    return json(201, { ...result, status: 'accepted' });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A PNG's first bytes, which is all the media-type sniffing and the fake server read. */
export function pngBytes(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}
