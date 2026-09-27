import { useId } from 'react';
import type { AnalyticsTrendAnswer } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * A trend (UX Analytics AN-060 to AN-067, PRD 8.1 Insights → Events): a line per series or
 * split value, in plain SVG as the crash timeline is drawn — no chart library.
 *
 * - An incomplete period (the one containing now, or one the covered range cuts) is drawn
 *   dashed and its point hollow, so it is marked by shape and not by colour alone (section 11).
 * - Any part of the range before the oldest event kept is shaded, with the note of AN-065.
 * - Below the drawing, a table of every value per period, which is also the chart's accessible
 *   table: the drawing itself is `aria-hidden`.
 *
 * Every label is user-authored or data (event names, split values) and is rendered as text.
 */

/** Eleven distinguishable strokes for ten split values and Other; None reuses the muted one. */
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#737373'];

export function seriesColor(index: number, group?: string): string {
  if (group === 'none') return '#a3a3a3';
  return COLORS[index % COLORS.length]!;
}

/** "Events are kept from September 1. Earlier days have no data." (AN-065, PRD 8.1). */
export function keptFromNote(keptFrom: string): string {
  const date = new Date(`${keptFrom}T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `Events are kept from ${date}. Earlier days have no data.`;
}

export function TrendChart({ answer, className }: { answer: AnalyticsTrendAnswer; className?: string }) {
  const id = useId();
  const periods = answer.series[0]?.points ?? [];
  const width = 760;
  const height = 240;
  const pad = { top: 12, right: 12, bottom: 24, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...answer.series.flatMap((series) => series.points.map((point) => point.value)));
  const step = periods.length > 1 ? innerW / (periods.length - 1) : innerW;
  const x = (index: number) => pad.left + (periods.length > 1 ? index * step : innerW / 2);
  const y = (value: number) => pad.top + innerH - (value / max) * innerH;
  const labelEvery = Math.max(1, Math.ceil(periods.length / 8));
  // The day each period starts on, to compare with the oldest day kept (an hour's local date).
  const dayOf = (start: string) => start.slice(0, 10);
  const keptFrom = answer.keptFrom;
  // The periods wholly before the oldest day kept: each ends before the next one starts. The
  // period that holds that day is cut, and marked incomplete rather than shaded.
  const shaded =
    keptFrom && answer.range.from < keptFrom
      ? periods.filter((_, index) => {
          const next = periods[index + 1];
          return next ? dayOf(next.start) <= keptFrom : answer.range.to < keptFrom;
        }).length
      : 0;
  const format = (value: number) => (Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 }));

  return (
    <div className={cn('space-y-3', className)}>
      {shaded > 0 && keptFrom ? (
        <p className="text-[13px] text-muted-foreground" data-testid="kept-from-note">
          {keptFromNote(keptFrom)}
        </p>
      ) : null}
      {answer.series.some((series) => series.notice === 'range_outside_retention') ? (
        <p className="text-[13px] text-muted-foreground" data-testid="range-outside-retention">
          This range is entirely before the oldest event kept, so it has no data.
        </p>
      ) : null}

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]" aria-label="Series">
        {answer.series.map((series, index) => (
          <li key={`${series.label}-${index}`} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ backgroundColor: seriesColor(index, series.group) }} aria-hidden="true" />
            <span>{series.label}</span>
          </li>
        ))}
      </ul>

      <svg viewBox={`0 0 ${width} ${height}`} className="h-60 w-full text-muted-foreground" aria-hidden="true" focusable="false" data-testid="trend-chart">
        {shaded > 0 ? (
          <rect
            x={pad.left}
            y={pad.top}
            width={Math.max(2, x(Math.max(0, shaded - 1)) - pad.left + (shaded === periods.length ? 0 : step / 2))}
            height={innerH}
            fill="currentColor"
            fillOpacity={0.1}
            data-testid="kept-from-band"
          />
        ) : null}
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke="currentColor" strokeOpacity={0.3} />
        <text x={pad.left - 6} y={pad.top + 4} textAnchor="end" fontSize={10} fill="currentColor">
          {format(max)}
        </text>
        <text x={pad.left - 6} y={pad.top + innerH} textAnchor="end" fontSize={10} fill="currentColor">
          0
        </text>
        {periods.map((point, index) =>
          index % labelEvery === 0 ? (
            <text key={point.start} x={x(index)} y={height - 6} textAnchor="middle" fontSize={10} fill="currentColor">
              {point.label}
            </text>
          ) : null,
        )}
        {answer.series.map((series, seriesIndex) => {
          const color = seriesColor(seriesIndex, series.group);
          return (
            <g key={`${series.label}-${seriesIndex}`} data-testid="trend-line">
              {series.points.slice(1).map((point, index) => {
                const previous = series.points[index]!;
                return (
                  <line
                    key={point.start}
                    x1={x(index)}
                    y1={y(previous.value)}
                    x2={x(index + 1)}
                    y2={y(point.value)}
                    stroke={color}
                    strokeWidth={1.75}
                    strokeDasharray={point.incomplete || previous.incomplete ? '4 3' : undefined}
                  />
                );
              })}
              {series.points.map((point, index) => (
                <circle
                  key={point.start}
                  cx={x(index)}
                  cy={y(point.value)}
                  r={point.incomplete ? 3 : 2}
                  stroke={color}
                  strokeWidth={1.25}
                  fill={point.incomplete ? 'var(--background, white)' : color}
                />
              ))}
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-muted-foreground">A dashed segment and a hollow point mark a period that is not complete: the one under way, or one the data kept only partly covers.</p>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" aria-labelledby={`${id}-caption`} data-testid="trend-table">
          <caption id={`${id}-caption`} className="sr-only">
            The values of every series per period
          </caption>
          <thead className="bg-muted/40 text-left text-[13px]">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Period
              </th>
              {answer.series.map((series, index) => (
                <th key={`${series.label}-${index}`} scope="col" className="px-3 py-2 text-right font-medium">
                  {series.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.map((point, row) => (
              <tr key={point.start} className="border-t">
                <th scope="row" className="whitespace-nowrap px-3 py-1.5 text-left font-normal">
                  {point.label}
                  {point.incomplete ? <span className="text-muted-foreground"> (incomplete)</span> : null}
                </th>
                {answer.series.map((series, index) => (
                  <td key={`${series.label}-${index}`} className="numeric px-3 py-1.5 text-right">
                    {format(series.points[row]?.value ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
