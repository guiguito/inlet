import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  createJsonSchemaTransform,
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { LIMITS, statusForErrorCode, type ErrorCode, type ErrorDetail } from '@inlet/shared';
import {
  frameHeaders,
  hostedFormStyle,
  resolveSlug,
  type ResolvedHostedForm,
} from './services/hosted-forms.js';
import type { AppContext } from './context.js';
import { ApiError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { clientRoutes } from './routes/client.js';
import {
  databaseRoutes,
  hostedFormRoutes,
  slackNotificationRoutes,
} from './routes/databases.js';
import { hostedRoutes } from './routes/hosted.js';
import { memberRoutes } from './routes/members.js';
import { crashRoutes } from './routes/crashes.js';
import { crashReadRoutes } from './routes/crash-reads.js';
import { requireCrashDatabase } from './services/access.js';
import { mcpRoutes } from './routes/mcp.js';
import { projectRoutes } from './routes/projects.js';
import { attachmentRoutes, submissionRoutes } from './routes/submissions.js';
import { openapiDocument } from './openapi.js';

/**
 * Builds the HTTP application.
 *
 * Takes its context as an argument rather than reading module state, so the
 * integration suite can run the real app against its own database and bucket.
 */
export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log,
    // FR-062C: the deployment decides which proxies may report the client address.
    // A hop count is valid at runtime but missing from Fastify's option type.
    trustProxy: ctx.env.trustProxy as boolean | string | string[],
    bodyLimit: 1024 * 1024,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie, { secret: ctx.env.INLET_SESSION_SECRET, hook: 'onRequest' });

  await app.register(multipart, {
    limits: {
      // One image per request, capped at the platform's per-file limit so an
      // oversized upload is refused while streaming rather than after buffering.
      files: 1,
      fields: 4,
      fileSize: LIMITS.imageMaxSourceBytes,
    },
  });

  // FR-088: non-configurable security rate limits. Per-route overrides tighten the
  // public operations; this is the global ceiling.
  if (!ctx.env.INLET_DISABLE_RATE_LIMITS) {
    await app.register(rateLimit, {
      global: true,
      max: 1000,
      timeWindow: '1 minute',
      // A project credential identifies a server-to-server integrator better than an
      // IP does; fall back to the IP for browser clients.
      keyGenerator: (request) => {
        const auth = request.headers.authorization;
        return auth ? `key:${auth.slice(-16)}` : `ip:${request.ip}`;
      },
    });
  }

  registerCrossOriginCollection(app);
  await registerDocs(app, ctx);
  registerErrorHandler(app);

  await app.register(
    async (v1) => {
      v1.get('/health', { schema: { hide: true } }, async () => {
        await ctx.db.execute('select 1');
        // FD-013: what this server can do, so an SDK can tell an old deployment from a
        // reachable one before it queues reports the server would refuse.
        // 'mcp' announces the Streamable HTTP endpoint at /v1/mcp (FR-126), so a client
        // can tell a deployment that serves MCP from one that only ships the binary.
        return { status: 'ok', capabilities: ['feedback', 'crash', CROSS_ORIGIN_FEEDBACK, 'mcp'] };
      });

      await v1.register(authRoutes(ctx), { prefix: '/auth' });
      await v1.register(projectRoutes(ctx), { prefix: '/projects' });
      await v1.register(databaseRoutes(ctx), { prefix: '/feedback-databases' });
      await v1.register(clientRoutes(ctx), { prefix: '/feedback-databases' });
      await v1.register(submissionRoutes(ctx), { prefix: '/feedback-databases' });
      await v1.register(attachmentRoutes(ctx), { prefix: '/attachments' });
      await v1.register(hostedFormRoutes(ctx), { prefix: '/feedback-databases' });
      await v1.register(slackNotificationRoutes(ctx), { prefix: '/feedback-databases' });
      await v1.register(hostedRoutes(ctx), { prefix: '/hosted' });
      await v1.register(memberRoutes(ctx));
      await v1.register(crashRoutes(ctx));
      await v1.register(crashReadRoutes(ctx));
      await v1.register(mcpRoutes(ctx, app));
      // The shared Slack settings plugin, a second time, for crash databases (CR-050).
      await v1.register(
        slackNotificationRoutes(ctx, async (principal, databaseId) => {
          const { database } = await requireCrashDatabase(ctx.db, principal, databaseId, 'creator');
          return { name: database.name };
        }),
        { prefix: '/crash-databases' },
      );
    },
    { prefix: '/v1' },
  );

  await registerSpa(app, ctx);

  return app;
}

/** OpenAPI 3.1 generated from the same Zod schemas the routes validate against. */
async function registerDocs(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(swagger, {
    openapi: openapiDocument(ctx.env.INLET_PUBLIC_URL),
    transform: createJsonSchemaTransform({ skipList: ['/v1/health'] }),
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
  });

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
}

/**
 * The collection surface a browser on another origin may reach (FD-015).
 *
 * Everything else in Inlet stays same-origin, which is what section 13 of DECISIONS.md
 * describes and why there is no CORS plugin here. This is the one exception, and FD-015
 * enumerates it in this one place: the health probe, crash ingest, and the four feedback
 * collection routes. Both browser adapters of `inlet-sdk` run on the integrator's own
 * origin by definition, and both send an `authorization` header, which forces a
 * preflight. Without this the preflight 404s and the browser never sends anything at all.
 *
 * Widening this set is a change to the Foundations PRD first, and
 * `apps/api/test/integration/cors.test.ts` pins both halves of the boundary.
 *
 * Three details are load-bearing:
 *
 * The hook goes on the root instance, not in a scope around the routes. A preflight
 * matches no route — `OPTIONS` is never declared — so Fastify serves it from the 404
 * context, and that context is built from the *root* instance's hooks. A hook registered
 * inside an encapsulated child would never run for the request that needs it most.
 *
 * The path is matched on `request.url` rather than on the resolved route, for the same
 * reason: an unmatched preflight has no route to read.
 *
 * And the pattern is anchored and segment-counted rather than prefix-matched, so that
 * `/v1/feedback-databases/{id}/submissions` — the route that returns collected responses
 * — stays shut while `/v1/feedback-databases/{id}/form` opens.
 */
const CROSS_ORIGIN_FEEDBACK = 'feedback-cross-origin';

const CROSS_ORIGIN_COLLECTION = new RegExp(
  [
    '^/v1/(',
    'health',
    // Crash Reports (CR-010): one report, or a batch.
    '|crash-databases/[^/]+/reports(/batch)?',
    // Feedback Collection (FR-090 to FR-099A): the published form, an intent, an
    // attachment under that intent, and finalization.
    '|feedback-databases/[^/]+/(form|submission-intents(/[^/]+/(attachments(/[^/]+)?|submit))?)',
    ')$',
  ].join(''),
);

function registerCrossOriginCollection(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    if (!CROSS_ORIGIN_COLLECTION.test(request.url.split('?')[0] ?? '')) return done();

    /*
     * No `access-control-allow-credentials`, ever. That absence is the security property:
     * a browser will not attach the session cookie to these requests, so the management
     * session cannot be replayed from another origin. Ingest carries its own bearer
     * publishable key, which was always meant to travel in public code.
     */
    reply.header('access-control-allow-origin', '*');
    /*
     * CR-016: the SDK honours `Retry-After` on a 429. It is not a CORS-safelisted response
     * header, so without this a cross-origin client reads null and backs off on a guess
     * instead of on the number the server sent.
     */
    reply.header('access-control-expose-headers', 'retry-after');

    // Set before any handler runs, so a 401 or a 429 carries them too. A cross-origin
    // error response without them is an opaque network failure to `fetch`, and the SDK
    // would requeue for ever a report the server has already refused.
    if (request.method !== 'OPTIONS') return done();

    reply
      // DELETE is here for one route only: releasing a screenshot before submitting.
      .header('access-control-allow-methods', 'POST, GET, DELETE, OPTIONS')
      // Exactly what the two modules send, and no more. A static list rather than an
      // echo of `access-control-request-headers`, so a client that adds a header gets a
      // clean preflight failure instead of a silently widened surface. The intent token
      // is the feedback module's; the crash routes never needed it.
      .header('access-control-allow-headers', 'authorization, content-type, x-inlet-intent-token')
      .header('access-control-max-age', '86400')
      .code(204)
      .send();
  });
}

/**
 * One error handler for the whole API, so section 9.5's shape is produced in exactly
 * one place and no route formats its own errors.
 */
function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.status >= 500) request.log.error({ err: error }, 'request failed');
      return reply.code(error.status).send(error.toBody());
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const details: ErrorDetail[] = error.validation.map((issue) => ({
        path: issue.instancePath.replace(/^\//, '').replaceAll('/', '.'),
        code: issue.keyword,
        message: issue.message ?? 'Invalid value.',
      }));
      return reply.code(400).send({
        error: {
          code: 'validation_failed',
          message: 'The request does not match the expected shape.',
          details,
        },
      });
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, issues: error.cause.issues }, 'response did not serialize');
      return reply.code(500).send({
        error: { code: 'internal_error', message: 'The server produced an invalid response.' },
      });
    }

    const mapped = mapFrameworkError(error as FastifyError);
    if (mapped) return reply.code(statusForErrorCode(mapped.code)).send({ error: mapped });

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Something went wrong on our side.' },
    });
  });
}

/**
 * Fastify and plugin errors carry their own codes and statuses; map them into the
 * section 9.5 shape.
 *
 * The status fallback at the end matters: a plugin that throws a 4xx (the rate
 * limiter, for one) would otherwise be reported as an internal error, telling a
 * client to retry when it should back off.
 */
function mapFrameworkError(
  error: FastifyError,
): { code: ErrorCode; message: string } | null {
  switch (error.code) {
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return { code: 'malformed_json', message: 'The request body is not valid JSON.' };
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return { code: 'payload_too_large', message: 'The request body is too large.' };
    case 'FST_REQ_FILE_TOO_LARGE':
      return {
        code: 'file_too_large',
        message: `A screenshot may be at most ${Math.floor(LIMITS.imageMaxSourceBytes / (1024 * 1024))} MB.`,
      };
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return {
        code: 'unsupported_media_type',
        message: 'That content type is not accepted on this endpoint.',
      };
    default:
      break;
  }

  const status = error.statusCode;
  if (status === undefined || status < 400 || status >= 500) return null;

  const byStatus: Record<number, ErrorCode> = {
    400: 'validation_failed',
    401: 'unauthenticated',
    403: 'forbidden',
    404: 'not_found',
    405: 'not_found',
    409: 'name_conflict',
    413: 'payload_too_large',
    415: 'unsupported_media_type',
    429: 'rate_limit_exceeded',
  };
  const code = byStatus[status];
  if (!code) return null;

  return {
    code,
    message:
      status === 429
        ? 'Too many requests. Wait a moment and try again.'
        : error.message || 'The request could not be completed.',
  };
}

/**
 * The hosted form page (FR-130, FR-135, FR-138).
 *
 * A route of its own rather than a fall-through to the single-page app, because two
 * things have to happen per slug before any HTML is sent: the framing headers the
 * operator chose, which a browser only honours on the document itself, and the
 * branding, injected so the first paint is already theirs.
 */
async function registerHostedPage(
  app: FastifyInstance,
  ctx: AppContext,
  root: string,
): Promise<void> {
  const shell = await readFile(path.join(root, 'index.html'), 'utf8');

  app.get<{ Params: { slug: string } }>(
    '/f/:slug',
    { schema: { hide: true } },
    async (request, reply) => {
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');

      let resolved;
      try {
        resolved = await resolveSlug(ctx, request.params.slug);
      } catch {
        // An unknown address still renders the page, which says so civilly rather
        // than showing a browser error. Framing is denied, since there is no
        // operator choice to honour.
        return reply
          .code(404)
          .header('content-security-policy', "frame-ancestors 'self'")
          .header('x-frame-options', 'SAMEORIGIN')
          .send(unbranded(shell).replace('<title>Inlet</title>', '<title>Form not found</title>'));
      }

      for (const [name, value] of Object.entries(frameHeaders(resolved.hosted))) {
        reply.header(name, value);
      }

      return reply.send(hostedShell(shell, resolved));
    },
  );
}

/**
 * Inlet's own mark and descriptor, removed from a hosted page (FR-144).
 *
 * The shell is the management interface's `index.html`, which carries a favicon
 * pointing at the Inlet mark and a meta description naming the product. Both reach a
 * respondent — the mark in the browser tab, the descriptor in every chat preview of a
 * shared link — so neither may survive into a page the operator shares as theirs.
 *
 * Matched by pattern rather than by literal because the bundler is free to rewrite an
 * asset href, and a hosted page that silently regained our favicon would look like a
 * build artefact rather than the requirement breach it is.
 */
function unbranded(shell: string): string {
  return shell
    .replace(/\s*<link\b[^>]*\brel="icon"[^>]*>/gi, '')
    .replace(/\s*<meta\b[^>]*\bname="description"[^>]*>/gi, '');
}

/**
 * The tab icon for a hosted page: the operator's logo, or nothing (FR-144).
 *
 * There is deliberately no fallback mark. Anything we ship in that slot is our brand
 * sitting on their form, which is the thing FR-144 forbids; an empty slot leaves the
 * browser's own blank-page glyph, which belongs to nobody.
 */
function hostedIcon(resolved: ResolvedHostedForm): string {
  if (!resolved.hosted.logoStorageKey) return '';
  const slug = encodeURIComponent(resolved.hosted.slug);
  return `<link rel="icon" href="/v1/hosted/${slug}/logo" type="image/webp">`;
}

/**
 * The hosted page's initial HTML.
 *
 * Four substitutions on the built shell. The title is the feedback database's name,
 * because a shared link shows up in a tab and in a chat preview and should say what it
 * is. The root class swaps the management interface's stored theme for the hosted one,
 * so the page never paints in a theme the respondent's browser happens to remember.
 * The style block carries the branding, so the operator's colours are on the first
 * paint rather than one round trip later (FR-138). And Inlet's own mark and descriptor
 * come out, replaced by the operator's logo where they have one (FR-144).
 */
function hostedShell(shell: string, resolved: ResolvedHostedForm): string {
  return unbranded(shell)
    .replace('<title>Inlet</title>', `<title>${escapeHtml(resolved.database.name)}</title>`)
    .replace('<html lang="en" class="dark">', '<html lang="en" class="inlet-hosted">')
    .replace(
      '</head>',
      `${hostedIcon(resolved)}<style>${hostedFormStyle(resolved.hosted)}</style></head>`,
    );
}

/** For the one place a stored name reaches HTML: the hosted page's title. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Serves the built management interface from the same origin as the API, so the
 * bundled deployment is one container and the session cookie is first-party.
 *
 * The not-found handler is installed here, once, because it has to know whether an
 * unmatched path should fall through to the single-page app or be reported as a
 * missing API route.
 */
async function registerSpa(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const configured = ctx.env.INLET_WEB_DIST.trim();
  const root = configured ? path.resolve(configured) : '';
  const serveSpa = root !== '' && existsSync(root);

  if (configured && !serveSpa) {
    ctx.log.warn({ root }, 'INLET_WEB_DIST does not exist; not serving the web app');
  }
  if (serveSpa) {
    await app.register(fastifyStatic, { root, prefix: '/', wildcard: false });
    await registerHostedPage(app, ctx, root);
  }

  app.setNotFoundHandler((request, reply) => {
    const isApiPath =
      request.url.startsWith('/v1/') ||
      request.url.startsWith('/openapi') ||
      request.url.startsWith('/docs');

    // Only a navigation falls through to the single-page app. A missing script or
    // stylesheet must be a real 404: answering it with index.html turns a stale asset
    // reference into an opaque MIME-type error in the browser console instead of the
    // 404 that says what actually happened.
    const wantsHtml = (request.headers.accept ?? '').includes('text/html');

    if (serveSpa && !isApiPath && request.method === 'GET' && wantsHtml) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({
      error: {
        code: 'not_found',
        message: `No route matches ${request.method} ${request.url}.`,
      },
    });
  });
}
