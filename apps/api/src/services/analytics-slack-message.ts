import { escapeSlackText, truncateByCodePoint } from '@inlet/shared';
import type { SlackMessage } from './slack-message.js';

/**
 * Rendering an analytics data-health incident as a Slack message (UX Analytics AN-190 to
 * AN-192, section 8.2, Foundations §23). Pure, like `slack-message.ts` beside it, so what
 * reaches a channel is decided here and asserted directly.
 *
 * AN-182: a message never carries an installation ID, a user ID, a session ID, a param
 * value, an attribution, an experiment variant or an event name. Nothing here reads one:
 * the input is the database's name, the incident's kind and its figures, which are counts,
 * dates and the settings, and the link to the Storage panel. There is no content level.
 */

export type AnalyticsIncidentKind =
  | 'storage_cap_reached'
  | 'storage_cap_exceeded'
  | 'rate_limited'
  | 'event_name_limit'
  | 'event_name_rate'
  | 'invalid_events';

/** AN-191: the figures each kind stores when it opens, and updates while it is open. */
export type IncidentFigures = {
  /** Events the incident affected while open: removed early, refused, or above the cap. */
  affected?: number;
  /** storage_cap_reached: the Monday of the latest week removed early. */
  week?: string;
  /** storage_cap_*: the events kept after the pass, and the cap. */
  eventsKept?: number;
  cap?: number;
  /** storage_cap_reached: when the cap last removed a week early (the 14 days of AN-169). */
  lastDropAt?: string;
  /** Counter kinds: events refused in the hour that opened or last renewed it. */
  events?: number;
  /** Counter kinds: the start of the first hour the condition held, from which `affected` is counted. */
  firstHour?: string;
  /** Counter kinds: the start of the last hour the condition held (the 24 hours of AN-169). */
  lastHour?: string;
  /** event_name_limit: the names the database holds; event_name_rate: the hourly allowance. */
  names?: number;
  allowance?: number;
  /** invalid_events: the invalid events and all events of the hour. */
  invalid?: number;
  total?: number;
};

export type AnalyticsSlackMessageInput = {
  databaseName: string;
  /** The Storage panel of the database (8.2: "Open in Inlet"). */
  storageUrl: string;
  incident: { kind: AnalyticsIncidentKind; openedAt: Date; resolvedAt: Date | null; figures: IncidentFigures };
  /** Whether this delivery announces the resolution rather than the opening. */
  resolution: boolean;
  settings: { messageTitle: string | null; channel: string | null; username: string | null; iconEmoji: string | null };
};

export const ANALYTICS_SLACK_HEADING = 'Analytics data health';

const count = (value: number | undefined) => Math.round(value ?? 0).toLocaleString('en-US');

/** "September 1", from a YYYY-MM-DD local date. */
function dayText(day: string | undefined): string {
  if (!day) return 'an early week';
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** "3 hours", "45 minutes", "2 days": how long an incident lasted, in the unit that reads best. */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/** The kind in plain words, for "<name> is <words>" and "<name> is no longer <words>". */
const PLAIN: Record<AnalyticsIncidentKind, string> = {
  storage_cap_reached: 'at its storage cap',
  storage_cap_exceeded: 'over its storage cap',
  rate_limited: 'rate limited',
  event_name_limit: 'refusing new event names',
  event_name_rate: 'refusing new event names for exceeding its hourly allowance',
  invalid_events: 'rejecting invalid events',
};

/** Section 8.2's sentences, one per kind, with the figures that opened the incident. */
export function incidentSentence(name: string, kind: AnalyticsIncidentKind, figures: IncidentFigures): string {
  switch (kind) {
    case 'storage_cap_reached':
      return `${name} is at its storage cap: the week of ${dayText(figures.week)} is removed early, and ${count(figures.eventsKept)} events are kept.`;
    case 'storage_cap_exceeded':
      return `${name} is over its storage cap: ${count(figures.eventsKept)} events are kept against a cap of ${count(figures.cap)}, because the current and previous weeks are always kept. Events are still collected.`;
    case 'rate_limited':
      return `${name} is rate limited: ${count(figures.events)} events are refused in the last hour.`;
    case 'event_name_limit':
      return `${name} refuses new event names: it holds ${count(figures.names)}.`;
    case 'event_name_rate':
      return `${name} refuses new event names: more than ${count(figures.allowance)} arrived within an hour, and ${count(figures.events)} events are refused.`;
    case 'invalid_events':
      return `${name} rejects invalid events: ${count(figures.invalid)} of ${count(figures.total)} events in an hour are invalid.`;
  }
}

export function buildAnalyticsSlackMessage(input: AnalyticsSlackMessageInput): SlackMessage {
  // The heading is operator-authored and may carry Slack markup on purpose, as for feedback
  // and crash messages; the database name is escaped like any user-written text.
  const heading = input.settings.messageTitle?.trim() || ANALYTICS_SLACK_HEADING;
  const name = escapeSlackText(truncateByCodePoint(input.databaseName, 120));
  const { incident } = input;
  const opened = `Opened ${incident.openedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
  const lines = [`*${heading}*`];
  if (input.resolution) {
    const lasted = durationText((incident.resolvedAt ?? incident.openedAt).getTime() - incident.openedAt.getTime());
    const affected = incident.figures.affected ?? 0;
    lines.push(
      `${name} is no longer ${PLAIN[incident.kind]}.`,
      `Resolved. It lasted ${lasted} and affected ${count(affected)} ${affected === 1 ? 'event' : 'events'}.`,
      opened,
    );
  } else {
    lines.push(incidentSentence(name, incident.kind, incident.figures), opened);
  }
  lines.push(`<${input.storageUrl}|Open in Inlet>`);

  const message: SlackMessage = {
    text: heading,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
  };
  if (input.settings.channel) message.channel = input.settings.channel;
  if (input.settings.username) message.username = input.settings.username;
  if (input.settings.iconEmoji) message.icon_emoji = input.settings.iconEmoji;
  return message;
}
