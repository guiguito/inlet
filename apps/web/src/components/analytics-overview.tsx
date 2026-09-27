import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { ANALYTICS_PLATFORMS, ANALYTICS_RANGE_PRESETS, type AnalyticsRange } from '@inlet/shared';
import { api, ApiError, type AnalyticsCrashFree, type AnalyticsFigure, type AnalyticsOverview, type AnalyticsOverviewQuery, type AnalyticsShare, type AnalyticsTrendAnswer } from '@/lib/api';
import { queryErrorSentence } from '@/components/analytics-events';
import { EmptyState } from '@/components/empty-state';
import { TrendChart } from '@/components/trend-chart';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * Insights → Overview (UX Analytics PRD 8.1; AN-140 to AN-144, AN-152): a filter bar with its
 * defaults as chips, the row of figures each with its change, the chart of daily active units
 * with a marker per app version, the share tables, the top events and crash-free sessions per
 * version. Every number is text, so assistive technology reads what the eye reads: the chart's
 * drawing is hidden from it and its table is not, and every bar has its share written beside it.
 */

const PRESET_LABELS: Record<(typeof ANALYTICS_RANGE_PRESETS)[number], string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7Days: 'Last 7 days',
  last30Days: 'Last 30 days',
  last90Days: 'Last 90 days',
  last12Months: 'Last 12 months',
  thisMonth: 'This month',
  thisYear: 'This year',
};
const CLIENT_PLATFORMS = ANALYTICS_PLATFORMS.filter((platform) => platform !== 'server');
const SELECT = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-2 focus-visible:outline-ring';

const DEFAULT_QUERY: AnalyticsOverviewQuery = { range: { preset: 'last30Days' }, apps: [], platforms: [], environments: ['production'], unit: 'installation' };

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
    return `${points > 0 ? 'Up' : 'Down'} ${Math.abs(points).toLocaleString(undefined, { maximumFractionDigits: 1 })} points from ${percent(previous)}`;
  }
  if (value === previous) return `No change from ${integer(previous)}`;
  if (previous === 0) return `Up from 0`;
  const change = ((value - previous) / previous) * 100;
  return `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change).toLocaleString(undefined, { maximumFractionDigits: 1 })}% from ${integer(previous)}`;
}

function rangeLabel(range: AnalyticsRange): string {
  return 'preset' in range ? PRESET_LABELS[range.preset] : `${range.from} to ${range.to}`;
}

export function OverviewPanel({ databaseId, unreachable }: { databaseId: string; unreachable: string }) {
  const [query, setQuery] = useState<AnalyticsOverviewQuery>(DEFAULT_QUERY);
  const overview = useQuery({
    queryKey: ['analytics-overview', databaseId, query],
    queryFn: ({ signal }) => api.analyticsOverview(databaseId, query, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  // The app filter appears once the database has seen more than one app (PRD 8.1).
  const apps = useQuery({ queryKey: ['analytics-filter-values', databaseId, 'app'], queryFn: () => api.analyticsFilterValues(databaseId, { dimension: 'app' }), retry: false, staleTime: 60_000 });
  const environments = useQuery({ queryKey: ['analytics-filter-values', databaseId, 'environment'], queryFn: () => api.analyticsFilterValues(databaseId, { dimension: 'environment' }), retry: false, staleTime: 60_000 });
  const update = (patch: Partial<AnalyticsOverviewQuery>) => setQuery((previous) => ({ ...previous, ...patch }));
  const knownEnvironments = environments.data?.values ?? [];
  const data = overview.data;
  const empty = data?.notices.some((notice) => notice.code === 'no_events') ?? false;

  return (
    <div className="mt-4 space-y-4" data-testid="overview">
      <FilterBar query={query} update={update} apps={apps.data?.values ?? []} environments={knownEnvironments} />

      {overview.error ? (
        <p role="status" className="rounded-md border border-destructive/40 px-3 py-2 text-sm" data-testid="overview-error">
          {/* 9.5: the Overview has no interval to coarsen, so it suggests only a shorter range. */}
          {overview.error instanceof ApiError && overview.error.code === 'query_limit_exceeded'
            ? 'The Overview took too long or needed too much memory; choose a shorter range.'
            : queryErrorSentence(overview.error, unreachable)}
        </p>
      ) : !data ? (
        <Skeleton className="h-96" />
      ) : empty ? (
        <EmptyState
          title="No events yet"
          description={data.notices.find((notice) => notice.code === 'no_events')!.message}
          action={
            <Button variant="outline" asChild>
              <Link to="?tab=collect">Open Collect</Link>
            </Button>
          }
        />
      ) : (
        <>
          {data.notices
            .filter((notice) => notice.code === 'no_app_started')
            .map((notice) => (
              <p key={notice.code} role="status" className="rounded-md border px-3 py-2 text-sm" data-testid="overview-notice">
                {notice.message}
              </p>
            ))}
          <Figures data={data} />
          <DailyActive data={data} />
          <div className="grid gap-4 lg:grid-cols-3">
            <ShareTable title="App version" rows={data.shares.appVersion} testId="share-app-version" />
            <ShareTable title="Platform" rows={data.shares.platform} testId="share-platform" />
            <ShareTable title="Country" rows={data.shares.country} testId="share-country" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <TopEvents data={data} />
            <CrashFreeTable data={data} />
          </div>
        </>
      )}
    </div>
  );
}

// --- The filter bar (PRD 8.1) ----------------------------------------------------------------------

function FilterBar({
  query,
  update,
  apps,
  environments,
}: {
  query: AnalyticsOverviewQuery;
  update: (patch: Partial<AnalyticsOverviewQuery>) => void;
  apps: string[];
  environments: string[];
}) {
  const custom = 'from' in query.range;
  const today = new Date().toISOString().slice(0, 10);
  const allEnvironments = environments.length > 1 && environments.every((value) => query.environments.includes(value));
  const chips: { label: string; isDefault: boolean; remove?: () => void }[] = [
    { label: rangeLabel(query.range), isDefault: 'preset' in query.range && query.range.preset === 'last30Days' },
    ...query.apps.map((app) => ({ label: `App ${app}`, isDefault: false, remove: () => update({ apps: query.apps.filter((value) => value !== app) }) })),
    ...(query.platforms.length === 0
      ? [{ label: 'Every client platform', isDefault: true }]
      : query.platforms.map((platform) => ({ label: `Platform ${platform}`, isDefault: false, remove: () => update({ platforms: query.platforms.filter((value) => value !== platform) }) }))),
    ...(allEnvironments
      ? [{ label: 'Every environment', isDefault: false, remove: () => update({ environments: ['production'] }) }]
      : query.environments.map((environment) => ({
          label: `Environment ${environment}`,
          isDefault: environment === 'production' && query.environments.length === 1,
          // Removing the last environment reads every one the database has seen.
          remove: () => {
            const rest = query.environments.filter((value) => value !== environment);
            update({ environments: rest.length > 0 ? rest : environments.length > 0 ? environments : ['production'] });
          },
        }))),
    { label: query.unit === 'user' ? 'Counting user IDs' : 'Counting installations', isDefault: query.unit === 'installation', ...(query.unit === 'user' ? { remove: () => update({ unit: 'installation' }) } : {}) },
  ];

  return (
    <section className="space-y-2" aria-label="Filters">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-[13px]">
          <span className="block font-medium">Range</span>
          <select
            className={SELECT}
            aria-label="Range"
            value={custom ? 'custom' : (query.range as { preset: string }).preset}
            onChange={(event) => {
              const value = event.target.value;
              update({ range: value === 'custom' ? { from: today, to: today } : { preset: value as (typeof ANALYTICS_RANGE_PRESETS)[number] } });
            }}
          >
            {ANALYTICS_RANGE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {PRESET_LABELS[preset]}
              </option>
            ))}
            <option value="custom">Dates</option>
          </select>
        </label>
        {custom ? (
          <>
            <label className="space-y-1 text-[13px]">
              <span className="block font-medium">From</span>
              <Input type="date" className="h-9" aria-label="From" value={(query.range as { from: string }).from} onChange={(event) => event.target.value && update({ range: { ...(query.range as { from: string; to: string }), from: event.target.value } })} />
            </label>
            <label className="space-y-1 text-[13px]">
              <span className="block font-medium">To</span>
              <Input type="date" className="h-9" aria-label="To" value={(query.range as { to: string }).to} onChange={(event) => event.target.value && update({ range: { ...(query.range as { from: string; to: string }), to: event.target.value } })} />
            </label>
          </>
        ) : null}
        {apps.length > 1 ? (
          <label className="space-y-1 text-[13px]">
            <span className="block font-medium">App</span>
            <select className={SELECT} aria-label="App" value={query.apps[0] ?? ''} onChange={(event) => update({ apps: event.target.value ? [event.target.value] : [] })}>
              <option value="">Every app</option>
              {apps.map((app) => (
                <option key={app} value={app}>
                  {app}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="space-y-1 text-[13px]">
          <span className="block font-medium">Platform</span>
          <select className={SELECT} aria-label="Platform" value={query.platforms[0] ?? ''} onChange={(event) => update({ platforms: event.target.value ? [event.target.value] : [] })}>
            <option value="">Every client platform</option>
            {CLIENT_PLATFORMS.map((platform) => (
              <option key={platform} value={platform}>
                {platform}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-[13px]">
          <span className="block font-medium">Environment</span>
          <select
            className={SELECT}
            aria-label="Environment"
            value={allEnvironments ? '*' : query.environments.length === 1 ? query.environments[0] : '*'}
            onChange={(event) => update({ environments: event.target.value === '*' ? (environments.length > 0 ? environments : ['production']) : [event.target.value] })}
          >
            {[...new Set(['production', ...environments, ...query.environments])].map((environment) => (
              <option key={environment} value={environment}>
                {environment}
              </option>
            ))}
            {environments.length > 1 ? <option value="*">Every environment</option> : null}
          </select>
        </label>
        <label className="space-y-1 text-[13px]">
          <span className="block font-medium">Count</span>
          <select className={SELECT} aria-label="Counting unit" value={query.unit} onChange={(event) => update({ unit: event.target.value as AnalyticsOverviewQuery['unit'] })}>
            <option value="installation">Installations</option>
            <option value="user">User IDs</option>
          </select>
        </label>
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label="Filters applied">
        {chips.map((chip) => (
          <li key={chip.label}>
            <Badge variant={chip.isDefault ? 'outline' : 'muted'} className="gap-1">
              {chip.label}
              {chip.isDefault ? <span className="text-muted-foreground">(default)</span> : null}
              {chip.remove ? (
                <button type="button" className="-mr-1 rounded-sm p-0.5 hover:bg-muted" aria-label={`Remove ${chip.label}`} onClick={chip.remove}>
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- The figures (AN-140, AN-141) ------------------------------------------------------------------

function Figures({ data }: { data: AnalyticsOverview }) {
  const f = data.figures;
  const units = data.unit === 'user' ? 'user IDs' : 'installations';
  const crash = data.crashFree.overall;
  const retention = (n: 1 | 7 | 30, figure: AnalyticsFigure & { installations: number }) => ({
    label: `D${n} retention`,
    figure,
    kind: 'ratio' as const,
    empty: `No installation of this range has reached day ${n} yet`,
    note: figure.value === null ? undefined : `of ${integer(figure.installations)} installations`,
  });
  const cards: { label: string; figure: AnalyticsFigure; kind: 'count' | 'ratio'; empty?: string; note?: string }[] = [
    { label: `Active ${units}, last hour`, figure: f.activeLastHour, kind: 'count' },
    { label: `Daily active ${units}, yesterday`, figure: f.dailyActiveLastDay, kind: 'count' },
    { label: `Daily active ${units}, today so far`, figure: f.dailyActiveToday, kind: 'count' },
    { label: `Weekly active ${units}`, figure: f.weeklyActive, kind: 'count' },
    { label: `Monthly active ${units}`, figure: f.monthlyActive, kind: 'count' },
    { label: 'Stickiness', figure: f.stickiness, kind: 'ratio', note: 'mean daily ÷ monthly active' },
    { label: 'New installations', figure: f.newInstallations, kind: 'count' },
    { label: 'Sessions', figure: f.sessions, kind: 'count' },
    retention(1, f.d1),
    retention(7, f.d7),
    retention(30, f.d30),
    {
      label: 'Crash-free sessions',
      figure: { value: crash.rate, previous: crash.previous, covered: data.crashFree.covered },
      kind: 'ratio',
      empty: 'Not measured: no session reported a crash module',
      note: crash.measured ? `of ${integer(crash.sessions)} sessions${crash.lowConfidence ? ', low confidence' : ''}` : undefined,
    },
  ];
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Figures" data-testid="overview-figures">
      {cards.map((card) => (
        <li key={card.label} className="rounded-lg border p-3" data-testid="figure">
          <p className="text-[13px] text-muted-foreground">{card.label}</p>
          <p className="numeric text-2xl font-semibold tracking-tight" data-testid="figure-value">
            {card.figure.value === null ? (card.empty ? <span className="block text-sm font-normal leading-snug">{card.empty}</span> : 'No data') : card.kind === 'ratio' ? percent(card.figure.value) : integer(card.figure.value)}
          </p>
          {card.note ? <p className="text-xs text-muted-foreground">{card.note}</p> : null}
          <p className="text-xs text-muted-foreground" data-testid="figure-change">
            {changeText(card.figure, card.kind)}
          </p>
        </li>
      ))}
    </ul>
  );
}

// --- The chart (AN-142) -------------------------------------------------------------------------------

function DailyActive({ data }: { data: AnalyticsOverview }) {
  const label = data.unit === 'user' ? 'Daily active user IDs' : 'Daily active installations';
  // The trend chart's own shape: one series, a point a day, the band before the oldest day kept.
  const answer: AnalyticsTrendAnswer = {
    range: data.range,
    interval: 'day',
    timezone: data.timezone,
    keptFrom: data.keptFrom,
    series: [{ label, event: '*', metric: data.unit === 'user' ? 'users' : 'installations', covered: data.dailyActive.covered, notice: null, points: data.dailyActive.points }],
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>A dashed vertical line marks the day each app version was first seen.</CardDescription>
      </CardHeader>
      <CardContent>
        <TrendChart answer={answer} markers={data.versionsFirstSeen.map((entry) => ({ day: entry.day, label: entry.version }))} />
      </CardContent>
    </Card>
  );
}

// --- Shares, top events, crash-free sessions ---------------------------------------------------------

function ShareTable({ title, rows, testId }: { title: string; rows: AnalyticsShare[]; testId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>Installations active in the last 7 days, each once, by its latest {title.toLowerCase()}.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No installation was active in the last 7 days.</p>
        ) : (
          <Table data-testid={testId}>
            <TableHeader>
              <TableRow>
                <TableHead>{title}</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead className="text-right">Installs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.other ? 'other' : 'value'}-${row.value}`}>
                  <TableCell className="text-[13px]">{row.other ? 'Other' : row.value === '' ? 'Unknown' : row.value}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className="hidden h-1.5 w-12 overflow-hidden rounded bg-muted sm:inline-block" aria-hidden="true">
                        <span className="block h-full bg-primary" style={{ width: `${Math.max(1, row.share * 100)}%` }} />
                      </span>
                      <span className="numeric w-12">{percent(row.share)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="numeric text-right">{integer(row.installations)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function TopEvents({ data }: { data: AnalyticsOverview }) {
  const chartOf = (event: string) => JSON.stringify({ range: { preset: 'last30Days' }, interval: 'day', series: [{ event, metric: 'installations', filters: [] }], filters: [] });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Top events, last 24 hours</CardTitle>
        <CardDescription>
          The ten events with the most occurrences, hidden ones left out
          {data.topEvents.computedAt ? `, as of ${new Date(data.topEvents.computedAt).toLocaleString()}` : ''}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.topEvents.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">The 24-hour figures appear within five minutes of the first events.</p>
        ) : (
          <Table data-testid="top-events">
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead className="text-right">Events</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.topEvents.events.map((entry) => (
                <TableRow key={entry.name}>
                  <TableCell>
                    <Link className="font-mono text-xs underline-offset-2 hover:underline" to={`?${new URLSearchParams({ tab: 'insights', panel: 'events', chart: chartOf(entry.name) }).toString()}`}>
                      {entry.name}
                    </Link>
                  </TableCell>
                  <TableCell className="numeric text-right">{integer(entry.events)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function crashFreeText(row: AnalyticsCrashFree): string {
  return row.measured && row.rate !== null ? percent(row.rate) : 'Not measured';
}

function CrashFreeTable({ data }: { data: AnalyticsOverview }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Crash-free sessions by app version</CardTitle>
        <CardDescription>The five versions with the most sessions in the range. A version is not measured when none of its sessions reported a crash module.</CardDescription>
      </CardHeader>
      <CardContent>
        {data.crashFree.versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No session in this range.</p>
        ) : (
          <Table data-testid="crash-free-versions">
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">Crash-free</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.crashFree.versions.map((row) => (
                <TableRow key={row.version}>
                  <TableCell className="font-mono text-xs">{row.version}</TableCell>
                  <TableCell className="text-right">
                    <span className="numeric">{crashFreeText(row)}</span>
                    {row.lowConfidence ? (
                      <Badge variant="outline" className="ml-2">
                        Low confidence
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="numeric text-right">{integer(row.sessions)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
