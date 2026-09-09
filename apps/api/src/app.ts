import { existsSync } from 'node:fs';
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
import type { AppContext } from './context.js';
import { ApiError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { clientRoutes } from './routes/client.js';
import { databaseRoutes } from './routes/databases.js';
import { memberRoutes } from './routes/members.js';
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
      fileSize: LIMITS.attachmentMaxSourceBytes,
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

  await registerDocs(app, ctx);
  registerErrorHandler(app);

  await app.register(
    async (v1) => {
      v1.get('/health', { schema: { hide: true } }, async () => {
        await ctx.db.execute('select 1');
        return { status: 'ok' };
      });

      await v1.register(authRoutes(ctx), { prefix: '/auth' });
      await v1.register(projectRoutes(ctx), { prefix: '/projects' });
      await v1.register(databaseRoutes(ctx), { prefix: '/feedback-databases' });
      await v1.register(clientRoutes(ctx), { prefix: '/feedback-databases' });
      await v1.register(submissionRoutes(ctx), { prefix: '/feedback-databases' });
      await v1.register(attachmentRoutes(ctx), { prefix: '/attachments' });
      await v1.register(memberRoutes(ctx));
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
        message: `A screenshot may be at most ${Math.floor(LIMITS.attachmentMaxSourceBytes / (1024 * 1024))} MB.`,
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
