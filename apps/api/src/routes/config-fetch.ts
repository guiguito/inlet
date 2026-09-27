import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { parseContext, type CompiledConfig } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { createAddressCeiling } from '../lib/address-ceiling.js';
import { createCountrySource } from '../lib/country.js';
import { ApiError, apiError } from '../lib/errors.js';
import { requireConfigDatabase } from '../services/access.js';
import { answerFetch, CONFIG_FETCH_BODY_MAX_BYTES, compiledVersion, compileVersion, credentialFor, trackConfigCeiling } from '../services/config-delivery.js';
import { templateOf } from '../services/config-draft.js';
import { readConfigReach } from '../services/config-reach.js';
import { bearerToken, requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor } from './schemas.js';

/**
 * Delivery (Remote Config RC-040 to RC-049, RC-060, RC-070 to RC-072, PRD 7.1 to 7.3): the
 * fetch route an application calls with its publishable key, open cross-origin (FD-015); and
 * preview and reach, which a Viewer or above reads with a session or a secret key.
 */

const warningSchema = z.object({ path: z.string(), code: z.enum(['invalid', 'placeholder_user_id', 'too_many_attributes']) });
const jsonValue = z.unknown().describe('A JSON value.');

const answerSchema = z
  .object({
    version: z.int().nullable().describe('The active version’s number; null when nothing is published (RC-043).'),
    values: z.record(z.string(), jsonValue).describe('Every parameter’s key and resolved value.'),
    experiments: z.record(z.string(), z.string()).describe('Experiment key to variant, for each split whose population holds the context (RC-031).'),
    live: z.array(z.string()).describe('The keys of live parameters (RC-018).'),
    etag: z.string().describe('Appendix B.4: send it back as `etag` in the next fetch.'),
    refreshIntervalSeconds: z.int(),
    warnings: z.array(warningSchema).describe('RC-041: each context field treated as absent, by its path.'),
  })
  .register(z.globalRegistry, { id: 'ConfigAnswer' });
const notModifiedSchema = z.object({ notModified: z.literal(true), refreshIntervalSeconds: z.int() }).register(z.globalRegistry, { id: 'ConfigNotModified' });

const FETCH_DESCRIPTION = [
  'RC-040 to RC-049. A publishable or secret key of the owning project, as `Authorization: Bearer`. A publishable key may fetch and do nothing else with a config database.',
  'The body is the context of PRD section 9.2, every field optional, at most 16 KiB: `installationId` (a UUID), `userId` (≤ 128), `platform` (`web`, `ios`, `android`, `macos`, `windows`, `linux`, `server`, `other`), `os` `{name, version}`, `app` `{version, build, id}`, `locale` (BCP 47), `country` (ISO 3166-1 alpha-2), `attributes` (≤ 20; a string of ≤ 256 characters, a finite number or a boolean), `deriveCountry` (false turns derivation off), `sdk` `{name, version}` and `etag`, the last answer’s. An unknown field is ignored; a known one outside its bounds is treated as absent and reported in `warnings` (RC-041).',
  'Answers the resolved values of the active version, or `{notModified: true, refreshIntervalSeconds}` when `etag` equals the answer’s ETag. With nothing published: `version: null` and nothing else (RC-043). Compressed with Brotli or gzip when `Accept-Encoding` allows.',
  'The country, unless the context carries one or `deriveCountry: false`, its platform is `server`, the key is secret or the database’s derivation is off, comes from the trusted proxy’s header or the bundled IP-to-country database, only for a version with a rule on `country` (RC-045). Nothing from a fetch is stored but identity-free reach counts (RC-044).',
  'Rate limited in fetches per key over five minutes and the hour, per installation over five minutes, and per address behind a trusted proxy: `429 rate_limit_exceeded` with `Retry-After` (RC-046). Open cross-origin for POST (FD-015).',
].join('\n\n');

const source = z
  .union([z.enum(['draft', 'active']), z.int().min(1)])
  .default('draft')
  .describe('`draft` (the default), `active`, or a version number.');

const previewBodySchema = z.object({
  context: z.record(z.string(), z.unknown()).default({}).describe('The context of a fetch (PRD 9.2), read as the fetch reads it; its `country` is used as given, none is derived.'),
  source,
});

const problemSchema = z.object({ path: z.string(), code: z.string(), message: z.string(), parameter: z.string().optional(), condition: z.string().optional(), variant: z.string().optional() });

const previewSchema = z.object({
  source: z.union([z.enum(['draft', 'active']), z.int()]),
  version: z.int().nullable().describe('The version previewed; null for the draft, or `active` with nothing published.'),
  values: z.record(z.string(), jsonValue),
  experiments: z.record(z.string(), z.string()),
  live: z.array(z.string()),
  parameters: z.array(
    z.object({
      key: z.string(),
      value: jsonValue,
      source: z.union([
        z.object({ kind: z.literal('default') }),
        z.object({ kind: z.literal('condition'), condition: z.string(), name: z.string(), variant: z.string().optional() }),
      ]),
    }),
  ),
  conditions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(['match', 'split']),
      result: z.boolean(),
      variant: z.string().optional().describe('The variant a true split assigned.'),
      firstFalseRule: z.int().optional().describe('The index of the first rule that was false.'),
      unitMissing: z.boolean().optional().describe('The context lacks the installation or user ID the rule or split buckets by (RC-025).'),
      notEvaluated: z.boolean().optional().describe('Not evaluated because of a problem publishing would refuse; it is then false.'),
    }),
  ),
  problems: z.array(problemSchema).describe('RC-060: for the draft, each parameter or condition it could not evaluate as it stands.'),
  warnings: z.array(warningSchema).describe('RC-041: context fields treated as absent.'),
});

const smallCountSchema = z
  .union([z.object({ count: z.int() }), z.object({ count: z.null(), fewerThan: z.literal(10) }), z.object({ count: z.null(), withheld: z.literal(true) })])
  .describe(
    'RC-070: a count from 1 to 9 is never returned exactly: `{count: null, fewerThan: 10}`. A count of 10 or more that would reveal one by subtraction is `{count: null, withheld: true}`: a split’s count when one of its variants’ is hidden that day, and the last day’s when one of its two days’ is hidden or withheld. 0 is 0.',
  );

const reachSchema = z.object({
  unit: z.literal('fetches').describe('Every figure counts fetches, not devices.'),
  notice: z.string(),
  hourly: z.object({
    from: z.string(),
    to: z.string(),
    series: z.array(
      z.object({
        periodStart: z.string(),
        fetches: z.int().describe('Fetches answered, not-modified ones included.'),
        notModified: z.int(),
        versions: z.array(z.object({ version: z.int(), fetches: z.int() })),
        refused: z.array(z.object({ reason: z.string(), fetches: z.int() })),
      }),
    ),
  }),
  daily: z.object({
    from: z.string(),
    to: z.string(),
    series: z.array(
      z.object({
        periodStart: z.string(),
        conditions: z.array(z.object({ id: z.string(), fetches: smallCountSchema })),
        variants: z.array(z.object({ condition: z.string(), variant: z.string(), fetches: smallCountSchema })),
      }),
    ),
  }),
  summary: z.object({
    last24Hours: z
      .object({
        from: z.string(),
        fetches: z.int(),
        notModified: z.int(),
        versions: z.array(z.object({ version: z.int(), fetches: z.int(), share: z.number().nullable() })),
        activeVersion: z.int().nullable(),
        activeVersionShare: z.number().nullable().describe('Integrate: the share of the last 24 hours’ fetches answered from the active version.'),
      })
      .describe('RC-072, History: each version’s share of the last 24 hours’ fetches, in whole hours.'),
    lastDay: z
      .object({
        from: z.string(),
        fetches: z.int(),
        conditions: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            fetches: smallCountSchema,
            share: z.number().nullable().describe('Null when there were no fetches or the count is fewer than 10 or withheld.'),
            matchedNone: z.boolean(),
          }),
        ),
      })
      .describe('RC-072, Conditions view: each condition of the draft and the active version over today and yesterday (UTC).'),
  }),
});

const reachQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional().describe('RFC 3339. Default: 24 hours ago for the hourly series, 30 days ago for the daily one.'),
  to: z.iso.datetime({ offset: true }).optional().describe('RFC 3339. Default: now. A range is bounded to the 30 days kept.'),
});

export function configFetchRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    // RC-045, RC-046: its own country source and its own address ceiling, counted apart from ingest's.
    const country = createCountrySource({ header: ctx.env.INLET_COUNTRY_HEADER, databaseFile: ctx.env.INLET_IP_COUNTRY_DB, trustProxy: ctx.env.trustProxy, log: ctx.log });
    const ceiling = trackConfigCeiling(
      createAddressCeiling({ name: 'the config fetch', limitPerMinute: ctx.env.limits.configFetchPerAddressPerMinute, trustProxy: ctx.env.trustProxy, log: ctx.log }),
    );

    // The body is taken as sent: its size and JSON are checked once the database is known, so
    // that such a refusal counts in its reach (RC-070); Fastify's own limit only stops a flood.
    await app.register(async (plugin) => {
      const fetch = plugin.withTypeProvider<ZodTypeProvider>();
      fetch.removeContentTypeParser('application/json');
      fetch.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body));

      fetch.post(
        '/config-databases/:databaseId/fetch',
        {
          bodyLimit: 4 * CONFIG_FETCH_BODY_MAX_BYTES,
          // FD-030, RC-046: every installation shares one publishable key; the route counts fetches instead.
          config: { rateLimit: false },
          // RC-044: no line for a successful answer; refusals are logged below, by route pattern. Never
          // more verbose than the deployment's own level.
          logLevel: (['error', 'fatal', 'silent'] as const).find((level) => level === ctx.log.level) ?? 'warn',
          onError: async (request, _reply, error) => {
            const { code, status, statusCode } = error as { code?: string; status?: number; statusCode?: number };
            const answered = status ?? statusCode ?? 500;
            // A failure (5xx) is logged by the error handler, with its error.
            if (answered < 500) request.log.warn({ route: request.routeOptions.url, status: answered, code }, 'config fetch refused');
          },
          schema: {
            tags: ['Config fetch'],
            summary: 'Fetch the resolved values for a context',
            description: FETCH_DESCRIPTION,
            security: [{ projectKey: [] }],
            params: databaseIdParam,
            body: z.unknown(),
            response: { 200: z.union([answerSchema, notModifiedSchema]), ...errorsFor(400, 401, 403, 413, 429) },
          },
        },
        async (request, reply) => {
          const token = bearerToken(request);
          if (!token) throw apiError('unauthenticated', 'Send a project API key as "Authorization: Bearer <key>".');
          let answer;
          try {
            const credential = await credentialFor(ctx, token);
            answer = await answerFetch(ctx, {
              databaseId: request.params.databaseId,
              credential,
              rawBody: typeof request.body === 'string' ? request.body : undefined,
              acceptEncoding: request.headers['accept-encoding'],
              address: request.ip,
              countryOf: () => country.countryOf(request),
              ceiling,
            });
          } catch (error) {
            if (error instanceof ApiError) throw error;
            // RC-044: a failure is logged by its kind, never its message: a database error's message
            // carries the query's parameters (the key, the database ID).
            const { name, code } = error as { name?: string; code?: unknown };
            const cause = (error as { cause?: { code?: unknown } }).cause?.code;
            request.log.error({ route: request.routeOptions.url, kind: name, code: typeof code === 'string' ? code : typeof cause === 'string' ? cause : undefined }, 'config fetch failed');
            throw apiError('internal_error', 'Something went wrong on our side.');
          }
          reply.header('content-type', 'application/json; charset=utf-8').header('vary', 'Accept-Encoding').header('cache-control', 'no-store');
          if (answer.encoding) reply.header('content-encoding', answer.encoding);
          // The body is pre-serialised (and pre-compressed): a Buffer skips the serializer.
          return reply.send(answer.body as never);
        },
      );
    });

    app.post(
      '/config-databases/:databaseId/preview',
      {
        schema: {
          tags: ['Config fetch'],
          summary: 'Preview a context against the draft, the active version or a version',
          description:
            'RC-060. Viewer or above; not a publishable key. For each parameter, the value it would receive and the condition (and variant) that gave it, or the default; for each condition, whether it was true and, if not, the first false rule or the missing unit; and the experiments. A preview of the draft names each parameter or condition it could not evaluate because of a problem publishing would refuse. A preview of the active version returns exactly the values and experiments a fetch with the same context returns, except that no country is derived. Counts in no reach figure. `config_version_not_found` for a version that does not exist.',
          params: databaseIdParam,
          body: previewBodySchema,
          response: { 200: previewSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireConfigDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const { context, warnings } = parseContext(request.body.context);
        const asked = request.body.source;
        const number = asked === 'draft' ? null : asked === 'active' ? database.activeVersionNumber : asked;
        let compiledConfig: CompiledConfig | null = null;
        if (asked === 'draft') {
          compiledConfig = compileVersion(await templateOf(ctx, database, 'draft'), 0).config;
        } else if (number !== null) {
          // The compiled version the fetch path holds, so a preview of the active version is the fetch's evaluation.
          compiledConfig = (await compiledVersion(ctx, database.id, number)).config;
        }
        const explained = compiledConfig
          ? compiledConfig.explain(context, Date.now())
          : { values: {}, experiments: {}, parameters: [], conditions: [], problems: [] };
        return { source: asked, version: number, live: compiledConfig?.live ?? [], ...explained, warnings };
      },
    );

    app.get(
      '/config-databases/:databaseId/reach',
      {
        schema: {
          tags: ['Config fetch'],
          summary: 'Read the reach counts',
          description:
            'RC-070 to RC-072. Viewer or above. Fetches answered, not modified, per version and refused by reason, per hour; fetches for which each condition was true and per variant of each split, per day; and the summaries the interface shows. These are fetches, not devices. A count per condition or variant from 1 to 9 is `{count: null, fewerThan: 10}`, and one that would reveal such a count by subtraction `{count: null, withheld: true}`, each with no share. Written every ten seconds, kept 30 days.',
          params: databaseIdParam,
          querystring: reachQuerySchema,
          response: { 200: reachSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireConfigDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const { from, to } = request.query;
        return readConfigReach(ctx, database, { ...(from && { from: new Date(from) }), ...(to && { to: new Date(to) }) });
      },
    );
  };
}
