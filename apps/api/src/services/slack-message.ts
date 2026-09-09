import {
  NOTIFICATION_LIMITS,
  escapeSlackText,
  listQuestions,
  truncateByCodePoint,
  type FormDefinition,
  type SlackContentLevel,
  type StoredAnswer,
  type StoredAnswers,
} from '@inlet/shared';
import { optionLabel, renderAnswerCell } from './export.js';

/**
 * Rendering a submission as a Slack message (FR-159, FR-160, FR-166).
 *
 * A pure module on purpose: no database, no network, no context. Everything about what
 * reaches somebody's Slack channel is decided here and can be asserted directly, which
 * matters more for this file than for most, because a message cannot be unsent.
 */

export type SlackMessage = {
  text: string;
  blocks: unknown[];
  channel?: string;
  username?: string;
  icon_emoji?: string;
};

export type SlackMessageInput = {
  databaseName: string;
  databaseId: string;
  submissionId: string;
  submissionUrl: string;
  /** Null for a test message, which belongs to no version. */
  formVersion: number | null;
  createdAt: Date;
  answers: StoredAnswers;
  definition: FormDefinition | undefined;
  attachmentCount: number;
  /** How the submission arrived, from the recorded client context. */
  via: string | null;
  settings: {
    contentLevel: SlackContentLevel;
    messageTitle: string | null;
    channel: string | null;
    username: string | null;
    iconEmoji: string | null;
  };
};

export function buildSlackMessage(input: SlackMessageInput): SlackMessage {
  const heading = input.settings.messageTitle?.trim() || `New response in ${input.databaseName}`;

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        // The heading is operator-authored, so Slack markup in it is intentional: an
        // operator may well want <!here>. Respondent text never reaches this block.
        text: `*${heading}*\n<${input.submissionUrl}|Open in Inlet>`,
      },
    },
  ];

  const fields =
    input.settings.contentLevel === 'link_only' ? [] : answerFields(input);
  if (fields.length > 0) {
    blocks.push({ type: 'section', fields: fields.slice(0, NOTIFICATION_LIMITS.slackFieldsMaxItems) });
  }

  const hidden = input.settings.contentLevel === 'link_only' ? 0 : hiddenAnswerCount(input);
  if (hidden > 0) {
    blocks.push(context(`+ ${hidden} more ${hidden === 1 ? 'answer' : 'answers'} — open in Inlet`));
  }

  // The screenshot count belongs in the metadata line only when the answers are not
  // there to report it themselves, or the message says "2 screenshots" twice.
  blocks.push(context(metadataLine(input, fields.length === 0)));

  const message: SlackMessage = {
    // The fallback, and therefore what Slack shows on a lock screen and in the channel
    // list. Content-free at every level: the least controlled surface Slack has should
    // not be the one carrying somebody's answer.
    text: heading,
    blocks,
  };

  // Omitted rather than null: Slack reads a null channel as a malformed override.
  if (input.settings.channel) message.channel = input.settings.channel;
  if (input.settings.username) message.username = input.settings.username;
  if (input.settings.iconEmoji) message.icon_emoji = input.settings.iconEmoji;

  return withinSizeBudget(message);
}

/**
 * The answers, in the order the form asks them.
 *
 * Labels come from the submission's own pinned version, so a question renamed since
 * carries the wording the respondent actually saw (FR-065).
 */
function answerFields(input: SlackMessageInput): { type: 'mrkdwn'; text: string }[] {
  return shownQuestions(input).map((question) => {
    const label = escapeSlackText(truncateByCodePoint(question.label, 80));
    const value = answerText(input.answers[question.id], input.definition, input.settings.contentLevel);
    /*
     * `mrkdwn` rather than `plain_text`, so the question can be bold and told apart from
     * the answer. In a message with five answers, uniform grey text is unreadable.
     *
     * The escaping is what makes this safe, not the block type: `escapeSlackText` has
     * already turned every `&`, `<` and `>` in respondent text into an entity, so a
     * mention or a link cannot survive into here. What `mrkdwn` additionally allows is an
     * asterisk or a backtick in an answer rendering as emphasis, which is cosmetic and
     * cannot address anybody.
     */
    return {
      type: 'mrkdwn' as const,
      text: truncateByCodePoint(
        `*${label}*\n${value === '' ? '—' : value}`,
        NOTIFICATION_LIMITS.slackFieldTextMaxLength,
      ),
    };
  });
}

function shownQuestions(input: SlackMessageInput) {
  const questions = input.definition ? listQuestions(input.definition) : [];
  const answered = questions.filter((question) => input.answers[question.id] !== undefined);
  return answered.slice(0, NOTIFICATION_LIMITS.answersShownMax);
}

function hiddenAnswerCount(input: SlackMessageInput): number {
  const questions = input.definition ? listQuestions(input.definition) : [];
  const answered = questions.filter((question) => input.answers[question.id] !== undefined);
  return Math.max(0, answered.length - NOTIFICATION_LIMITS.answersShownMax);
}

/**
 * One answer as text.
 *
 * Three cases differ from the export renderer. A screenshot becomes a count, never a URL,
 * because an attachment URL is authenticated and Slack's unfurler would render a broken
 * preview of it. An email address is withheld unless the operator opted in specifically,
 * while its label still shows, so the channel learns that an address was given without
 * learning the address. Everything else reuses the export renderer, which already handles
 * emoji option labels and options that no longer exist.
 */
function answerText(
  answer: StoredAnswer | undefined,
  definition: FormDefinition | undefined,
  level: SlackContentLevel,
): string {
  if (!answer) return '';

  if (answer.type === 'screenshot') {
    const count = answer.attachmentIds.length;
    return `${count} ${count === 1 ? 'screenshot' : 'screenshots'}`;
  }

  if (answer.type === 'email') {
    if (level !== 'answers_with_email') return '(email address collected)';
    return escapeSlackText(truncateByCodePoint(answer.value, NOTIFICATION_LIMITS.answerValueMaxLength));
  }

  if (answer.type === 'choice') {
    return escapeSlackText(
      answer.optionIds.map((id) => optionLabel(definition, id)).join(', '),
    );
  }

  return escapeSlackText(
    truncateByCodePoint(
      renderAnswerCell(answer, definition),
      NOTIFICATION_LIMITS.answerValueMaxLength,
    ),
  );
}

function metadataLine(input: SlackMessageInput, includeAttachments: boolean): string {
  const parts: string[] = [];
  if (input.formVersion !== null) parts.push(`Version ${input.formVersion}`);
  if (input.via) parts.push(input.via);
  if (includeAttachments && input.attachmentCount > 0) {
    parts.push(
      `${input.attachmentCount} ${input.attachmentCount === 1 ? 'screenshot' : 'screenshots'}`,
    );
  }
  // The submission's own timestamp, not the send time: a notification delayed by a retry
  // must not read as a fresh response.
  parts.push(input.createdAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
  return parts.join(' · ');
}

function context(text: string): unknown {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

/**
 * The last resort.
 *
 * Every individual field is already bounded, but a form can have many of them, so the
 * assembled payload is measured once and degraded to the link if it is still too big.
 * Measured in bytes, because three hundred CJK characters are nine hundred bytes.
 */
function withinSizeBudget(message: SlackMessage): SlackMessage {
  if (Buffer.byteLength(JSON.stringify(message)) <= NOTIFICATION_LIMITS.payloadMaxBytes) {
    return message;
  }
  return {
    ...message,
    blocks: message.blocks.filter(
      (block) => (block as { type?: string; fields?: unknown }).fields === undefined,
    ),
  };
}
