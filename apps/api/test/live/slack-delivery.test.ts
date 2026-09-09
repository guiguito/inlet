import { describe, expect, it } from 'vitest';
import { DEFAULT_SLACK_WEBHOOK_ORIGIN, slackWebhookUrlSchema } from '@inlet/shared';
import { sendSlackWebhook } from '../../src/services/notifications.js';
import { buildSlackMessage } from '../../src/services/slack-message.js';

/**
 * Posts one real message to a real Slack channel.
 *
 * Everything else about Slack delivery is covered without the network: the unit tests
 * check the message and the URL rules, and the integration tests drive the queue, the
 * retries and the terminal errors against a local fake. What none of them can prove is
 * that Slack itself accepts what we build — that the blocks are valid, that the fields
 * render, and that a webhook issued today still works the way the code assumes.
 *
 * So this file is opt-in and skipped by default. Set INLET_TEST_SLACK_WEBHOOK_URL to a
 * webhook you own and run it; a message lands in that channel, which is the point.
 *
 *     INLET_TEST_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
 *       npm run test:live -w @inlet/api
 *
 * The URL is a credential. Keep it in `.env`, which is not tracked, and never in a
 * committed file — including as a "harmless" test fixture, since a webhook URL is the
 * whole authorization to post in someone's workspace.
 */

const url = process.env.INLET_TEST_SLACK_WEBHOOK_URL?.trim();

describe.skipIf(!url)('posting to a real Slack workspace', () => {
  it('is a URL Slack could have issued', () => {
    expect(() => slackWebhookUrlSchema.parse(url)).not.toThrow();
  });

  it('delivers a message Slack accepts', async () => {
    const message = buildSlackMessage({
      databaseName: 'Inlet live test',
      databaseId: 'fdb_live_test',
      submissionId: 'sub_live_test',
      submissionUrl: 'https://example.com/databases/fdb_live_test/submissions/sub_live_test',
      // Null, as for a test message: this belongs to no published version.
      formVersion: null,
      createdAt: new Date(),
      answers: {},
      definition: undefined,
      attachmentCount: 0,
      via: 'the live delivery test',
      settings: {
        contentLevel: 'answers',
        messageTitle: 'Inlet live delivery test',
        channel: null,
        username: null,
        iconEmoji: null,
      },
    });

    const result = await sendSlackWebhook(url as string, message, [
      // The origin of the URL under test, so a deliberate relay can be exercised too.
      new URL(url as string).origin,
      DEFAULT_SLACK_WEBHOOK_ORIGIN,
    ]);

    // A failure here is worth reading rather than guessing at: Slack answers with a
    // plain-text code, and the result carries it.
    expect(result).toEqual({ kind: 'ok' });
  });
});
