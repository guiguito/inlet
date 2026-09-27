/** Text the analytics screens compute from an answer, kept free of React so it can be unit-tested. */
import type { AnalyticsFigure } from './api';

const integer = (value: number) => value.toLocaleString();
const percent = (value: number) => `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;

/**
 * AN-141: a count's change in percent, a share's in points; "not available" when the previous
 * period begins before the oldest event kept.
 */
export function changeText(figure: Pick<AnalyticsFigure, 'value' | 'previous'>, kind: 'count' | 'ratio'): string {
  const { value, previous } = figure;
  if (previous === null) return 'Change not available';
  if (value === null) return `No data now, ${kind === 'ratio' ? percent(previous) : integer(previous)} before`;
  if (kind === 'ratio') {
    const points = (value - previous) * 100;
    if (Math.abs(points) < 0.05) return `No change from ${percent(previous)}`;
    const shown = Math.abs(points).toLocaleString(undefined, { maximumFractionDigits: 1 });
    return `${points > 0 ? 'Up' : 'Down'} ${shown} ${shown === (1).toLocaleString() ? 'point' : 'points'} from ${percent(previous)}`;
  }
  if (value === previous) return `No change from ${integer(previous)}`;
  if (previous === 0) return `Up from 0`;
  const change = ((value - previous) / previous) * 100;
  return `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change).toLocaleString(undefined, { maximumFractionDigits: 1 })}% from ${integer(previous)}`;
}

/**
 * The feed's session groups, newest first: every event of a session in one group, placed where
 * its newest event falls. A crash found at the next launch sends `session_crashed` for the
 * previous session while the new one is under way, so grouping only consecutive events would
 * split a session. Events without a session are grouped only while they are consecutive.
 */
export function bySession<E extends { sessionId: string | null }>(events: E[]): { sessionId: string | null; events: E[] }[] {
  const groups: { sessionId: string | null; events: E[] }[] = [];
  const sessions = new Map<string, { sessionId: string | null; events: E[] }>();
  for (const event of events) {
    const group = event.sessionId === null ? (groups.at(-1)?.sessionId === null ? groups.at(-1) : undefined) : sessions.get(event.sessionId);
    if (group) {
      group.events.push(event);
      continue;
    }
    const created = { sessionId: event.sessionId, events: [event] };
    groups.push(created);
    if (event.sessionId !== null) sessions.set(event.sessionId, created);
  }
  return groups;
}
