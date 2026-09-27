import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, DownloadIcon, EyeOffIcon, InfoIcon, PlusIcon, TrashIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  ANALYTICS_FILTER_FIELDS,
  ANALYTICS_INTERVALS,
  ANALYTICS_METRICS,
  ANALYTICS_RANGE_PRESETS,
  ANALYTICS_SPLIT_FIELDS,
  ANY_EVENT,
  analyticsFilterSchema,
  analyticsTrendQuerySchema,
  filterOpsFor,
  type AnalyticsFilter,
  type AnalyticsFilterField,
  type AnalyticsFilterOp,
  type AnalyticsSplit,
} from '@inlet/shared';
import { api, ApiError, type AnalyticsCatalogEntry, type AnalyticsTrendDefinition } from '@/lib/api';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { TrendChart } from '@/components/trend-chart';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

/**
 * Insights → Events (UX Analytics PRD 8.1; AN-050 to AN-069): the catalog, the chart builder
 * an event opens, and an event's drawer with its Lexicon. The chart's state — series,
 * filters, split, range and interval — is the `chart` parameter of the address (AN-068), so
 * a chart can be bookmarked and shared. Every user-authored string (names, descriptions,
 * values) is rendered as text.
 */

type Role = 'admin' | 'creator' | 'viewer';

const LABELS = {
  metric: { events: 'Events', installations: 'Unique installations', users: 'Unique user IDs', perInstallation: 'Events per installation' },
  interval: { hour: 'Hour', day: 'Day', week: 'Week', month: 'Month', year: 'Year' },
  preset: {
    today: 'Today',
    yesterday: 'Yesterday',
    last7Days: 'Last 7 days',
    last30Days: 'Last 30 days',
    last90Days: 'Last 90 days',
    last12Months: 'Last 12 months',
    thisMonth: 'This month',
    thisYear: 'This year',
  },
  field: {
    platform: 'Platform',
    platformVersion: 'Platform version',
    runtime: 'Runtime',
    app: 'App',
    appVersion: 'App version',
    environment: 'Environment',
    country: 'Country',
    userId: 'User ID',
    installationId: 'Installation ID',
    attribution: 'Attribution',
    installAttribution: 'Install attribution',
    category: 'Category',
    installAgeDays: 'Install age (days)',
    installAgeWeeks: 'Install age (weeks)',
    installAgeMonths: 'Install age (months)',
    experiment: 'Experiment',
    param: 'Param',
  },
  op: { is: 'is', isNot: 'is not', isSet: 'is set', isNotSet: 'is not set', startsWith: 'starts with', contains: 'contains', gt: 'greater than', lt: 'less than', between: 'between' },
} as const;

/** One sentence each for the states a query can end in (PRD 8.1, 9.5). */
export function queryErrorSentence(error: unknown, unreachable: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'analytics_unavailable') return unreachable;
    if (error.code === 'analytics_busy') return 'Every analytics query slot is busy right now; try again in a few seconds.';
    if (error.code === 'query_limit_exceeded') return 'This chart took too long or needed too much memory; choose a shorter range or a coarser interval.';
    return error.message;
  }
  return 'The chart could not be loaded; try again.';
}

const SELECT = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-2 focus-visible:outline-ring';

/** A filter row is kept in the address as it is typed; only complete filters are sent. */
function draftFilters(list: unknown): AnalyticsFilter[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (filter): filter is AnalyticsFilter =>
      typeof filter === 'object' && filter !== null && typeof (filter as AnalyticsFilter).field === 'string' && typeof (filter as AnalyticsFilter).op === 'string',
  );
}
const complete = (filters: AnalyticsFilter[]) => filters.filter((filter) => analyticsFilterSchema.safeParse(filter).success);

/**
 * AN-064, AN-068: the builder's state, read from the address. `chart` is what the builder shows,
 * filters being typed included; `query` is the definition sent, checked with the query's own
 * schema, without the filters not yet complete. An address that is not a chart falls back to the
 * event's default one: installations over the last 30 days by day.
 */
function readChart(raw: string | null, event: string): { chart: AnalyticsTrendDefinition; query: AnalyticsTrendDefinition } {
  if (raw) {
    try {
      const stored = JSON.parse(raw) as { filters?: unknown; series?: { filters?: unknown }[] } & Record<string, unknown>;
      const series = Array.isArray(stored.series) ? stored.series : [];
      const parsed = analyticsTrendQuerySchema.safeParse({
        ...stored,
        filters: complete(draftFilters(stored.filters)),
        series: series.map((entry) => ({ ...entry, filters: complete(draftFilters(entry?.filters)) })),
      });
      if (parsed.success) {
        const query = parsed.data;
        const chart = { ...query, filters: draftFilters(stored.filters), series: query.series.map((entry, index) => ({ ...entry, filters: draftFilters(series[index]?.filters) })) };
        return { chart, query };
      }
    } catch {
      // An address edited by hand falls back to the default chart.
    }
  }
  const chart: AnalyticsTrendDefinition = { range: { preset: 'last30Days' }, interval: 'day', series: [{ event, metric: 'installations', filters: [] }], filters: [] };
  return { chart, query: chart };
}

export function EventsPanel({ databaseId, role, unreachable }: { databaseId: string; role: Role | undefined; unreachable: string }) {
  const [params, setParams] = useSearchParams();
  const chartParam = params.get('chart');
  const [drawer, setDrawer] = useState<string | null>(null);
  const open = (event: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('chart', JSON.stringify(readChart(null, event).chart));
      return next;
    });
  const close = () =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('chart');
      return next;
    });

  return (
    <div className="mt-4 space-y-4">
      {chartParam ? (
        <ChartBuilder
          databaseId={databaseId}
          {...readChart(chartParam, ANY_EVENT)}
          onChange={(chart) =>
            setParams(
              (previous) => {
                const next = new URLSearchParams(previous);
                next.set('chart', JSON.stringify(chart));
                return next;
              },
              { replace: true },
            )
          }
          onBack={close}
          onDetails={setDrawer}
          unreachable={unreachable}
        />
      ) : (
        <Catalog databaseId={databaseId} onOpen={open} onDetails={setDrawer} />
      )}
      {drawer ? <EventDrawer databaseId={databaseId} name={drawer} role={role} onClose={() => setDrawer(null)} unreachable={unreachable} /> : null}
    </div>
  );
}

// --- The catalog (AN-050, AN-051, AN-054) ------------------------------------------------------

function Catalog({ databaseId, onOpen, onDetails }: { databaseId: string; onOpen: (event: string) => void; onDetails: (event: string) => void }) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<'name' | 'lastSeen' | 'events24h'>('name');
  const [includeHidden, setIncludeHidden] = useState(false);
  const list = useQuery({
    queryKey: ['analytics-events', databaseId, { q, category, sort, includeHidden }],
    queryFn: () => api.listAnalyticsEvents(databaseId, { q: q.trim() || undefined, category: category ?? undefined, sort, includeHidden }),
    placeholderData: keepPreviousData,
  });
  // The chips are the categories of every name, not only those the search left.
  const all = useQuery({ queryKey: ['analytics-events', databaseId, 'all'], queryFn: () => api.listAnalyticsEvents(databaseId, { includeHidden: true }) });
  const categories = [...new Set((all.data?.events ?? []).map((entry) => entry.category).filter((value): value is string => Boolean(value)))].sort();
  const computedAt = (list.data?.events ?? []).map((entry) => entry.computedAt).filter((value): value is string => value !== null).sort().at(-1);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Events</CardTitle>
          <CardDescription>
            Every event name this database has received. Open one to chart it.
            {computedAt ? ` Last seen and the 24-hour figures as of ${new Date(computedAt).toLocaleString()}.` : ' The 24-hour figures appear within five minutes of the first events.'}
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={api.analyticsCatalogExportUrl(databaseId, 'csv')} download>
              <DownloadIcon />
              CSV
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={api.analyticsCatalogExportUrl(databaseId, 'json')} download>
              <DownloadIcon />
              JSON
            </a>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input className="max-w-xs" placeholder="Search names and descriptions" aria-label="Search events" value={q} onChange={(event) => setQ(event.target.value)} />
          <label className="flex items-center gap-2 text-sm">
            Sort
            <select className={SELECT} value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="Sort events">
              <option value="name">Name</option>
              <option value="lastSeen">Last seen</option>
              <option value="events24h">Events in 24 hours</option>
            </select>
          </label>
          <div className="flex items-center gap-2">
            <Switch id="show-hidden" checked={includeHidden} onCheckedChange={setIncludeHidden} />
            <Label htmlFor="show-hidden">Show hidden</Label>
          </div>
        </div>
        {categories.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category">
            <Button size="sm" variant={category === null ? 'secondary' : 'ghost'} aria-pressed={category === null} onClick={() => setCategory(null)}>
              All categories
            </Button>
            {categories.map((value) => (
              <Button key={value} size="sm" variant={category === value ? 'secondary' : 'ghost'} aria-pressed={category === value} onClick={() => setCategory(category === value ? null : value)}>
                {value}
              </Button>
            ))}
          </div>
        ) : null}
        {list.isLoading ? (
          <Skeleton className="h-40" />
        ) : (list.data?.events ?? []).length === 0 ? (
          <EmptyState title={q || category ? 'No event matches' : 'No events yet'} description={q || category ? 'Try another search or category.' : 'Events appear here as soon as an application sends them. Collect shows how.'} />
        ) : (
          <Table data-testid="event-catalog">
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="text-right">Events, 24 h</TableHead>
                <TableHead className="text-right">Installations, 24 h</TableHead>
                <TableHead className="text-right">User IDs, 24 h</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data!.events.map((entry) => (
                <CatalogRow key={entry.name} entry={entry} onOpen={onOpen} onDetails={onDetails} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function CatalogRow({ entry, onOpen, onDetails }: { entry: AnalyticsCatalogEntry; onOpen: (event: string) => void; onDetails: (event: string) => void }) {
  return (
    <TableRow>
      <TableCell>
        <button type="button" className="font-mono text-xs underline-offset-2 hover:underline" onClick={() => onOpen(entry.name)}>
          {entry.name}
        </button>
        <span className="ml-2 inline-flex gap-1">
          {entry.hidden ? <Badge variant="outline">Hidden</Badge> : null}
          {entry.blocked ? <Badge variant="outline">Blocked</Badge> : null}
        </span>
      </TableCell>
      <TableCell className="text-[13px]">{entry.category ?? ''}</TableCell>
      <TableCell className="max-w-sm truncate text-[13px] text-muted-foreground" title={entry.description ?? undefined}>
        {entry.description ?? ''}
      </TableCell>
      <TableCell className="numeric whitespace-nowrap text-[13px]">{entry.lastSeen ? new Date(entry.lastSeen).toLocaleString() : ''}</TableCell>
      <TableCell className="numeric text-right">{entry.last24h.events.toLocaleString()}</TableCell>
      <TableCell className="numeric text-right">{entry.last24h.installations.toLocaleString()}</TableCell>
      <TableCell className="numeric text-right">{entry.last24h.users.toLocaleString()}</TableCell>
      <TableCell className="text-right">
        <Button variant="ghost" size="sm" aria-label={`Details of ${entry.name}`} onClick={() => onDetails(entry.name)}>
          <InfoIcon />
        </Button>
      </TableCell>
    </TableRow>
  );
}

// --- The chart builder (AN-060 to AN-069) ---------------------------------------------------------

function ChartBuilder({
  databaseId,
  chart,
  query,
  onChange,
  onBack,
  onDetails,
  unreachable,
}: {
  databaseId: string;
  chart: AnalyticsTrendDefinition;
  query: AnalyticsTrendDefinition;
  onChange: (chart: AnalyticsTrendDefinition) => void;
  onBack: () => void;
  onDetails: (event: string) => void;
  unreachable: string;
}) {
  const catalog = useQuery({ queryKey: ['analytics-events', databaseId, 'picker'], queryFn: () => api.listAnalyticsEvents(databaseId) });
  const trend = useQuery({
    queryKey: ['analytics-trend', databaseId, query],
    queryFn: ({ signal }) => api.analyticsTrend(databaseId, query, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const [exporting, setExporting] = useState(false);
  const names = (catalog.data?.events ?? []).map((entry) => entry.name);
  const update = (patch: Partial<AnalyticsTrendDefinition>) => {
    const next = { ...chart, ...patch };
    // AN-063: a split needs exactly one series.
    if (next.series.length > 1) delete next.split;
    onChange(next);
  };
  const setSeries = (index: number, patch: Partial<AnalyticsTrendDefinition['series'][number]>) =>
    update({ series: chart.series.map((series, i) => (i === index ? { ...series, ...patch } : series)) });
  const custom = 'from' in chart.range;
  const exportAs = async (format: 'csv' | 'json') => {
    setExporting(true);
    try {
      await api.downloadAnalyticsTrend(databaseId, query, format);
    } catch (error) {
      toast.error(queryErrorSentence(error, unreachable));
    } finally {
      setExporting(false);
    }
  };
  const first = chart.series[0]?.event;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
            <ArrowLeftIcon />
            All events
          </Button>
          <CardTitle className="font-mono text-base">{chart.series.map((series) => (series.event === ANY_EVENT ? 'Any event' : series.event)).join(', ')}</CardTitle>
          <CardDescription>The address holds this chart: bookmark it or share it.</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          {first && first !== ANY_EVENT ? (
            <Button variant="outline" size="sm" onClick={() => onDetails(first)}>
              <InfoIcon />
              Event details
            </Button>
          ) : null}
          <Button variant="outline" size="sm" disabled={exporting} onClick={() => void exportAs('csv')}>
            <DownloadIcon />
            Export CSV
          </Button>
          <Button variant="outline" size="sm" disabled={exporting} onClick={() => void exportAs('json')}>
            <DownloadIcon />
            Export JSON
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-3" aria-label="Series">
          {chart.series.map((series, index) => (
            <div key={index} className="space-y-2 rounded-md border p-3" data-testid="series-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">Series {index + 1}</span>
                <select className={SELECT} aria-label={`Event of series ${index + 1}`} value={series.event} onChange={(event) => setSeries(index, { event: event.target.value })}>
                  <option value={ANY_EVENT}>Any event</option>
                  {[...new Set([...names, ...(series.event === ANY_EVENT ? [] : [series.event])])].map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <select className={SELECT} aria-label={`Metric of series ${index + 1}`} value={series.metric} onChange={(event) => setSeries(index, { metric: event.target.value as (typeof ANALYTICS_METRICS)[number] })}>
                  {ANALYTICS_METRICS.map((metric) => (
                    <option key={metric} value={metric}>
                      {LABELS.metric[metric]}
                    </option>
                  ))}
                </select>
                <Input
                  className="h-9 w-40"
                  placeholder="Label (optional)"
                  aria-label={`Label of series ${index + 1}`}
                  maxLength={80}
                  value={series.label ?? ''}
                  onChange={(event) => setSeries(index, { label: event.target.value || undefined })}
                />
                {chart.series.length > 1 ? (
                  <Button variant="ghost" size="sm" aria-label={`Remove series ${index + 1}`} onClick={() => update({ series: chart.series.filter((_, i) => i !== index) })}>
                    <XIcon />
                  </Button>
                ) : null}
              </div>
              <FilterList databaseId={databaseId} event={series.event} filters={series.filters} label={`series ${index + 1}`} onChange={(filters) => setSeries(index, { filters })} />
            </div>
          ))}
          {chart.series.length < 5 ? (
            <Button variant="outline" size="sm" onClick={() => update({ series: [...chart.series, { event: chart.series[0]?.event ?? ANY_EVENT, metric: chart.series[0]?.metric ?? 'installations', filters: [] }] })}>
              <PlusIcon />
              Add a series
            </Button>
          ) : null}
        </section>

        <section className="space-y-2 rounded-md border p-3" aria-label="Global filters">
          <p className="text-[13px] font-medium">Filters on every series</p>
          <FilterList databaseId={databaseId} event={first ?? ANY_EVENT} filters={chart.filters} label="every series" onChange={(filters) => update({ filters })} />
          <p className="text-xs text-muted-foreground">Without an environment filter, only production events count.</p>
        </section>

        <section className="flex flex-wrap items-end gap-4" aria-label="Time and split">
          <label className="space-y-1 text-[13px]">
            <span className="block font-medium">Range</span>
            <select
              className={SELECT}
              aria-label="Range"
              value={custom ? 'custom' : (chart.range as { preset: string }).preset}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'custom') {
                  const today = new Date().toISOString().slice(0, 10);
                  update({ range: { from: today, to: today } });
                } else update({ range: { preset: value as (typeof ANALYTICS_RANGE_PRESETS)[number] } });
              }}
            >
              {ANALYTICS_RANGE_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {LABELS.preset[preset]}
                </option>
              ))}
              <option value="custom">Dates</option>
            </select>
          </label>
          {custom ? (
            <>
              <label className="space-y-1 text-[13px]">
                <span className="block font-medium">From</span>
                <Input type="date" className="h-9" aria-label="From" value={(chart.range as { from: string }).from} onChange={(event) => event.target.value && update({ range: { ...(chart.range as { from: string; to: string }), from: event.target.value } })} />
              </label>
              <label className="space-y-1 text-[13px]">
                <span className="block font-medium">To</span>
                <Input type="date" className="h-9" aria-label="To" value={(chart.range as { to: string }).to} onChange={(event) => event.target.value && update({ range: { ...(chart.range as { from: string; to: string }), to: event.target.value } })} />
              </label>
            </>
          ) : null}
          <label className="space-y-1 text-[13px]">
            <span className="block font-medium">Interval</span>
            <select className={SELECT} aria-label="Interval" value={chart.interval} onChange={(event) => update({ interval: event.target.value as (typeof ANALYTICS_INTERVALS)[number] })}>
              {ANALYTICS_INTERVALS.map((interval) => (
                <option key={interval} value={interval}>
                  {LABELS.interval[interval]}
                </option>
              ))}
            </select>
          </label>
          <SplitControl split={chart.split} disabled={chart.series.length > 1} onChange={(split) => update({ split })} />
        </section>

        {trend.error ? (
          <p role="status" className="rounded-md border border-destructive/40 px-3 py-2 text-sm" data-testid="trend-error">
            {queryErrorSentence(trend.error, unreachable)}
          </p>
        ) : trend.data ? (
          <TrendChart answer={trend.data} />
        ) : (
          <Skeleton className="h-60" />
        )}
      </CardContent>
    </Card>
  );
}

function SplitControl({ split, disabled, onChange }: { split: AnalyticsSplit | undefined; disabled: boolean; onChange: (split: AnalyticsSplit | undefined) => void }) {
  // An experiment or a param split waits for its key before it is applied.
  const [field, setField] = useState<AnalyticsSplit['field'] | ''>(split?.field ?? '');
  const [key, setKey] = useState(split?.key ?? '');
  useEffect(() => {
    setField(split?.field ?? '');
    setKey(split?.key ?? '');
  }, [split?.field, split?.key]);
  const keyed = field === 'experiment' || field === 'param';
  return (
    <div className="flex items-end gap-2">
      <label className="space-y-1 text-[13px]">
        <span className="block font-medium">Split by</span>
        <select
          className={SELECT}
          aria-label="Split by"
          disabled={disabled}
          value={field}
          onChange={(event) => {
            const next = event.target.value as AnalyticsSplit['field'] | '';
            setField(next);
            setKey('');
            if (next === '') onChange(undefined);
            else if (next !== 'experiment' && next !== 'param') onChange({ field: next });
          }}
        >
          <option value="">Nothing</option>
          {ANALYTICS_SPLIT_FIELDS.map((value) => (
            <option key={value} value={value}>
              {LABELS.field[value]}
            </option>
          ))}
        </select>
      </label>
      {keyed && !disabled ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) onChange({ field, key: key.trim() });
          }}
        >
          <Input className="h-9 w-36" aria-label="Split key" placeholder={field === 'param' ? 'Param key' : 'Experiment key'} value={key} onChange={(event) => setKey(event.target.value)} />
          <Button type="submit" variant="outline" size="sm">
            Split
          </Button>
        </form>
      ) : null}
      {disabled ? <p className="pb-2 text-xs text-muted-foreground">A split needs a single series.</p> : null}
    </div>
  );
}

// --- Filters (AN-057, AN-062) -------------------------------------------------------------------

const KEYED: AnalyticsFilterField[] = ['experiment', 'param'];
const FILTER_VALUE_DIMENSIONS = new Set(['platform', 'platformVersion', 'runtime', 'app', 'appVersion', 'environment', 'country', 'attribution', 'installAttribution', 'category']);

function FilterList({ databaseId, event, filters, label, onChange }: { databaseId: string; event: string; filters: AnalyticsFilter[]; label: string; onChange: (filters: AnalyticsFilter[]) => void }) {
  return (
    <div className="space-y-2">
      {filters.map((filter, index) => (
        <FilterRow
          key={index}
          databaseId={databaseId}
          event={event}
          filter={filter}
          label={`${label}, filter ${index + 1}`}
          onChange={(next) => onChange(filters.map((f, i) => (i === index ? next : f)))}
          onRemove={() => onChange(filters.filter((_, i) => i !== index))}
        />
      ))}
      <Button variant="ghost" size="sm" onClick={() => onChange([...filters, { field: 'appVersion', op: 'is', values: [] }])} aria-label={`Add a filter to ${label}`}>
        <PlusIcon />
        Add a filter
      </Button>
    </div>
  );
}

/**
 * One filter. Values are typed as text, comma-separated, with the values the database holds
 * offered as suggestions (AN-057); an incomplete filter is not sent until it has what its
 * operator needs.
 */
function FilterRow({
  databaseId,
  event,
  filter,
  label,
  onChange,
  onRemove,
}: {
  databaseId: string;
  event: string;
  filter: AnalyticsFilter;
  label: string;
  onChange: (filter: AnalyticsFilter) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState((filter.values ?? []).join(', '));
  const [key, setKey] = useState(filter.key ?? '');
  const listId = useMemo(() => `values-${Math.random().toString(36).slice(2)}`, []);
  const ops = filterOpsFor(filter.field);
  const suggest =
    FILTER_VALUE_DIMENSIONS.has(filter.field) || (filter.field === 'experiment' && filter.key) || (filter.field === 'param' && filter.key && event !== ANY_EVENT);
  const values = useQuery({
    queryKey: ['analytics-filter-values', databaseId, filter.field, filter.key, event],
    queryFn: () =>
      filter.field === 'param'
        ? api.analyticsFilterValues(databaseId, { param: filter.key!, event })
        : api.analyticsFilterValues(databaseId, { dimension: filter.field, ...(filter.field === 'experiment' ? { key: filter.key! } : {}) }),
    enabled: Boolean(suggest),
    retry: false,
    staleTime: 60_000,
  });
  const noValues = filter.op === 'isSet' || filter.op === 'isNotSet';
  const numeric = filter.op === 'gt' || filter.op === 'lt' || filter.op === 'between';
  const commit = (nextText: string, nextOp: AnalyticsFilterOp = filter.op, nextKey = key) => {
    const parts = nextText.split(',').map((part) => part.trim()).filter(Boolean);
    const base = { field: filter.field, op: nextOp, ...(KEYED.includes(filter.field) ? { key: nextKey.trim() } : {}) };
    if (nextOp === 'isSet' || nextOp === 'isNotSet') return onChange(base);
    if (nextOp === 'gt' || nextOp === 'lt' || nextOp === 'between') return onChange({ ...base, values: parts.map(Number).filter((value) => Number.isFinite(value)) });
    onChange({ ...base, values: parts });
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="filter-row">
      <select
        className={SELECT}
        aria-label={`Field of ${label}`}
        value={filter.field}
        onChange={(e) => {
          const field = e.target.value as AnalyticsFilterField;
          const op = filterOpsFor(field)[0]!;
          setText('');
          setKey('');
          onChange({ field, op, ...(KEYED.includes(field) ? { key: '' } : {}), ...(op === 'isSet' ? {} : { values: [] }) });
        }}
      >
        {ANALYTICS_FILTER_FIELDS.map((field) => (
          <option key={field} value={field}>
            {LABELS.field[field]}
          </option>
        ))}
      </select>
      {KEYED.includes(filter.field) ? (
        <Input className="h-9 w-32" aria-label={`Key of ${label}`} placeholder="Key" value={key} onChange={(e) => setKey(e.target.value)} onBlur={() => commit(text, filter.op, key)} />
      ) : null}
      <select className={SELECT} aria-label={`Operator of ${label}`} value={filter.op} onChange={(e) => commit(text, e.target.value as AnalyticsFilterOp)}>
        {ops.map((op) => (
          <option key={op} value={op}>
            {LABELS.op[op]}
          </option>
        ))}
      </select>
      {noValues ? null : (
        <>
          <Input
            className="h-9 w-56"
            aria-label={`Values of ${label}`}
            placeholder={filter.op === 'between' ? 'Lowest, highest' : numeric ? 'A number' : 'Values, comma-separated'}
            list={suggest ? listId : undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => commit(text)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit(text);
              }
            }}
          />
          {suggest ? (
            <datalist id={listId}>
              {(values.data?.values ?? []).map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          ) : null}
        </>
      )}
      <Button variant="ghost" size="sm" aria-label={`Remove ${label}`} onClick={onRemove}>
        <XIcon />
      </Button>
    </div>
  );
}

// --- The event drawer (AN-052 to AN-056, AN-059) --------------------------------------------------

function EventDrawer({ databaseId, name, role, onClose, unreachable }: { databaseId: string; name: string; role: Role | undefined; onClose: () => void; unreachable: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['analytics-event', databaseId, name], queryFn: () => api.getAnalyticsEvent(databaseId, name), retry: false });
  const [description, setDescription] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const canEdit = role === 'admin' || role === 'creator';
  const isAdmin = role === 'admin';
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['analytics-event', databaseId, name] });
    await queryClient.invalidateQueries({ queryKey: ['analytics-events', databaseId] });
  };
  const failed = (error: unknown) => toast.error(error instanceof ApiError ? error.message : 'The change did not complete.');
  const update = useMutation({
    mutationFn: (patch: { description?: string | null; hidden?: boolean }) => api.updateAnalyticsEvent(databaseId, name, patch),
    onSuccess: async (_, patch) => {
      await refresh();
      setDescription(null);
      toast.success(patch.hidden === undefined ? 'Description saved.' : patch.hidden ? 'Event hidden.' : 'Event shown again.');
    },
    onError: failed,
  });
  const block = useMutation({
    mutationFn: (blocked: boolean) => api.blockAnalyticsEvent(databaseId, name, blocked),
    onSuccess: async (_, blocked) => {
      await refresh();
      toast.success(blocked ? 'Event blocked: new events with this name are refused.' : 'Event unblocked.');
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAnalyticsEvent(databaseId, name, name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['analytics-events', databaseId] });
      toast.success('Event deleted.');
      setDeleting(false);
      onClose();
    },
    onError: failed,
  });
  const event = detail.data;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{name}</DialogTitle>
          <DialogDescription>
            {event ? `${event.standard ? 'A standard event. ' : ''}First seen ${new Date(event.firstSeen).toLocaleDateString()}${event.lastSeen ? `, last seen ${new Date(event.lastSeen).toLocaleString()}` : ''}.` : 'Loading.'}
          </DialogDescription>
        </DialogHeader>
        {detail.error ? (
          <p role="status" className="text-sm">
            {queryErrorSentence(detail.error, unreachable)}
          </p>
        ) : !event ? (
          <Skeleton className="h-32" />
        ) : (
          <div className="space-y-5">
            <section className="space-y-2">
              <Label htmlFor="event-description">Description</Label>
              {canEdit ? (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    update.mutate({ description: (description ?? '').trim() || null });
                  }}
                >
                  <Textarea id="event-description" maxLength={500} value={description ?? event.description ?? ''} onChange={(e) => setDescription(e.target.value)} placeholder="What this event means and when it is sent." />
                  <Button type="submit" size="sm" disabled={update.isPending || description === null}>
                    Save description
                  </Button>
                </form>
              ) : (
                <p className="text-sm text-muted-foreground">{event.description ?? 'No description yet.'}</p>
              )}
            </section>

            <section className="space-y-2">
              <p className="text-sm font-medium">Params</p>
              {event.params.length === 0 ? (
                <p className="text-sm text-muted-foreground">This event carries no params.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Key</TableHead>
                      <TableHead>Types</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Top values, last 7 days</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {event.params.map((param) => (
                      <TableRow key={param.key}>
                        <TableCell className="font-mono text-xs">{param.key}</TableCell>
                        <TableCell className="text-[13px]">{param.types.join(', ')}</TableCell>
                        <TableCell className="text-[13px]">
                          <ParamDescription databaseId={databaseId} event={name} param={param} canEdit={canEdit} onSaved={refresh} />
                        </TableCell>
                        <TableCell className="text-[13px]">
                          {param.topValues.map((top) => (
                            <span key={top.value} className="mr-2 inline-block">
                              <span className="font-mono">{top.value}</span> <span className="numeric text-muted-foreground">{top.events.toLocaleString()}</span>
                            </span>
                          ))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            <section className="flex flex-wrap gap-2 border-t pt-4">
              {canEdit ? (
                <Button variant="outline" size="sm" disabled={update.isPending} onClick={() => update.mutate({ hidden: !event.hidden })}>
                  <EyeOffIcon />
                  {event.hidden ? 'Show in the catalog' : 'Hide'}
                </Button>
              ) : null}
              {isAdmin && !event.standard ? (
                <>
                  <Button variant="outline" size="sm" disabled={block.isPending} onClick={() => block.mutate(!event.blocked)}>
                    {event.blocked ? 'Unblock' : 'Block'}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>
                    <TrashIcon />
                    Delete
                  </Button>
                </>
              ) : null}
              {event.standard ? <p className="text-xs text-muted-foreground">Standard events cannot be blocked or deleted.</p> : null}
            </section>
          </div>
        )}
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${name}?`}
          confirmText={name}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          description={
            <>
              <p>Every stored event with this name is deleted, and the name leaves the catalog with its descriptions.</p>
              <p>If an application sends it again, it comes back as a new event. To stop it arriving, block it instead.</p>
            </>
          }
        />
      </DialogContent>
    </Dialog>
  );
}

function ParamDescription({
  databaseId,
  event,
  param,
  canEdit,
  onSaved,
}: {
  databaseId: string;
  event: string;
  param: { key: string; description: string | null };
  canEdit: boolean;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (value: string | null) => api.updateAnalyticsEventParam(databaseId, event, param.key, value),
    onSuccess: async () => {
      setDraft(null);
      await onSaved();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The description was not saved.'),
  });
  if (!canEdit) return <>{param.description ?? ''}</>;
  return (
    <Input
      className="h-8"
      maxLength={500}
      aria-label={`Description of ${param.key}`}
      placeholder="Describe this param"
      value={draft ?? param.description ?? ''}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== null && save.mutate(draft.trim() || null)}
    />
  );
}
