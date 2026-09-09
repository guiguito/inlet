/**
 * The Inlet HTTP client the MCP tools call.
 *
 * PRD section 21.2 asks for MCP "built as a thin layer over the Release 1 API", and
 * that is literally what this is: every tool becomes one authenticated HTTP request.
 * Nothing here reaches the database or the object store directly, so MCP cannot
 * acquire an authority the API does not already grant a secret server key, and
 * FR-123 holds by construction rather than by discipline.
 */

export class InletError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'InletError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ClientOptions = {
  /** The deployment's base URL, for example https://inlet.example.com */
  baseUrl: string;
  /** A secret server key (`isk_…`). Carries project Admin authority in one project. */
  secretKey: string;
  timeoutMs?: number;
};

export class InletClient {
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.secretKey = options.secretKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const raw = await this.raw(method, path, body);
    const text = await raw.text();
    const parsed: unknown = text.length > 0 ? safeJson(text) : null;

    if (!raw.ok) {
      const error = (parsed as { error?: { code?: string; message?: string; details?: unknown } })
        ?.error;
      throw new InletError(
        raw.status,
        error?.code ?? 'internal_error',
        error?.message ?? `The request failed with status ${raw.status}.`,
        error?.details,
      );
    }
    return parsed as T;
  }

  /**
   * Finalization, which carries the intent token as a second factor beside the key.
   * Kept separate from `request` so that header cannot leak onto anything else.
   */
  async finalize<T>(path: string, intentToken: string, body: unknown): Promise<T> {
    const raw = await this.raw('POST', path, body, { 'x-inlet-intent-token': intentToken });
    const text = await raw.text();
    const parsed: unknown = text.length > 0 ? safeJson(text) : null;
    if (!raw.ok) {
      const error = (parsed as { error?: { code?: string; message?: string; details?: unknown } })
        ?.error;
      throw new InletError(
        raw.status,
        error?.code ?? 'internal_error',
        error?.message ?? `The submission failed with status ${raw.status}.`,
        error?.details,
      );
    }
    return parsed as T;
  }

  /** For the export endpoints, whose body is a file rather than a modelled object. */
  async text(path: string): Promise<string> {
    const raw = await this.raw('GET', path);
    const text = await raw.text();
    if (!raw.ok) {
      const error = (safeJson(text) as { error?: { code?: string; message?: string } })?.error;
      throw new InletError(
        raw.status,
        error?.code ?? 'internal_error',
        error?.message ?? `The export failed with status ${raw.status}.`,
      );
    }
    return text;
  }

  /** For an attachment, which comes back as image bytes. */
  async bytes(path: string): Promise<{ data: Buffer; mediaType: string }> {
    const raw = await this.raw('GET', path);
    if (!raw.ok) {
      const error = (safeJson(await raw.text()) as { error?: { code?: string; message?: string } })
        ?.error;
      throw new InletError(
        raw.status,
        error?.code ?? 'internal_error',
        error?.message ?? `The download failed with status ${raw.status}.`,
      );
    }
    return {
      data: Buffer.from(await raw.arrayBuffer()),
      mediaType: raw.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  private async raw(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new InletError(504, 'internal_error', `Inlet did not answer within ${this.timeoutMs}ms.`);
      }
      throw new InletError(
        502,
        'internal_error',
        `Inlet could not be reached at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
