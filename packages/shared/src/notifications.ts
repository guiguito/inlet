import { z } from 'zod';

/**
 * Slack notification settings (FR-155 to FR-172).
 *
 * Shared between the API and the web app for the same reason branding is: the values are
 * validated when saved, previewed in the settings panel, and rendered into a Slack
 * message. One definition means the panel cannot promise something the sender will not
 * do.
 *
 * This is the product's first outbound HTTP, so the rules here are the security boundary
 * rather than presentation: which hosts may be POSTed to, and how respondent-authored
 * text is neutralised before it reaches somebody's Slack channel.
 */

/** The one host Slack serves incoming webhooks from. */
export const DEFAULT_SLACK_WEBHOOK_ORIGIN = 'https://hooks.slack.com';

/**
 * How much of a response the message carries (FR-160).
 *
 * An enum rather than two booleans, so "the email address but not the answers" is
 * unrepresentable instead of merely discouraged. The email address is separated from the
 * other answers because it is the one field that identifies a person, and PRD section
 * 12.2 treats it accordingly.
 */
export const SLACK_CONTENT_LEVELS = ['link_only', 'answers', 'answers_with_email'] as const;
export type SlackContentLevel = (typeof SLACK_CONTENT_LEVELS)[number];

export const NOTIFICATION_LIMITS = {
  /** A custom heading. May contain Slack mention syntax, since an operator owns it. */
  messageTitleMaxLength: 120,
  channelMaxLength: 80,
  usernameMaxLength: 80,
  iconEmojiMaxLength: 60,

  /**
   * Per answer, in code points. A free-text answer may be 10,000 characters and a Slack
   * message is a nudge, not a transcript.
   */
  answerValueMaxLength: 300,
  /** Answers shown before the message says how many more there are. Slack caps at 10. */
  answersShownMax: 10,

  /** Slack's own ceilings, so the assembled payload can be checked against them. */
  slackSectionTextMaxLength: 3000,
  slackFieldTextMaxLength: 2000,
  slackFieldsMaxItems: 10,
  slackBlocksMaxItems: 50,
  /** Measured on the serialized payload in bytes, not characters. */
  payloadMaxBytes: 30_000,

  /** How long the sender waits for Slack before treating the attempt as failed. */
  sendTimeoutMs: 5_000,
  /** How much of Slack's response body is read. Its answers are one short word. */
  responseReadMaxBytes: 1024,
} as const;

/**
 * The shape of a webhook URL, independent of which hosts are allowed.
 *
 * The host check is deliberately not here: it comes from deployment configuration and
 * only the server can see it. This validates everything else, including the two URL
 * tricks worth naming — credentials before the host, which would let
 * `https://user@hooks.slack.com@evil.example/` read as Slack to a careless eye, and a
 * query string or fragment, which a real webhook URL never carries.
 */
export const slackWebhookUrlSchema = z
  .string()
  .trim()
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      /^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)
    );
  }, 'expected a Slack webhook like https://hooks.slack.com/services/T0.../B0.../xxxx');

/**
 * Whether a URL may be POSTed to (FR-163).
 *
 * An exact-origin allowlist is the whole answer to server-side request forgery here,
 * rather than a mitigation of it. There is no private-address denylist to get wrong, no
 * IPv6-mapped-IPv4 edge case and no DNS-rebinding window, because a host that is not on
 * the list never receives a request at all.
 */
export function isAllowedWebhookOrigin(value: string, allowedOrigins: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return allowedOrigins.some((allowed) => {
    try {
      return new URL(allowed).origin === url.origin;
    } catch {
      return false;
    }
  });
}

/**
 * Neutralises respondent-authored text for a Slack message (FR-166).
 *
 * Slack's parser reads `<!channel>`, `<!here>` and `<@U0123>` as notifications and
 * `<https://x|text>` as a link with arbitrary anchor text. Without this, anyone who can
 * open a hosted form could ping a whole workspace, or deliver a plausible phishing link
 * attributed to the operator's own feedback tool. Escaping exactly these three
 * characters is Slack's documented answer and defeats all of it.
 *
 * Deliberately not `escapeHtml`: that also escapes quotes, which Slack does not want and
 * would render literally as `&quot;` in the channel.
 */
export function escapeSlackText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Shortens text by code point.
 *
 * `String.prototype.slice` cuts by UTF-16 unit and will split a surrogate pair, leaving a
 * lone surrogate that serializes into the payload as a replacement character. Emoji are
 * ordinary in feedback, so this is a real case rather than a theoretical one.
 *
 * ponytail: code points, not grapheme clusters. A multi-codepoint emoji sequence can
 * still be cut mid-sequence, which looks odd but is valid. Intl.Segmenter if it matters.
 */
export function truncateByCodePoint(value: string, maxLength: number): string {
  const points = [...value];
  if (points.length <= maxLength) return value;
  return `${points.slice(0, maxLength).join('')}…`;
}

/**
 * What the API returns in place of the webhook URL (FR-162).
 *
 * Enough for an operator to confirm a paste landed and to tell two webhooks apart, and
 * not enough to post with. The URL itself never leaves the server after it is saved.
 */
export function maskWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const secret = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
    const tail = secret.length > 4 ? secret.slice(-4) : secret;
    return `${parsed.host}/services/…/…/••••${tail}`;
  } catch {
    return '••••';
  }
}

/**
 * A channel override. Loose on purpose: Slack accepts more characters in a channel name
 * than any published grammar covers, and rejecting a legal channel is worse than passing
 * an illegal one through to Slack, which answers `channel_not_found` clearly.
 */
export const slackChannelSchema = z
  .string()
  .trim()
  .max(NOTIFICATION_LIMITS.channelMaxLength)
  .regex(/^[#@][^\s<>|]+$/, 'expected a channel like #feedback or a person like @someone');

export const slackUsernameSchema = z
  .string()
  .trim()
  .max(NOTIFICATION_LIMITS.usernameMaxLength)
  .refine((value) => !/[<>|]/.test(value), 'cannot contain < > or |');

export const slackIconEmojiSchema = z
  .string()
  .trim()
  .max(NOTIFICATION_LIMITS.iconEmojiMaxLength)
  .regex(/^:[a-z0-9_+-]+:$/, 'expected an emoji name like :inbox_tray:');
