import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, DownloadIcon, LockIcon, PlusIcon, SaveIcon, TrashIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  ANALYTICS_POPULATION_FILTER_FIELDS,
  ANALYTICS_RANGE_PRESETS,
  analyticsCohortDefinitionSchema,
  type AnalyticsCohortDefinition,
  type AnalyticsCohortRun,
  type AnalyticsFilter,
  type AnalyticsGranularity,
  type AnalyticsRange,
} from '@inlet/shared';
import { api, ApiError } from '@/lib/api';
import { cohortsApi, type CohortAnswer, type SavedCohort } from '@/lib/analytics-cohorts';
import { FilterList, LABELS, SELECT, complete, queryErrorSentence, useDatabaseToday } from '@/components/analytics-events';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * Insights → Cohorts (UX Analytics PRD 8.1, 5.5; AN-100 to AN-109): the saved cohorts, Retention
 * first with a lock, and a cohort opened in the editor with its table — the summary row on top,
 * then each cohort's period and size, then one cell per later period coloured by its share in the
 * accent's intensity scale, showing the percentage and, on hover or focus, the count; incomplete
 * cells carry an asterisk and uncovered ones a dagger, both explained in the legend, so colour is
 * never the only mark (PRD 11). The open cohort is the address's `cohort` parameter (a saved ID,
 * or `new`). Granularity, range and population filters change any run without saving (AN-100):
 * the standard cohort runs by its ID with them as overrides, the others run their current
 * definition inline, which the API computes as it computes the saved one.
 */

type Role = 'admin' | 'creator' | 'viewer';

const DEFAULT_DEFINITION: AnalyticsCohortDefinition = {
  start: { kind: 'install' },
  return: { kind: 'event', event: 'app_started', filters: [] },
  granularity: 'week',
  unit: 'installation',
  filters: [],
};

/** PRD 8.1, 13 "Unstable web identity": the note the Cohorts screen carries. */
export const WEB_NOTE =
  'On the web, browsers clear storage (Safari after seven days without a visit, private windows at once), so a returning visitor can look like a new installation: retention beyond a week is understated unless you count user IDs.';

const GRANULARITY_LABEL: Record<AnalyticsGranularity, string> = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };
const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);

function startText(definition: AnalyticsCohortDefinition): string {
  if (definition.start.kind === 'install') return 'Install';
  if (definition.start.kind === 'firstSeen') return 'First event';
  return definition.start.filters.length > 0 ? `${definition.start.event} (filtered)` : definition.start.event;
}
const returnText = (definition: AnalyticsCohortDefinition) => (definition.return.kind === 'anyEvent' ? 'Any event' : definition.return.event);

export function CohortsPanel({ databaseId, role, unreachable }: { databaseId: string; role: Role | undefined; unreachable: string }) {
  const [params, setParams] = useSearchParams();
  const open = params.get('cohort');
  const go = (cohort: string | null) => setParams({ tab: 'insights', panel: 'cohorts', ...(cohort ? { cohort } : {}) });
  const canSave = role === 'creator' || role === 'admin';
  if (open === 'new') return <CohortEditor key="new" databaseId={databaseId} saved={null} canSave={canSave} unreachable={unreachable} onBack={() => go(null)} onSaved={(id) => go(id)} />;
  if (open) return <SavedCohortEditor key={open} databaseId={databaseId} cohortId={open} canSave={canSave} unreachable={unreachable} onBack={() => go(null)} />;
  return <CohortList databaseId={databaseId} canSave={canSave} onOpen={go} />;
}

function CohortList({ databaseId, canSave, onOpen }: { databaseId: string; canSave: boolean; onOpen: (cohort: string) => void }) {
  const cohorts = useQuery({ queryKey: ['analytics-cohorts', databaseId], queryFn: () => cohortsApi.list(databaseId) });
  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Cohorts</CardTitle>
          <CardDescription>Who comes back: units grouped by when they started, and the share that returned in each later period.</CardDescription>
        </div>
        {canSave ? (
          <Button size="sm" onClick={() => onOpen('new')}>
            <PlusIcon />
            Create a cohort
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {cohorts.isLoading ? (
          <Skeleton className="h-24" />
        ) : cohorts.error ? (
          <p role="status" className="text-sm">
            {cohorts.error instanceof ApiError ? cohorts.error.message : 'The cohorts could not be loaded.'}
          </p>
        ) : (
          <Table data-testid="cohort-list">
            <caption className="sr-only">Saved cohorts</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>Return</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Counting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohorts.data!.cohorts.map((cohort) => (
                <TableRow key={cohort.id}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {cohort.standard ? <LockIcon className="size-3.5 text-muted-foreground" aria-label="Standard cohort, cannot be edited or deleted" /> : null}
                      <button type="button" className="font-medium underline underline-offset-4" onClick={() => onOpen(cohort.id)}>
                        {cohort.name}
                      </button>
                      {cohort.standard ? <Badge variant="muted">Standard</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{startText(cohort.definition)}</TableCell>
                  <TableCell className="font-mono text-xs">{returnText(cohort.definition)}</TableCell>
                  <TableCell>{GRANULARITY_LABEL[cohort.definition.granularity]}</TableCell>
                  <TableCell>{cohort.definition.unit === 'user' ? 'User IDs' : 'Installations'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SavedCohortEditor(props: { databaseId: string; cohortId: string; canSave: boolean; unreachable: string; onBack: () => void }) {
  const saved = useQuery({ queryKey: ['analytics-cohort', props.databaseId, props.cohortId], queryFn: () => cohortsApi.get(props.databaseId, props.cohortId) });
  if (saved.isLoading) return <Skeleton className="mt-4 h-64" />;
  if (saved.error || !saved.data) {
    return (
      <EmptyState
        className="mt-4"
        title="This cohort could not be loaded"
        description={saved.error instanceof ApiError ? saved.error.message : 'Try reloading the page.'}
        action={
          <Button variant="outline" onClick={props.onBack}>
            All cohorts
          </Button>
        }
      />
    );
  }
  return <CohortEditor {...props} saved={saved.data} onSaved={() => undefined} />;
}

/** The definition sent: complete filters only, and a named start or return that names an event. */
function runnable(definition: AnalyticsCohortDefinition): AnalyticsCohortDefinition | null {
  const parsed = analyticsCohortDefinitionSchema.safeParse({
    ...definition,
    filters: complete(definition.filters),
    start: definition.start.kind === 'event' ? { ...definition.start, filters: complete(definition.start.filters) } : definition.start,
    return: definition.return.kind === 'event' ? { ...definition.return, filters: complete(definition.return.filters) } : definition.return,
  });
  return parsed.success ? parsed.data : null;
}

function CohortEditor({
  databaseId,
  saved,
  canSave,
  unreachable,
  onBack,
  onSaved,
}: {
  databaseId: string;
  saved: SavedCohort | null;
  canSave: boolean;
  unreachable: string;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const standard = saved?.standard === true;
  const [name, setName] = useState(saved?.name ?? '');
  const [draft, setDraft] = useState<AnalyticsCohortDefinition>(saved?.definition ?? DEFAULT_DEFINITION);
  const [range, setRange] = useState<AnalyticsRange | null>(saved?.definition.defaultRange ?? null);
  const today = useDatabaseToday(databaseId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const catalog = useQuery({ queryKey: ['analytics-events', databaseId, 'picker'], queryFn: () => api.listAnalyticsEvents(databaseId) });
  const names = (catalog.data?.events ?? []).map((entry) => entry.name);
  const definition = useMemo(() => runnable(draft), [draft]);
  // AN-100, AN-107: the standard cohort runs by its ID, its granularity, range and population filters as overrides.
  const run = useMemo<AnalyticsCohortRun | null>(() => {
    if (!definition) return null;
    const withRange = range ? { range } : {};
    return standard ? { cohortId: saved!.id, granularity: definition.granularity, filters: definition.filters, ...withRange } : { definition, ...withRange };
  }, [definition, range, standard, saved]);
  const update = (patch: Partial<AnalyticsCohortDefinition>) => setDraft((current) => ({ ...current, ...patch }));

  const save = useMutation({
    mutationFn: async () => {
      const { defaultRange: _, ...rest } = definition!;
      const body = range ? { ...rest, defaultRange: range } : rest;
      return saved ? cohortsApi.update(databaseId, saved.id, { name: name.trim(), definition: body }) : cohortsApi.create(databaseId, name.trim(), body);
    },
    onSuccess: async (cohort) => {
      toast.success(saved ? 'Cohort saved.' : 'Cohort created.');
      await queryClient.invalidateQueries({ queryKey: ['analytics-cohorts', databaseId] });
      queryClient.setQueryData(['analytics-cohort', databaseId, cohort.id], cohort);
      if (!saved) onSaved(cohort.id);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The cohort could not be saved.'),
  });
  const remove = useMutation({
    mutationFn: () => cohortsApi.remove(databaseId, saved!.id),
    onSuccess: async () => {
      toast.success('Cohort deleted.');
      await queryClient.invalidateQueries({ queryKey: ['analytics-cohorts', databaseId] });
      onBack();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The cohort could not be deleted.'),
  });
  const exportAs = async (format: 'csv' | 'json') => {
    try {
      await cohortsApi.download(databaseId, run!, format);
    } catch (error) {
      toast.error(queryErrorSentence(error, unreachable));
    }
  };
  const eventPicker = (label: string, value: string, onChange: (event: string) => void) => (
    <select className={SELECT} aria-label={label} value={value} disabled={standard} onChange={(event) => onChange(event.target.value)}>
      <option value="">Choose an event</option>
      {[...new Set([...names, ...(value ? [value] : [])])].map((event) => (
        <option key={event} value={event}>
          {event}
        </option>
      ))}
    </select>
  );
  const rangeValue = range === null ? 'default' : 'from' in range ? 'custom' : range.preset;

  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
            <ArrowLeftIcon />
            All cohorts
          </Button>
          <CardTitle className="flex items-center gap-2">
            {standard ? <LockIcon className="size-4 text-muted-foreground" aria-hidden="true" /> : null}
            {saved ? saved.name : 'New cohort'}
          </CardTitle>
          <CardDescription data-testid="cohort-description">
            {standard
              ? 'The standard cohort: installations by install period, and the share that started the app in each following period. It cannot be edited or deleted; change its granularity, range or filters to read it another way, without saving.'
              : canSave
                ? 'Change the definition and run it; save when it reads right.'
                : 'You can change and run this cohort; a Creator or Admin saves it.'}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {canSave && !standard ? (
            <>
              <Input className="h-9 w-56" aria-label="Cohort name" placeholder="Name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
              <Button size="sm" disabled={!definition || name.trim() === '' || save.isPending} onClick={() => save.mutate()}>
                <SaveIcon />
                Save
              </Button>
              {saved ? (
                <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)}>
                  <TrashIcon />
                  Delete
                </Button>
              ) : null}
            </>
          ) : null}
          <Button variant="outline" size="sm" disabled={!run} onClick={() => void exportAs('csv')}>
            <DownloadIcon />
            Export CSV
          </Button>
          <Button variant="outline" size="sm" disabled={!run} onClick={() => void exportAs('json')}>
            <DownloadIcon />
            Export JSON
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2 rounded-md border p-3" aria-label="Cohort start">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">Start</span>
            <select
              className={SELECT}
              aria-label="Start"
              value={draft.start.kind}
              disabled={standard}
              onChange={(event) => {
                const kind = event.target.value as AnalyticsCohortDefinition['start']['kind'];
                update({ start: kind === 'event' ? { kind, event: '', filters: [] } : { kind }, ...(kind === 'install' ? { unit: 'installation' as const } : {}) });
              }}
            >
              <option value="install">The install</option>
              <option value="firstSeen">The first event</option>
              <option value="event">A named event</option>
            </select>
            {draft.start.kind === 'event' ? eventPicker('Start event', draft.start.event, (event) => update({ start: { ...(draft.start as { kind: 'event'; filters: AnalyticsFilter[] }), event } })) : null}
          </div>
          {draft.start.kind === 'event' && !standard ? (
            <>
              <FilterList databaseId={databaseId} event={draft.start.event || '*'} filters={draft.start.filters} label="the start" onChange={(filters) => update({ start: { ...(draft.start as { kind: 'event'; event: string }), filters } })} />
              <p className="text-xs text-muted-foreground">
                Without filters, the start is the first time a unit ever did it. With filters, it is the first matching occurrence among the events kept, and the table says so.
              </p>
            </>
          ) : null}
        </section>

        <section className="space-y-2 rounded-md border p-3" aria-label="Cohort return">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">Return</span>
            <select
              className={SELECT}
              aria-label="Return"
              value={draft.return.kind}
              disabled={standard}
              onChange={(event) => update({ return: event.target.value === 'event' ? { kind: 'event', event: '', filters: [] } : { kind: 'anyEvent' } })}
            >
              <option value="anyEvent">Any event</option>
              <option value="event">A named event</option>
            </select>
            {draft.return.kind === 'event' ? eventPicker('Return event', draft.return.event, (event) => update({ return: { ...(draft.return as { kind: 'event'; filters: AnalyticsFilter[] }), event } })) : null}
          </div>
          {draft.return.kind === 'event' && !standard ? (
            <FilterList databaseId={databaseId} event={draft.return.event || '*'} filters={draft.return.filters} label="the return" onChange={(filters) => update({ return: { ...(draft.return as { kind: 'event'; event: string }), filters } })} />
          ) : null}
        </section>

        <section className="flex flex-wrap items-end gap-4" aria-label="Granularity, unit and range">
          <label className="space-y-1 text-[13px]">
            <span className="block font-medium">By</span>
            <select className={SELECT} aria-label="Granularity" value={draft.granularity} onChange={(event) => update({ granularity: event.target.value as AnalyticsGranularity })}>
              {(['day', 'week', 'month', 'year'] as const).map((granularity) => (
                <option key={granularity} value={granularity}>
                  {GRANULARITY_LABEL[granularity]}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-[13px]">
            <span className="block font-medium">Count</span>
            <select className={SELECT} aria-label="Counting unit" value={draft.unit} disabled={standard || draft.start.kind === 'install'} onChange={(event) => update({ unit: event.target.value as 'installation' | 'user' })}>
              <option value="installation">Installations</option>
              <option value="user">User IDs</option>
            </select>
          </label>
          <label className="space-y-1 text-[13px]">
            <span className="block font-medium">Start periods</span>
            <select
              className={SELECT}
              aria-label="Range"
              value={rangeValue}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'default') setRange(null);
                else if (value === 'custom') setRange({ from: today(), to: today() });
                else setRange({ preset: value as (typeof ANALYTICS_RANGE_PRESETS)[number] });
              }}
            >
              <option value="default">The last 12 {draft.granularity}s</option>
              {ANALYTICS_RANGE_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {LABELS.preset[preset]}
                </option>
              ))}
              <option value="custom">Dates</option>
            </select>
          </label>
          {range && 'from' in range ? (
            <>
              <label className="space-y-1 text-[13px]">
                <span className="block font-medium">From</span>
                <Input type="date" className="h-9" aria-label="From" value={range.from} onChange={(event) => event.target.value && setRange({ ...range, from: event.target.value })} />
              </label>
              <label className="space-y-1 text-[13px]">
                <span className="block font-medium">To</span>
                <Input type="date" className="h-9" aria-label="To" value={range.to} onChange={(event) => event.target.value && setRange({ ...range, to: event.target.value })} />
              </label>
            </>
          ) : null}
        </section>

        <section className="space-y-2 rounded-md border p-3" aria-label="Population filters">
          <p className="text-[13px] font-medium">Who is in the cohort</p>
          <FilterList
            databaseId={databaseId}
            event="*"
            filters={draft.filters}
            label="the population"
            fields={draft.unit === 'user' ? ANALYTICS_POPULATION_FILTER_FIELDS.filter((field) => field !== 'installAttribution') : ANALYTICS_POPULATION_FILTER_FIELDS}
            onChange={(filters) => update({ filters })}
          />
          <p className="text-xs text-muted-foreground">These test each unit at its start (its install, or its first occurrence), never its returns. Without an environment filter, only production counts.</p>
        </section>

        <p className="text-xs text-muted-foreground" data-testid="cohort-web-note">
          {WEB_NOTE}
        </p>

        {run ? <CohortResults databaseId={databaseId} run={run} unreachable={unreachable} /> : <p className="text-sm text-muted-foreground">Choose an event for the start and the return to run the cohort.</p>}
      </CardContent>
      {saved && !standard ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete “${saved.name}”?`}
          description="Only the saved cohort goes; no event is touched."
          onConfirm={() => remove.mutate()}
          pending={remove.isPending}
        />
      ) : null}
    </Card>
  );
}

function CohortResults({ databaseId, run, unreachable }: { databaseId: string; run: AnalyticsCohortRun; unreachable: string }) {
  const answer = useQuery({
    queryKey: ['analytics-cohort-run', databaseId, run],
    queryFn: ({ signal }) => cohortsApi.run(databaseId, run, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (answer.error) {
    return (
      <p role="status" className="rounded-md border border-destructive/40 px-3 py-2 text-sm" data-testid="cohort-error">
        {queryErrorSentence(answer.error, unreachable)}
      </p>
    );
  }
  if (!answer.data) return <Skeleton className="h-60" />;
  return (
    <div className="space-y-3" aria-busy={answer.isFetching}>
      <Notices answer={answer.data} />
      {answer.data.rows.length === 0 ? <EmptyState title="No member in this range" description="No unit started in these periods, or the start names an event nobody sent." /> : <CohortTable answer={answer.data} />}
    </div>
  );
}

function Notices({ answer }: { answer: CohortAnswer }) {
  return (
    <div className="space-y-1 text-[13px] text-muted-foreground">
      <p data-testid="cohort-covered">
        Start periods {answer.range.from} to {answer.range.to}, {answer.timezone}. {answer.keptFrom ? `Events are kept from ${answer.keptFrom}.` : 'No event is stored yet.'}
      </p>
      {answer.truncated ? <p className="text-foreground" data-testid="cohort-truncated">The range holds more {answer.granularity}s than the table shows; the oldest are left out.</p> : null}
      {answer.firstInWindow ? (
        <p className="text-foreground" data-testid="cohort-first-in-window">
          The start has filters, so each unit’s start is its first matching occurrence among the events kept: membership may change as older events are removed.
        </p>
      ) : null}
      {answer.warnings.map((warning) => (
        <p key={warning.in} className="text-foreground" data-testid="cohort-warning">
          The {warning.in} names {warning.event}, which was deleted: it has no units.
        </p>
      ))}
    </div>
  );
}

/** A cell's background: the accent at an intensity proportional to its share (never the only mark). */
const shade = (share: number | null) => (share === null ? undefined : { backgroundColor: `color-mix(in oklch, var(--primary) ${Math.round(8 + share * 72)}%, transparent)` });

function CohortTable({ answer }: { answer: CohortAnswer }) {
  const unit = answer.unit === 'user' ? 'user IDs' : 'installations';
  const period = GRANULARITY_LABEL[answer.granularity];
  const columns = Array.from({ length: Math.max(0, answer.periods - 1) }, (_, i) => i + 1);
  const hasIncomplete = answer.rows.some((row) => row.cells.some((cell) => cell.incomplete));
  const hasUncovered = answer.rows.some((row) => row.cells.some((cell) => !cell.covered));
  const cellText = (returned: number, share: number | null, members: number, incomplete: boolean, covered: boolean) =>
    `${percent(share)}: ${returned.toLocaleString()} of ${members.toLocaleString()} ${unit} returned${incomplete ? ', incomplete: the period has not ended' : ''}${covered ? '' : ', not fully covered: it begins before the oldest event kept'}`;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="cohort-table">
          <caption className="sr-only">
            Cohort table: each row is a {period.toLowerCase()} of starts, its size, and the share of its {unit} that returned in each later {period.toLowerCase()}.
          </caption>
          <thead className="bg-muted/40 text-left text-[13px]">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Cohort
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Size
              </th>
              {columns.map((n) => (
                <th key={n} scope="col" className="px-3 py-2 text-right font-medium">
                  {period} {n}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t font-medium" data-testid="cohort-summary">
              <th scope="row" className="px-3 py-1.5 text-left">
                Summary
              </th>
              <td className="numeric px-3 py-1.5 text-right">{answer.size.toLocaleString()}</td>
              {columns.map((n) => {
                const cell = answer.summary[n - 1];
                if (!cell || cell.members === 0) return <td key={n} className="px-3 py-1.5" />;
                return (
                  <td key={n} tabIndex={0} className="group numeric px-3 py-1.5 text-right" style={shade(cell.share)} title={cellText(cell.returned, cell.share, cell.members, cell.incomplete, true)}>
                    <span aria-hidden="true">
                      {percent(cell.share)}
                      {cell.incomplete ? '*' : ''}
                      <span className="hidden text-xs group-hover:inline group-focus:inline"> ({cell.returned.toLocaleString()})</span>
                    </span>
                    <span className="sr-only">{cellText(cell.returned, cell.share, cell.members, cell.incomplete, true)}</span>
                  </td>
                );
              })}
            </tr>
            {answer.rows.map((row) => (
              <tr key={row.start} className="border-t" data-testid="cohort-row">
                <th scope="row" className="px-3 py-1.5 text-left font-normal">
                  {row.label}
                  {answer.granularity === 'week' ? <span className="text-xs text-muted-foreground"> · from {row.start}</span> : null}
                </th>
                <td className="numeric px-3 py-1.5 text-right">{row.size.toLocaleString()}</td>
                {columns.map((n) => {
                  const cell = row.cells[n - 1];
                  // AN-105: a period not yet begun is left empty.
                  if (!cell) return <td key={n} className="px-3 py-1.5" />;
                  return (
                    <td
                      key={n}
                      tabIndex={0}
                      className="group numeric px-3 py-1.5 text-right"
                      style={shade(cell.share)}
                      title={cellText(cell.returned, cell.share, row.size, cell.incomplete, cell.covered)}
                      data-testid="cohort-cell"
                    >
                      <span aria-hidden="true">
                        {percent(cell.share)}
                        {cell.incomplete ? '*' : ''}
                        {cell.covered ? '' : '†'}
                        <span className="hidden text-xs group-hover:inline group-focus:inline"> ({cell.returned.toLocaleString()})</span>
                      </span>
                      <span className="sr-only">{cellText(cell.returned, cell.share, row.size, cell.incomplete, cell.covered)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-0.5 text-xs text-muted-foreground" data-testid="cohort-legend">
        <p>Period 0 is each cohort’s size (100%). Hover or focus a cell for the number that returned; a stronger colour is a larger share.</p>
        <p>The summary divides the {unit} that returned in each period by the members of the cohorts whose period has ended and is fully covered, so young cohorts do not pull it down.</p>
        {hasIncomplete || answer.summary.some((cell) => cell.incomplete) ? <p>* Incomplete: the period has not ended, so more may still return.</p> : null}
        {hasUncovered ? <p>† Not fully covered: the period begins before the oldest event kept, so returns before it are no longer known.</p> : null}
      </div>
    </div>
  );
}
