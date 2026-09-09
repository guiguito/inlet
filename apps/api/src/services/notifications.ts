import { eq, sql } from 'drizzle-orm';
import {
  NOTIFICATION_LIMITS,
  isAllowedWebhookOrigin,
  type SlackContentLevel,
} from '@inlet/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import {
  formVersions,
  notificationDeliveries,
  slackNotifications,
  submissions,
  type SlackNotificationRow,
} from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';
import { submissionUrl } from './export.js';
import { buildSlackMessage, type SlackMessage } from './slack-message.js';

/**
 * Slack notifications (FR-155 to FR-172).
 *
 * The governing rule, which every choice below serves: Slack being down must never
 * change whether feedback is collected, and must never be visible to a respondent.
 * Nothing on the request path talks to Slack. Finalization writes one row to a queue in
 * the same transaction that stores the submission, and this worker delivers it later.
 */

/** How long a claimed row is left alone before another worker may take it. */
const LEASE_SECONDS = 60;
const BATCH_SIZE = 10;
/** Slack allows one message per second per channel, with short bursts tolerated. */
const DEFAULT_PACE_MS = 1_100;
/**
 * Fewer than the purge queue's ten. A dead webhook is diagnosed from the recorded Slack
 * error, not from persistence, and most terminal outcomes stop after one attempt anyway.
 */
const MAX_ATTEMPTS = 5;

/**
 * Slack error strings that no amount of retrying will fix.
 *
 * Split by whose problem it is. `invalid_payload` means our renderer produced something
 * Slack will not take, and no later attempt sends anything different. The rest mean the
 * webhook or its channel is gone, which a person has to fix in Slack or in the settings.
 */
const PERMANENT_SLACK_ERRORS = new Set([
  'invalid_payload',
  'action_prohibited',
  'no_service',
  'no_service_id',
  'no_team',
  'invalid_token',
  'no_active_hooks',
  'team_disabled',
  'channel_not_found',
  'channel_is_archived',
  'user_not_found',
]);

// --- Settings ---------------------------------------------------------------

/** FR-156: created disabled on first read, as a hosted form is. */
export async function getSlackNotifications(
  ctx: AppContext,
  databaseId: string,
): Promise<SlackNotificationRow> {
  const existing = await ctx.db
    .select()
    .from(slackNotifications)
    .where(eq(slackNotifications.feedbackDatabaseId, databaseId))
    .limit(1);
  if (existing[0]) return existing[0];

  const inserted = await ctx.db
    .insert(slackNotifications)
    .values({ feedbackDatabaseId: databaseId })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const raced = await ctx.db
    .select()
    .from(slackNotifications)
    .where(eq(slackNotifications.feedbackDatabaseId, databaseId))
    .limit(1);
  const row = raced[0];
  if (!row) throw apiError('internal_error', 'Notification settings could not be read.');
  return row;
}

export type SlackNotificationPatch = {
  enabled?: boolean;
  webhookUrl?: string | null;
  contentLevel?: SlackContentLevel;
  messageTitle?: string | null;
  channel?: string | null;
  username?: string | null;
  iconEmoji?: string | null;
};

export async function updateSlackNotifications(
  ctx: AppContext,
  databaseId: string,
  patch: SlackNotificationPatch,
): Promise<SlackNotificationRow> {
  const current = await getSlackNotifications(ctx, databaseId);

  if (typeof patch.webhookUrl === 'string') {
    assertWebhookAllowed(ctx, patch.webhookUrl);
  }

  // Clearing the URL turns collection off with it, rather than leaving a switch on with
  // nowhere to send.
  const clearing = patch.webhookUrl === null;
  const url = clearing ? null : (patch.webhookUrl ?? current.webhookUrl);

  const enabled = clearing ? false : (patch.enabled ?? current.enabled);
  if (enabled && !url) {
    throw apiError(
      'validation_failed',
      'Add a Slack webhook URL before switching notifications on.',
      [{ path: 'webhookUrl', code: 'required', message: 'A webhook URL is needed.' }],
    );
  }

  const updated = await ctx.db
    .update(slackNotifications)
    .set({
      ...patch,
      ...(clearing ? { webhookUrl: null, enabled: false } : {}),
      enabled,
      updatedAt: new Date(),
    })
    .where(eq(slackNotifications.feedbackDatabaseId, databaseId))
    .returning();
  const row = updated[0];
  if (!row) throw errors.databaseNotFound();
  return row;
}

/**
 * FR-163: the origin check, applied when a URL is saved and again before every send.
 *
 * Checking twice is not belt and braces for its own sake: the second check is what covers
 * a row written before this validator existed, or edited directly in the database.
 */
function assertWebhookAllowed(ctx: AppContext, url: string): void {
  if (isAllowedWebhookOrigin(url, ctx.env.slackWebhookOrigins)) return;
  throw apiError(
    'validation_failed',
    `A Slack webhook URL must start with ${ctx.env.slackWebhookOrigins.join(' or ')}.`,
    [
      {
        path: 'webhookUrl',
        code: 'origin_not_allowed',
        message: 'That address is not a Slack webhook.',
      },
    ],
  );
}

// --- Enqueue ----------------------------------------------------------------

/**
 * FR-158: called inside the transaction that stores the submission.
 *
 * One statement, so there is no read-then-branch and no extra round trip, and the
 * `where exists` means nothing is queued when notifications are off. That last part is
 * what stops switching notifications on from announcing every historical submission at
 * once.
 *
 * `on conflict do nothing` against the unique index on `submission_id` makes a second
 * delivery for one submission impossible in the database rather than merely unreachable
 * through the finalization control flow.
 */
export async function enqueueNotification(
  tx: Db,
  databaseId: string,
  submissionId: string,
): Promise<void> {
  await tx.execute(sql`
    insert into notification_deliveries (submission_id, feedback_database_id)
    select ${submissionId}, ${databaseId}
    where exists (
      select 1 from slack_notifications
      where feedback_database_id = ${databaseId}
        and enabled
        and webhook_url is not null
    )
    on conflict (submission_id) do nothing
  `);
}

// --- Sending ----------------------------------------------------------------

export type SlackSendResult =
  | { kind: 'ok' }
  | { kind: 'retry'; reason: string; retryAfterSeconds?: number }
  | { kind: 'permanent'; reason: string };

/**
 * The only outbound HTTP the product makes.
 *
 * Returns a verdict instead of throwing, so the retry-or-give-up decision is one
 * exhaustive switch that a test can drive directly rather than an exception taxonomy.
 *
 * Nothing here ever includes the webhook URL in its reason. That string is shown to the
 * operator as `lastError`, and the URL is a credential.
 */
export async function sendSlackWebhook(
  url: string,
  payload: SlackMessage,
  allowedOrigins: readonly string[],
): Promise<SlackSendResult> {
  if (!isAllowedWebhookOrigin(url, allowedOrigins)) {
    return { kind: 'permanent', reason: 'origin_not_allowed' };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // Slack never redirects. Anything that does is not Slack, and following it is how a
      // request ends up somewhere nobody chose.
      redirect: 'manual',
      // Undici's defaults allow a peer to hold a request open for minutes; there is no
      // total-request timeout without this.
      signal: AbortSignal.timeout(NOTIFICATION_LIMITS.sendTimeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { kind: 'retry', reason: 'timeout' };
    }
    return { kind: 'retry', reason: 'network' };
  }

  if (response.status >= 300 && response.status < 400) {
    return { kind: 'permanent', reason: 'unexpected_redirect' };
  }
  if (response.type === 'opaqueredirect' || response.status === 0) {
    return { kind: 'permanent', reason: 'unexpected_redirect' };
  }

  const body = (await readBounded(response, NOTIFICATION_LIMITS.responseReadMaxBytes)).trim();

  if (response.ok) {
    if (body === 'ok') return { kind: 'ok' };
    // Slack's contract is 200 with the body "ok". Something else answering 200 is not
    // actionable by retrying.
    return { kind: 'permanent', reason: body === '' ? 'empty_response' : `slack: ${body}` };
  }

  if (response.status === 429) {
    return {
      kind: 'retry',
      reason: 'rate_limited',
      retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
    };
  }
  if (response.status >= 500 || response.status === 408) {
    return { kind: 'retry', reason: `http ${response.status}` };
  }
  if (PERMANENT_SLACK_ERRORS.has(body)) {
    return { kind: 'permanent', reason: `slack: ${body}` };
  }
  return { kind: 'permanent', reason: `http ${response.status}${body === '' ? '' : `: ${body}`}` };
}

/**
 * Reads at most a kilobyte of the response.
 *
 * `response.text()` buffers whatever arrives before anything can bound it. Slack's
 * answers are one short word, so a kilobyte is generous and the cap costs nothing.
 */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
    }
  } catch {
    // A truncated body is not worth failing over; the status already decided the verdict.
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8').slice(0, maxBytes);
}

/** `Retry-After` may be absent, non-numeric, or an HTTP date. Slack's own floor is one second. */
function parseRetryAfter(header: string | null): number {
  const seconds = Number.parseInt(header ?? '', 10);
  if (!Number.isFinite(seconds)) return 1;
  return Math.min(Math.max(seconds, 1), 300);
}

// --- The worker -------------------------------------------------------------

export type BatchOptions = {
  /** Milliseconds between sends. Tests pass 0; the default respects Slack's rate limit. */
  paceMs?: number;
};

/**
 * Delivers one batch. Returns how many messages Slack accepted.
 *
 * The claim is one atomic statement rather than the purge queue's plain select, because
 * deleting an object twice is a no-op and sending a Slack message twice is not. It also
 * increments `attempts` on claim rather than on failure, so a worker killed mid-send has
 * already spent an attempt and cannot spin, and the sixty-second lease means a dead
 * worker's row simply becomes due again with no sweeper to write.
 */
export async function runNotificationBatch(
  ctx: AppContext,
  options: BatchOptions = {},
): Promise<number> {
  const paceMs = options.paceMs ?? DEFAULT_PACE_MS;

  const claimed = await ctx.db.execute(sql`
    update notification_deliveries
       set attempts = attempts + 1,
           next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
     where id in (
       select id from notification_deliveries
        where status = 'pending' and next_attempt_at <= now()
        order by next_attempt_at
        limit ${BATCH_SIZE}
        for update skip locked
     )
    returning id, submission_id, feedback_database_id, attempts
  `);

  const rows = (claimed as unknown as { rows: DeliveryClaim[] }).rows ?? [];
  if (rows.length === 0) return 0;

  let delivered = 0;
  for (const [index, row] of rows.entries()) {
    // Between sends, not before the first, so a single-row batch is not delayed.
    if (index > 0 && paceMs > 0) await sleep(paceMs);
    if (await deliverOne(ctx, row)) delivered += 1;
  }
  return delivered;
}

type DeliveryClaim = {
  id: number;
  submission_id: string;
  feedback_database_id: string;
  attempts: number;
};

async function deliverOne(ctx: AppContext, claim: DeliveryClaim): Promise<boolean> {
  const rendered = await render(ctx, claim);

  // Nothing to announce. A deleted submission, or notifications switched off between the
  // enqueue and now: the setting in force at delivery is the one that applies, and an
  // operator who deleted a response does not want it echoed into a channel afterwards.
  if (rendered === 'nothing') {
    await ctx.db.delete(notificationDeliveries).where(eq(notificationDeliveries.id, claim.id));
    return false;
  }

  const result = await sendSlackWebhook(
    rendered.url,
    rendered.message,
    ctx.env.slackWebhookOrigins,
  );

  if (result.kind === 'ok') {
    await ctx.db
      .update(notificationDeliveries)
      .set({ status: 'sent', sentAt: new Date(), lastError: null })
      .where(eq(notificationDeliveries.id, claim.id));
    await ctx.db
      .update(slackNotifications)
      .set({ lastDeliveryAt: new Date(), lastError: null, lastErrorAt: null })
      .where(eq(slackNotifications.feedbackDatabaseId, claim.feedback_database_id));
    return true;
  }

  const permanent = result.kind === 'permanent' || claim.attempts >= MAX_ATTEMPTS;
  ctx.log[permanent ? 'warn' : 'info'](
    {
      deliveryId: claim.id,
      submissionId: claim.submission_id,
      reason: result.reason,
      attempts: claim.attempts,
    },
    'slack notification not delivered',
  );

  if (permanent) {
    await ctx.db
      .update(notificationDeliveries)
      .set({ status: 'failed', lastError: result.reason.slice(0, 500) })
      .where(eq(notificationDeliveries.id, claim.id));
  } else if (result.retryAfterSeconds !== undefined) {
    // Being throttled is not the notification's fault, so the attempt is given back.
    // Otherwise a busy channel would drive a perfectly good message into `failed`.
    await ctx.db.execute(sql`
      update notification_deliveries
         set attempts = greatest(attempts - 1, 0),
             last_error = ${result.reason},
             next_attempt_at = now() + make_interval(secs => ${result.retryAfterSeconds})
       where id = ${claim.id}
    `);
  } else {
    const delaySeconds = Math.min(2 ** claim.attempts, 3600);
    await ctx.db.execute(sql`
      update notification_deliveries
         set last_error = ${result.reason},
             next_attempt_at = now() + make_interval(secs => ${delaySeconds})
       where id = ${claim.id}
    `);
  }

  // The operator sees the reason on the settings page; the queue row is the forensics.
  await ctx.db
    .update(slackNotifications)
    .set({ lastError: result.reason.slice(0, 500), lastErrorAt: new Date() })
    .where(eq(slackNotifications.feedbackDatabaseId, claim.feedback_database_id));

  return false;
}

/** Reads the submission and settings as they are now, and renders the message. */
async function render(
  ctx: AppContext,
  claim: DeliveryClaim,
): Promise<'nothing' | { url: string; message: SlackMessage }> {
  const rows = await ctx.db
    .select({
      submission: submissions,
      settings: slackNotifications,
      definition: formVersions.definition,
      databaseName: sql<string>`(select name from feedback_databases where id = ${claim.feedback_database_id})`,
    })
    .from(submissions)
    .innerJoin(
      slackNotifications,
      eq(slackNotifications.feedbackDatabaseId, submissions.feedbackDatabaseId),
    )
    .leftJoin(formVersions, eq(formVersions.id, submissions.formVersionId))
    .where(eq(submissions.id, claim.submission_id))
    .limit(1);

  const found = rows[0];
  if (!found) return 'nothing';
  if (!found.settings.enabled || !found.settings.webhookUrl) return 'nothing';

  const answers = found.submission.answers;
  const attachmentCount = Object.values(answers).reduce(
    (total, answer) => total + (answer.type === 'screenshot' ? answer.attachmentIds.length : 0),
    0,
  );

  return {
    url: found.settings.webhookUrl,
    message: buildSlackMessage({
      databaseName: found.databaseName ?? 'a feedback database',
      databaseId: claim.feedback_database_id,
      submissionId: found.submission.id,
      submissionUrl: submissionUrl(ctx, claim.feedback_database_id, found.submission.id),
      formVersion: found.submission.formVersion,
      createdAt: found.submission.createdAt,
      answers,
      definition: found.definition ?? undefined,
      attachmentCount,
      via: arrivalPath(found.submission.clientContext),
      settings: found.settings,
    }),
  };
}

/** How the submission arrived, for the metadata line. Never respondent-authored. */
function arrivalPath(clientContext: unknown): string | null {
  if (clientContext === null || typeof clientContext !== 'object') return null;
  const via = (clientContext as { via?: unknown }).via;
  if (via === 'hosted') return 'via the shared link';
  return 'via the API';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts the background worker.
 *
 * Unlike the purge worker's stopper, this one returns a promise and must be awaited
 * before the database pool closes. A send in flight when the pool goes away cannot record
 * that it succeeded, so its lease expires and Slack receives the message a second time —
 * which makes an ordinary deploy the most likely source of a duplicate.
 *
 * ponytail: in-process timer, one instance. The claim query already uses
 * `for update skip locked`, so a second instance would not double-send; it would just
 * share the work.
 */
export function startNotificationWorker(
  ctx: AppContext,
  intervalMs = 5_000,
): () => Promise<void> {
  let inFlight: Promise<unknown> = Promise.resolve();
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    inFlight = runNotificationBatch(ctx)
      .catch((error: unknown) => ctx.log.error({ err: error }, 'slack notification worker failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();

  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}

// --- The test message -------------------------------------------------------

/**
 * FR-168: sends a sample message immediately and reports what Slack said.
 *
 * Synchronous rather than queued, because the operator is standing there having just
 * pasted a URL, and the whole point is to turn a misconfigured webhook from a silent
 * asynchronous failure into an answer on screen.
 *
 * The content is placeholder text, never a real submission. That makes the privacy
 * setting concrete before it applies to anybody's actual answer, and means testing an
 * integration never exposes a respondent.
 */
export async function sendTestMessage(
  ctx: AppContext,
  databaseId: string,
  databaseName: string,
): Promise<{ delivered: true }> {
  const settings = await getSlackNotifications(ctx, databaseId);
  if (!settings.webhookUrl) {
    throw apiError('validation_failed', 'Add a Slack webhook URL first.', [
      { path: 'webhookUrl', code: 'required', message: 'A webhook URL is needed.' },
    ]);
  }

  const note =
    settings.contentLevel === 'link_only'
      ? 'Real notifications will carry no answer content.'
      : settings.contentLevel === 'answers'
        ? 'Real notifications will include answer content.'
        : 'Real notifications will include answer content and collected email addresses.';

  const message = buildSlackMessage({
    databaseName,
    databaseId,
    submissionId: 'sub_example',
    submissionUrl: `${ctx.env.INLET_PUBLIC_URL.replace(/\/$/, '')}/databases/${databaseId}`,
    formVersion: 0,
    createdAt: new Date(),
    answers: { el_example000: { type: 'text', value: `Example answer. ${note}` } },
    definition: {
      pages: [
        {
          id: 'pg_example00',
          elements: [
            {
              id: 'el_example000',
              type: 'text',
              label: 'Example question',
              required: false,
              multiline: false,
              maxLength: 500,
            },
          ],
        },
      ],
    },
    attachmentCount: 0,
    via: null,
    settings: {
      ...settings,
      messageTitle: settings.messageTitle ?? `Test message from Inlet · ${databaseName}`,
      contentLevel: settings.contentLevel === 'link_only' ? 'answers' : settings.contentLevel,
    },
  });

  const result = await sendSlackWebhook(
    settings.webhookUrl,
    message,
    ctx.env.slackWebhookOrigins,
  );

  if (result.kind === 'ok') {
    await ctx.db
      .update(slackNotifications)
      .set({ lastDeliveryAt: new Date(), lastError: null, lastErrorAt: null })
      .where(eq(slackNotifications.feedbackDatabaseId, databaseId));
    return { delivered: true };
  }

  await ctx.db
    .update(slackNotifications)
    .set({ lastError: result.reason.slice(0, 500), lastErrorAt: new Date() })
    .where(eq(slackNotifications.feedbackDatabaseId, databaseId));

  throw apiError('slack_delivery_failed', `Slack did not accept the message (${result.reason}).`, [
    { path: 'webhookUrl', code: result.reason, message: slackAdvice(result.reason) },
  ]);
}

/** Turns a Slack error string into something an operator can act on. */
function slackAdvice(reason: string): string {
  if (reason.includes('no_service') || reason.includes('invalid_token')) {
    return 'Slack does not recognise this webhook. It may have been deleted or regenerated.';
  }
  if (reason.includes('channel_not_found')) return 'That channel does not exist in Slack.';
  if (reason.includes('channel_is_archived')) return 'That channel is archived in Slack.';
  if (reason.includes('action_prohibited')) return 'A Slack admin policy blocked the message.';
  if (reason === 'timeout' || reason === 'network') return 'Slack could not be reached. Try again.';
  if (reason === 'origin_not_allowed') return 'That address is not a Slack webhook.';
  return 'Slack refused the message.';
}
