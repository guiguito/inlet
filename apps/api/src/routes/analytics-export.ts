import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { EVENT_NAME_PATTERN } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { requireAnalyticsDatabase } from '../services/access.js';
import { eventExportPage, eventExportPages } from '../services/analytics-export.js';
import { clientGoneSignal } from '../services/analytics-query.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor } from './schemas.js';

/**
 * The event export (UX Analytics AN-210, AN-204, AN-212, 7.2): newline-delimited JSON, streamed,
 * one event per line; with `limit`, one JSON page with a cursor, for MCP. Viewer or above.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD.');

const exportQuery = z.object({
  from: day.optional().describe('The first local day, in the reporting timezone; the oldest day kept by default.'),
  to: day.optional().describe('The last local day, included; today by default.'),
  name: z.string().regex(EVENT_NAME_PATTERN).optional().describe('One event name; a name never seen or deleted exports nothing.'),
  installationId: z.string().max(36).optional().describe('One installation ID (a UUID, any letter case).'),
  userId: z.string().min(1).max(128).optional().describe('One user ID, exactly as the application set it.'),
  limit: z.coerce.number().int().min(1).max(1_000).optional().describe('Answer one JSON page of at most this many events with `nextCursor`, instead of the stream (AN-204).'),
  cursor: z.string().max(500).optional().describe('The `nextCursor` of the previous page.'),
});

export function analyticsExportRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/analytics-databases/:databaseId/exports/events',
      {
        schema: {
          tags: ['Analytics'],
          summary: 'Export events as newline-delimited JSON',
          description:
            'AN-210. Viewer or above. Every stored event matching the filters, one JSON object per line, ordered by effective time then event ID: its ID, name, category, effective and received times (RFC 3339), local day, installation ID and kind, the ephemeral flag, user ID, session ID, context (the platform, OS, runtime, app, locale, country, attribution and experiments), params, install ages, whether the clock was corrected, and the key that sent it. Params, attribution, experiments and the user ID are the integrator’s. Read in pages of 5,000 events, each holding a query slot while it is read (AN-205); only events that had arrived when the export started. Events an erasure has taken are never exported. It holds every stored event, and not the installation records and first occurrences derived from them (AN-212). With `limit`, one JSON page `{ events, nextCursor }`.',
          params: databaseIdParam,
          querystring: exportQuery,
          produces: ['application/x-ndjson', 'application/json'],
          response: errorsFor(400, 401, 403, 404, 503),
        },
      },
      async (request, typedReply) => {
        // The 200 answer is a stream or a page, which the error-only response schema does not describe.
        const reply = typedReply as unknown as FastifyReply;
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const { limit, cursor, ...filters } = request.query;
        const signal = clientGoneSignal(reply);
        if (limit !== undefined) return reply.send(await eventExportPage(ctx, database, principal, { ...filters, cursor, limit }, signal));

        // The first page is read before the download starts, so a bad filter, a busy slot or an
        // outage answers with its status rather than an empty or cut file.
        const pages = eventExportPages(ctx, database, principal, filters, signal);
        const first = await pages.next();
        async function* lines(): AsyncGenerator<string> {
          for (let page = first; !page.done; page = await pages.next()) {
            for (const event of page.value) yield `${JSON.stringify(event)}\n`;
          }
        }
        return reply
          .type('application/x-ndjson; charset=utf-8')
          // No filter value in the file name: a download's name lands in browser histories and proxies.
          .header('content-disposition', `attachment; filename="inlet-${database.id}-events-${new Date().toISOString().slice(0, 10)}.ndjson"`)
          .send(Readable.from(lines()));
      },
    );
  };
}
