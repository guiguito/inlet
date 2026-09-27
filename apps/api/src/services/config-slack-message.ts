import { NOTIFICATION_LIMITS, changedParameterKeys, escapeSlackText, truncateByCodePoint, type ConfigChangeSummary } from '@inlet/shared';
import type { SlackMessage } from './slack-message.js';

/**
 * Rendering a config publish, rollback or unpublish as a Slack message (Remote Config RC-080
 * to RC-082, section 8.2, Foundations §23). Pure, like the other builders beside it.
 *
 * RC-081: a message never carries a value, a rule, a list or a context. Nothing here reads
 * one: the input is the database's name, the activity (kind, actor, note, version), the
 * parameter keys and condition counts of the version's change summary, and the settings.
 * There is no content level (RC-080).
 */

export type ConfigActivityKind = 'publish' | 'rollback' | 'unpublish';

export type ConfigSlackMessageInput = {
  kind: ConfigActivityKind;
  databaseName: string;
  /** The History tab (8.2: "Open in Inlet"). */
  historyUrl: string;
  /** The version made active; null for an unpublish. */
  version: number | null;
  rolledBackFrom: number | null;
  /** A user's display name or a key's label. */
  actor: string;
  note: string | null;
  summary: ConfigChangeSummary | null;
  settings: { messageTitle: string | null; channel: string | null; username: string | null; iconEmoji: string | null };
};

export const CONFIG_SLACK_HEADINGS: Record<ConfigActivityKind, string> = {
  publish: 'Config published',
  rollback: 'Config rolled back',
  unpublish: 'Config unpublished',
};

/** RC-081: up to ten keys are named. */
const KEYS_SHOWN = 10;

/** "Changed: a, b and 3 more. Conditions: 1 added, 2 removed." — empty parts left out; null when nothing changed. */
export function changeLine(summary: ConfigChangeSummary | null): string | null {
  if (!summary) return null;
  const parts: string[] = [];
  const changed = changedParameterKeys(summary);
  if (changed.length > 0) {
    const shown = changed.slice(0, KEYS_SHOWN).map(escapeSlackText).join(', ');
    parts.push(`Changed: ${shown}${changed.length > KEYS_SHOWN ? ` and ${changed.length - KEYS_SHOWN} more` : ''}.`);
  }
  const { conditionsAdded, conditionsChanged, conditionsRemoved } = summary.counts;
  const conditions = [
    [conditionsAdded, 'added'],
    [conditionsChanged, 'changed'],
    [conditionsRemoved, 'removed'],
  ].filter(([count]) => (count as number) > 0).map(([count, word]) => `${count} ${word}`);
  if (conditions.length > 0) parts.push(`Conditions: ${conditions.join(', ')}.`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** A rollback records "Rolled back to version N." before the actor's note; the sentence already says it. */
const ROLLBACK_PREFIX = /^Rolled back to version \d+\.\s*/;

export function buildConfigSlackMessage(input: ConfigSlackMessageInput): SlackMessage {
  // The heading is operator-authored and may carry Slack markup on purpose, as for the other
  // types; everything a person or an agent wrote (names, notes, keys) is escaped.
  const heading = input.settings.messageTitle?.trim() || CONFIG_SLACK_HEADINGS[input.kind];
  const name = escapeSlackText(truncateByCodePoint(input.databaseName, 120));
  const actor = escapeSlackText(truncateByCodePoint(input.actor, 120));
  const rawNote = (input.kind === 'rollback' ? input.note?.replace(ROLLBACK_PREFIX, '') : input.note)?.trim();
  const escapedNote = rawNote ? escapeSlackText(rawNote) : '';
  const changes = input.kind === 'unpublish' ? null : changeLine(input.summary);

  const render = (note: string) => {
    let sentence: string;
    if (input.kind === 'unpublish') {
      sentence = `${name}: unpublished by ${actor}: apps use their in-app defaults from their next fetch.`;
    } else if (input.kind === 'rollback') {
      sentence = `${name}: version ${input.version} published by ${actor}, rolling back to version ${input.rolledBackFrom}.${note}`;
    } else {
      sentence = `${name}: version ${input.version} published by ${actor}.${note}`;
    }
    const lines = [`*${heading}*`, sentence];
    if (changes) lines.push(changes);
    lines.push(`<${input.historyUrl}|Open in Inlet>`);
    return lines.join('\n');
  };
  let text = render(escapedNote ? ` ${escapedNote}` : '');
  // Slack refuses a section past 3,000 characters, and escaping can grow a 500-character note
  // five times: the note is shortened to fit, so the message is never lost to it.
  const over = text.length - NOTIFICATION_LIMITS.slackSectionTextMaxLength;
  if (over > 0 && escapedNote) text = render(` ${truncateByCodePoint(escapedNote, Math.max(0, [...escapedNote].length - over - 1))}`);

  const message: SlackMessage = { text: heading, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
  if (input.settings.channel) message.channel = input.settings.channel;
  if (input.settings.username) message.username = input.settings.username;
  if (input.settings.iconEmoji) message.icon_emoji = input.settings.iconEmoji;
  return message;
}
