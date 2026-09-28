import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ANALYTICS_PLATFORMS, ANALYTICS_RANGE_PRESETS, analyticsRangeSchema } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { requireEventStore } from '../db/clickhouse.js';
import { apiError } from '../lib/errors.js';
import { requireAnalyticsDatabase } from '../services/access.js';
import { runOverview } from '../services/analytics-overview.js';
import { clientGoneSignal, invalidQuery } from '../services/analytics-query.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor } from './schemas.js';

/**
 * Insights → Overview (UX Analytics AN-140 to AN-144, 7.2, Appendix E "Overview"). A secret key
 * or a signed-in session, Viewer or above; one query slot for the whole answer (AN-205).
 */

/** AN-140: a client platform; `server` is a backend's, which no active figure counts. */
const CLIENT_PLATFORMS = ANALYTICS_PLATFORMS.filter((platform) => platform !== 'server') as [string, ...string[]];

/** A filter given once or repeated (`?app=a&app=b`); values are free labels, so never split on commas. */
const list = (item: z.ZodType<string, string>) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => (value === undefined ? [] : [value].flat().filter((entry) => entry !== '')))
    .pipe(z.array(item).max(50));

const coveredSchema = z.object({ from: z.string(), to: z.string() }).nullable().describe('The part of the period the storage window holds (AN-143); null when none of it is.');
const figureSchema = z.object({
  value: z.number().nullable().describe('The figure; null when the period holds no data, or a share has no installation to divide by.'),
  previous: z.number().nullable().describe('The same figure for the previous period (AN-141); null when that period begins before the oldest event kept.'),
  covered: coveredSchema,
});
const perDaySchema = z.array(z.object({ day: z.string(), value: z.int() }));
const crashFreeSchema = z.object({
  rate: z.number().nullable().describe('1 − sessions flagged crashed ÷ sessions; null when not measured.'),
  sessions: z.int().describe('Sessions whose app_started falls in the range and reports a crash module (crashReporting true).'),
  measured: z.boolean().describe('False ("not measured") when no session reported a crash module.'),
  lowConfidence: z.boolean().describe('Fewer than 100 sessions.'),
});
const shareSchema = z.array(z.object({ value: z.string(), share: z.number(), installations: z.int(), other: z.literal(true).optional() }));

const overviewSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }).describe('The requested range as dates in the reporting timezone, both included.'),
  unit: z.enum(['installation', 'user']),
  timezone: z.string(),
  keptFrom: z.string().nullable().describe('The oldest day the database keeps (AN-065); null while it holds no event.'),
  filters: z.object({ apps: z.array(z.string()), platforms: z.array(z.string()) }).describe('The filters applied; an empty list is every value.'),
  figures: z.object({
    activeLastHour: figureSchema.extend({ covered: z.object({ from: z.string(), to: z.string() }).describe('RFC 3339 times.') }),
    dailyActiveLastDay: figureSchema,
    dailyActiveToday: figureSchema,
    weeklyActive: figureSchema,
    monthlyActive: figureSchema,
    stickiness: figureSchema,
    newInstallations: figureSchema.extend({ perDay: perDaySchema }),
    sessions: figureSchema.extend({ perDay: perDaySchema }),
    d1: figureSchema.extend({ installations: z.int().describe('Installations installed in the range whose day N has ended: the share’s denominator.') }),
    d7: figureSchema.extend({ installations: z.int() }),
    d30: figureSchema.extend({ installations: z.int() }),
  }),
  crashFree: z.object({
    covered: coveredSchema,
    overall: crashFreeSchema.extend({ previous: z.number().nullable() }),
    versions: z.array(crashFreeSchema.extend({ version: z.string() })).describe('The five app versions with the most sessions in the range.'),
  }),
  shares: z.object({ covered: coveredSchema, appVersion: shareSchema, platform: shareSchema, country: shareSchema }),
  topEvents: z.object({ computedAt: z.string().nullable(), events: z.array(z.object({ name: z.string(), events: z.int() })) }),
  dailyActive: z.object({ covered: coveredSchema, points: z.array(z.object({ start: z.string(), label: z.string(), value: z.int(), incomplete: z.boolean() })) }),
  versionsFirstSeen: z.array(z.object({ version: z.string(), day: z.string() })),
  notices: z.array(z.object({ code: z.enum(['no_events', 'no_app_started']), message: z.string() })),
});

const overviewQuerystring = z.object({
  preset: z.enum(ANALYTICS_RANGE_PRESETS).optional(),
  from: z.string().optional().describe('YYYY-MM-DD, with `to`.'),
  to: z.string().optional().describe('YYYY-MM-DD, with `from`.'),
  app: list(z.string().max(256)),
  platform: list(z.enum(CLIENT_PLATFORMS)),
  unit: z.enum(['installation', 'user']).default('installation'),
});

export function analyticsOverviewRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/analytics-databases/:databaseId/overview',
      {
        // Validation failures answer `invalid_query` with each path (PRD 7.4).
        attachValidation: true,
        schema: {
          tags: ['Analytics queries'],
          summary: 'Read the Overview',
          description: [
            'AN-140 to AN-144. Viewer or above; holds one query slot for the whole answer (`503 analytics_busy` after ten seconds without one, `503 query_limit_exceeded` past the per-query limits).',
            'The range is `preset` (default `last30Days`; presets end today and include it) or `from` and `to` (dates in the reporting timezone, both included, at most 1,000 days). `app` (every app by default), and `platform` (every client platform by default; `server` is never one) filter every figure; each may be repeated for several values. `unit` (`installation` by default, or `user`) is what the active figures count.',
            'Each figure has its `value`, its `previous` (null when the previous period begins before the oldest event kept) and the range it `covered`. Active figures are anchored to now, not the range: the last 60 minutes, the last complete day and today, the 7 and 30 days ending today, and stickiness. New installations, sessions, D1, D7 and D30 and crash-free sessions cover the range; shares cover the last 7 days; top events come from the catalog’s last 24 hours.',
          ].join('\n\n'),
          params: databaseIdParam,
          querystring: overviewQuerystring,
          response: { 200: overviewSchema, ...errorsFor(400, 401, 403, 404, 503) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        if (request.validationError) {
          const parsed = overviewQuerystring.safeParse(request.query);
          throw parsed.success ? apiError('invalid_query', request.validationError.message) : invalidQuery(parsed.error.issues);
        }
        const { preset, from, to, app: apps, platform: platforms, unit } = request.query;
        const raw = from !== undefined || to !== undefined ? { from, to } : { preset: preset ?? 'last30Days' };
        if (preset !== undefined && (from !== undefined || to !== undefined)) {
          throw invalidQuery([{ code: 'custom', path: ['range'], message: 'Send a preset, or from and to, not both.', input: raw }]);
        }
        const range = analyticsRangeSchema.safeParse(raw);
        if (!range.success) throw invalidQuery(range.error.issues, ['range']);
        requireEventStore(ctx.eventStore);
        return runOverview(ctx, database, principal, { range: range.data, apps, platforms, unit }, ctx.now(), clientGoneSignal(reply));
      },
    );
  };
}
