import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SLACK_WEBHOOK_ORIGIN,
  escapeSlackText,
  isAllowedWebhookOrigin,
  maskWebhookUrl,
  slackChannelSchema,
  slackIconEmojiSchema,
  slackWebhookUrlSchema,
  truncateByCodePoint,
  type FormDefinition,
  type StoredAnswers,
} from '@inlet/shared';
import { buildSlackMessage, type SlackMessageInput } from '../../src/services/slack-message.js';

/** Slack notification rendering and validation (FR-159 to FR-166). */

/** Shaped exactly like a Slack webhook, and deliberately not anybody's real one. */
const REAL = 'https://hooks.slack.com/services/T00EXAMPLE1/B00EXAMPLE2/example-webhook-secret-9xyz';

describe('the webhook URL', () => {
  it('accepts the shape Slack issues', () => {
    expect(slackWebhookUrlSchema.parse(`  ${REAL}  `)).toBe(REAL);
  });

  it('refuses the shapes that are not a webhook, including the ones that look like one', () => {
    for (const bad of [
      'not a url',
      'file:///etc/passwd',
      'https://hooks.slack.com/nope',
      'https://hooks.slack.com/services/only/two',
      `${REAL}?x=1`,
      `${REAL}#fragment`,
      // Credentials before the host: `hostname` is evil.example, which is the whole
      // reason the check is on hostname rather than on the string.
      'https://user@hooks.slack.com@evil.example/services/T1/B1/abc',
    ]) {
      expect(slackWebhookUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('lets only the configured origins be posted to (FR-163)', () => {
    const allowed = [DEFAULT_SLACK_WEBHOOK_ORIGIN];
    expect(isAllowedWebhookOrigin(REAL, allowed)).toBe(true);

    for (const bad of [
      'http://hooks.slack.com/services/T1/B1/abc',
      'https://hooks.slack.com.evil.example/services/T1/B1/abc',
      'https://evil.example/services/T1/B1/abc',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:6379/services/T1/B1/abc',
      'http://127.0.0.1/services/T1/B1/abc',
      'http://[::1]/services/T1/B1/abc',
      'http://2130706433/services/T1/B1/abc',
      'https://hooks.slack.com:8443/services/T1/B1/abc',
    ]) {
      expect(isAllowedWebhookOrigin(bad, allowed), bad).toBe(false);
    }
  });

  it('allows a deployment to add an origin without loosening anything else', () => {
    const allowed = [DEFAULT_SLACK_WEBHOOK_ORIGIN, 'http://127.0.0.1:9999'];
    expect(isAllowedWebhookOrigin('http://127.0.0.1:9999/services/T1/B1/abc', allowed)).toBe(true);
    expect(isAllowedWebhookOrigin('http://127.0.0.1:9998/services/T1/B1/abc', allowed)).toBe(false);
  });

  it('masks to something recognisable but unusable', () => {
    const masked = maskWebhookUrl(REAL);
    expect(masked).toBe('hooks.slack.com/services/…/…/••••9xyz');
    expect(REAL.endsWith('9xyz')).toBe(true);
    // The part that matters: the secret cannot be reconstructed from the mask.
    expect(masked).not.toContain('example-webhook-secret-9xyz');
    expect(masked).not.toContain('B00EXAMPLE2');
  });
});

describe('the personalization fields', () => {
  it('accepts a channel or a person and refuses Slack markup', () => {
    expect(slackChannelSchema.parse(' #feedback ')).toBe('#feedback');
    expect(slackChannelSchema.parse('@someone')).toBe('@someone');
    for (const bad of ['feedback', '#has space', '#with<markup>', '']) {
      expect(slackChannelSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts an emoji name and nothing else', () => {
    expect(slackIconEmojiSchema.parse(':inbox_tray:')).toBe(':inbox_tray:');
    for (const bad of ['inbox_tray', ':Inbox:', '📥', ':a b:']) {
      expect(slackIconEmojiSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('escaping and truncation', () => {
  it('neutralises every Slack mention and link form', () => {
    expect(escapeSlackText('<!channel> now')).toBe('&lt;!channel&gt; now');
    expect(escapeSlackText('<!here>')).toBe('&lt;!here&gt;');
    expect(escapeSlackText('<@U012ABCDEF>')).toBe('&lt;@U012ABCDEF&gt;');
    expect(escapeSlackText('<#C012ABCDEF>')).toBe('&lt;#C012ABCDEF&gt;');
    expect(escapeSlackText('<https://evil.example|Reset your password>')).toBe(
      '&lt;https://evil.example|Reset your password&gt;',
    );
    // The ampersand goes first, or the escaped entities would be escaped again.
    expect(escapeSlackText('a & b')).toBe('a &amp; b');
  });

  it('leaves quotes alone, unlike HTML escaping', () => {
    expect(escapeSlackText(`it's "fine"`)).toBe(`it's "fine"`);
  });

  it('cuts by code point, so an emoji is never split into a lone surrogate', () => {
    const emoji = '😍'.repeat(10);
    const cut = truncateByCodePoint(emoji, 4);
    expect([...cut]).toHaveLength(5);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('leaves text that already fits untouched', () => {
    expect(truncateByCodePoint('short', 300)).toBe('short');
  });
});

// --- The message ------------------------------------------------------------

const MOOD = 'el_mood00000';
const DETAIL = 'el_detail000';
const EMAIL = 'el_email0000';
const SHOT = 'el_shot00000';

function definition(): FormDefinition {
  return {
    pages: [
      {
        id: 'pg_one000000',
        elements: [
          { id: 'el_title0000', type: 'title', text: 'How was it?' },
          {
            id: MOOD,
            type: 'choice',
            label: 'How do you feel about the app?',
            required: true,
            optionKind: 'emoji',
            selection: 'single',
            orientation: 'horizontal',
            options: [
              { id: 'op_love00000', label: 'Love it', emoji: '😍' },
              { id: 'op_broke0000', label: 'Broken', emoji: '😡' },
            ],
          },
          {
            id: DETAIL,
            type: 'text',
            label: 'What should we fix first?',
            required: true,
            multiline: true,
            maxLength: 500,
          },
          { id: EMAIL, type: 'email', label: 'Email for follow-up', required: false },
          { id: SHOT, type: 'screenshot', label: 'Attach a screenshot', required: false, maxCount: 3 },
        ],
      },
    ],
  };
}

function answers(overrides: StoredAnswers = {}): StoredAnswers {
  return {
    [MOOD]: { type: 'choice', optionIds: ['op_love00000'] },
    [DETAIL]: { type: 'text', value: 'The card freeze toggle takes three taps.' },
    [EMAIL]: { type: 'email', value: 'respondent@example.com' },
    [SHOT]: { type: 'screenshot', attachmentIds: ['att_one000000', 'att_two000000'] },
    ...overrides,
  };
}

function input(overrides: Partial<SlackMessageInput> = {}): SlackMessageInput {
  return {
    databaseName: 'Beta feedback',
    databaseId: 'fdb_beta00000',
    submissionId: 'sub_one000000',
    submissionUrl: 'https://inlet.example/databases/fdb_beta00000/submissions/sub_one000000',
    formVersion: 3,
    createdAt: new Date('2026-09-09T14:02:11.000Z'),
    answers: answers(),
    definition: definition(),
    attachmentCount: 2,
    via: 'via the shared link',
    settings: {
      contentLevel: 'answers',
      messageTitle: null,
      channel: null,
      username: null,
      iconEmoji: null,
    },
    ...overrides,
  };
}

/** Everything the message would carry, as one string, for negative assertions. */
function serialized(overrides: Partial<SlackMessageInput> = {}): string {
  return JSON.stringify(buildSlackMessage(input(overrides)));
}

describe('buildSlackMessage', () => {
  it('names the feedback database and links to the response', () => {
    const message = buildSlackMessage(input());
    expect(message.text).toBe('New response in Beta feedback');
    expect(JSON.stringify(message.blocks[0])).toContain(
      '<https://inlet.example/databases/fdb_beta00000/submissions/sub_one000000|Open in Inlet>',
    );
  });

  it('carries the answers, with the labels the respondent saw', () => {
    const body = serialized();
    // The question is bold so it is legible against its answer; the answer is not.
    expect(body).toContain('*How do you feel about the app?*');
    expect(body).toContain('😍 Love it');
    expect(body).toContain('The card freeze toggle takes three taps.');
  });

  it('omits the version line for a message that belongs to no version', () => {
    const body = serialized({ formVersion: null, via: 'a test message' });
    expect(body).not.toContain('Version');
    expect(body).toContain('a test message');
  });

  it('withholds the email address until that is opted into specifically', () => {
    const withheld = serialized();
    expect(withheld).toContain('Email for follow-up');
    expect(withheld).toContain('(email address collected)');
    expect(withheld).not.toContain('respondent@example.com');

    const shown = serialized({
      settings: { ...input().settings, contentLevel: 'answers_with_email' },
    });
    expect(shown).toContain('respondent@example.com');
  });

  it('carries no answer content at all when the level is link only', () => {
    const body = serialized({ settings: { ...input().settings, contentLevel: 'link_only' } });
    // Asserted negatively, because this is the privacy guarantee rather than a preference.
    expect(body).not.toContain('The card freeze toggle');
    expect(body).not.toContain('respondent@example.com');
    expect(body).not.toContain('Love it');
    expect(body).not.toContain('att_one000000');
    // The link and the heading still work.
    expect(body).toContain('Open in Inlet');
    expect(body).toContain('New response in Beta feedback');
  });

  it('reports screenshots as a count and never as a URL', () => {
    const body = serialized();
    expect(body).toContain('2 screenshots');
    expect(body).not.toContain('/v1/attachments/');
    expect(body).not.toContain('att_one000000');
  });

  it('keeps the fallback text content-free at every level', () => {
    for (const contentLevel of ['link_only', 'answers', 'answers_with_email'] as const) {
      const message = buildSlackMessage(input({ settings: { ...input().settings, contentLevel } }));
      // This string is what Slack shows on a lock screen and in the channel list.
      expect(message.text, contentLevel).toBe('New response in Beta feedback');
    }
  });

  it('escapes a mention a respondent typed into an answer', () => {
    const body = serialized({
      answers: answers({ [DETAIL]: { type: 'text', value: '<!channel> checkout is broken' } }),
    });
    expect(body).toContain('&lt;!channel&gt;');
    expect(body).not.toContain('<!channel>');
  });

  it('escapes a link a respondent typed into an answer', () => {
    const body = serialized({
      answers: answers({
        [DETAIL]: { type: 'text', value: '<https://evil.example|Reset your password>' },
      }),
    });
    expect(body).not.toContain('<https://evil.example|');
    expect(body).toContain('&lt;https://evil.example|Reset your password&gt;');
  });

  it('lets an operator use a mention in their own heading', () => {
    const message = buildSlackMessage(
      input({ settings: { ...input().settings, messageTitle: '<!here> new beta feedback' } }),
    );
    expect(message.text).toBe('<!here> new beta feedback');
    expect(JSON.stringify(message.blocks[0])).toContain('<!here>');
  });

  it('truncates a very long answer', () => {
    const body = serialized({
      answers: answers({ [DETAIL]: { type: 'text', value: 'x'.repeat(5000) } }),
    });
    expect(body).toContain('…');
    expect(body.length).toBeLessThan(4000);
  });

  it('caps how many answers it shows and says how many are left', () => {
    const many: FormDefinition = {
      pages: [
        {
          id: 'pg_many00000',
          elements: Array.from({ length: 30 }, (_, index) => ({
            id: `el_q${String(index).padStart(9, '0')}`,
            type: 'text' as const,
            label: `Question ${index}`,
            required: false,
            multiline: false,
            maxLength: 100,
          })),
        },
      ],
    };
    const all: StoredAnswers = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `el_q${String(index).padStart(9, '0')}`,
        { type: 'text' as const, value: `answer ${index}` },
      ]),
    );

    const message = buildSlackMessage(input({ definition: many, answers: all }));
    expect(message.blocks.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(message)).toContain('+ 20 more answers');
    const fields = message.blocks.find(
      (block) => (block as { fields?: unknown[] }).fields !== undefined,
    ) as { fields: unknown[] };
    expect(fields.fields).toHaveLength(10);
  });

  it('degrades to the link when the assembled payload is still too large', () => {
    const wide: FormDefinition = {
      pages: [
        {
          id: 'pg_wide00000',
          elements: Array.from({ length: 10 }, (_, index) => ({
            id: `el_w${String(index).padStart(9, '0')}`,
            type: 'text' as const,
            label: '漢'.repeat(80),
            required: false,
            multiline: true,
            maxLength: 10_000,
          })),
        },
      ],
    };
    const huge: StoredAnswers = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `el_w${String(index).padStart(9, '0')}`,
        { type: 'text' as const, value: '漢'.repeat(300) },
      ]),
    );
    const message = buildSlackMessage(input({ definition: wide, answers: huge }));
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(30_000);
  });

  it('reports the submission time, not the time it was sent', () => {
    const body = serialized();
    expect(body).toContain('2026-09-09 14:02 UTC');
    expect(body).toContain('Version 3');
    expect(body).toContain('via the shared link');
  });

  it('reports the screenshot count once, not twice', () => {
    // With the answers shown, the screenshot answer already says how many there are.
    const withAnswers = buildSlackMessage(input());
    const metadata = JSON.stringify(withAnswers.blocks.at(-1));
    expect(metadata).not.toContain('screenshot');

    // With only a link, the count is the one place it could appear.
    const linkOnly = buildSlackMessage(
      input({ settings: { ...input().settings, contentLevel: 'link_only' } }),
    );
    expect(JSON.stringify(linkOnly.blocks.at(-1))).toContain('2 screenshots');
  });

  it('omits an unset override rather than sending null', () => {
    const bare = buildSlackMessage(input());
    expect('channel' in bare).toBe(false);
    expect('username' in bare).toBe(false);
    expect('icon_emoji' in bare).toBe(false);

    const dressed = buildSlackMessage(
      input({
        settings: {
          ...input().settings,
          channel: '#feedback',
          username: 'Inlet',
          iconEmoji: ':inbox_tray:',
        },
      }),
    );
    expect(dressed.channel).toBe('#feedback');
    expect(dressed.username).toBe('Inlet');
    expect(dressed.icon_emoji).toBe(':inbox_tray:');
  });

  it('falls back to a raw option ID when the option is gone from the definition', () => {
    const body = serialized({
      answers: answers({ [MOOD]: { type: 'choice', optionIds: ['op_removed00'] } }),
    });
    expect(body).toContain('op_removed00');
  });

  it('survives a submission whose form version is no longer available', () => {
    const message = buildSlackMessage(input({ definition: undefined }));
    expect(message.text).toBe('New response in Beta feedback');
    expect(message.blocks.length).toBeGreaterThan(0);
  });
});
