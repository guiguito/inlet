import { useId } from 'react';
import type { CrashTimeline as Timeline } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * CR-048, CR-049: reports per day as bars, new groups per day as a line, and a marker on
 * the day each release was first seen. Plain SVG, no chart library: two series and a few
 * vertical lines do not need one, and a dependency is a thing to audit.
 *
 * Accessibility (section 11): the drawing is `aria-hidden`; the numbers are in a
 * visually hidden table beside it, so a screen reader gets the data and not the picture.
 */
export const TIMELINE_RANGES = [7, 30, 90] as const;
export type TimelineRange = (typeof TIMELINE_RANGES)[number];

export function CrashTimelineChart({
  timeline,
  range,
  onRangeChange,
  title,
  showNewGroups = true,
  className,
}: {
  timeline: Timeline | undefined;
  range: TimelineRange;
  onRangeChange: (range: TimelineRange) => void;
  title: string;
  /** Off for a single group, whose "new groups" series is always zero. */
  showNewGroups?: boolean;
  className?: string;
}) {
  const id = useId();
  const days = timeline?.days ?? [];
  const width = 720;
  const height = 160;
  const pad = { top: 8, right: 8, bottom: 22, left: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const maxReports = Math.max(1, ...days.map((d) => d.reports));
  const maxGroups = Math.max(1, ...days.map((d) => d.newGroups));
  const slot = days.length > 0 ? innerW / days.length : innerW;
  const x = (index: number) => pad.left + index * slot;
  const yReports = (value: number) => pad.top + innerH - (value / maxReports) * innerH;
  const yGroups = (value: number) => pad.top + innerH - (value / maxGroups) * innerH;
  const dayIndex = new Map(days.map((d, i) => [d.day, i]));
  const total = days.reduce((sum, d) => sum + d.reports, 0);
  const totalGroups = days.reduce((sum, d) => sum + d.newGroups, 0);
  const labelEvery = days.length > 30 ? 15 : days.length > 7 ? 5 : 1;

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" id={`${id}-title`}>
          {title}: <span className="numeric text-foreground">{total}</span> reports
          {showNewGroups ? (
            <>
              , <span className="numeric text-foreground">{totalGroups}</span> new groups
            </>
          ) : null}{' '}
          in the last {range} days
        </p>
        <div className="flex gap-1" role="group" aria-label="Timeline range">
          {TIMELINE_RANGES.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={option === range ? 'secondary' : 'ghost'}
              aria-pressed={option === range}
              onClick={() => onRangeChange(option)}
            >
              {option}d
            </Button>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-40 w-full text-muted-foreground"
        aria-hidden="true"
        focusable="false"
      >
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke="currentColor" strokeOpacity={0.3} />
        <text x={pad.left - 4} y={pad.top + 4} textAnchor="end" fontSize={10} fill="currentColor">
          {maxReports}
        </text>
        <text x={pad.left - 4} y={pad.top + innerH} textAnchor="end" fontSize={10} fill="currentColor">
          0
        </text>
        {days.map((d, i) => (
          <g key={d.day}>
            <rect
              x={x(i) + slot * 0.15}
              y={yReports(d.reports)}
              width={Math.max(1, slot * 0.7)}
              height={pad.top + innerH - yReports(d.reports)}
              className="fill-primary/70"
            >
              <title>{`${d.day}: ${d.reports} reports${showNewGroups ? `, ${d.newGroups} new groups` : ''}`}</title>
            </rect>
            {i % labelEvery === 0 ? (
              <text x={x(i) + slot / 2} y={height - 6} textAnchor="middle" fontSize={10} fill="currentColor">
                {d.day.slice(5)}
              </text>
            ) : null}
          </g>
        ))}
        {showNewGroups && days.length > 1 ? (
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            className="text-amber-600 dark:text-amber-400"
            points={days.map((d, i) => `${x(i) + slot / 2},${yGroups(d.newGroups)}`).join(' ')}
          />
        ) : null}
        {(timeline?.releases ?? []).map((release) => {
          const index = dayIndex.get(release.day);
          if (index === undefined) return null;
          const px = x(index) + slot / 2;
          return (
            <g key={`${release.version}-${release.day}`}>
              <line x1={px} x2={px} y1={pad.top} y2={pad.top + innerH} stroke="currentColor" strokeDasharray="3 3" strokeOpacity={0.7} />
              <text x={px + 3} y={pad.top + 10} fontSize={10} fill="currentColor">
                {release.version}
              </text>
            </g>
          );
        })}
      </svg>

      <table className="sr-only" aria-labelledby={`${id}-title`}>
        <thead>
          <tr>
            <th>Day</th>
            <th>Reports</th>
            {showNewGroups ? <th>New groups</th> : null}
            <th>Releases first seen</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.reports}</td>
              {showNewGroups ? <td>{d.newGroups}</td> : null}
              <td>{(timeline?.releases ?? []).filter((r) => r.day === d.day).map((r) => r.version).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** CR-049: the small per-row sparkline, with its numbers as the accessible name. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const width = 96;
  const height = 20;
  const max = Math.max(1, ...values);
  const slot = values.length > 0 ? width / values.length : width;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn('h-5 w-24 text-primary/70', className)}
      role="img"
      aria-label={`Reports per day, last ${values.length} days: ${values.join(', ')}`}
    >
      {values.map((value, index) => (
        <rect
          key={index}
          x={index * slot + slot * 0.2}
          y={height - (value / max) * height}
          width={Math.max(1, slot * 0.6)}
          height={(value / max) * height}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}
