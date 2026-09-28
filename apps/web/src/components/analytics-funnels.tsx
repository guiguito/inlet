import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, DownloadIcon, Loader2Icon, PlusIcon, SaveIcon, TrashIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  ANALYTICS_RANGE_PRESETS,
  analyticsFunnelDefinitionSchema,
  type AnalyticsFilter,
  type AnalyticsFunnelDefinition,
  type AnalyticsFunnelRun,
  type AnalyticsRange,
} from '@inlet/shared';
import { api, ApiError } from '@/lib/api';
import { profileHref } from '@/lib/analytics-profiles';
import { funnelsApi, type FunnelAnswer, type FunnelGroup, type FunnelResult, type FunnelStepsAnswer, type FunnelTrendAnswer, type FunnelUnit, type SavedFunnel } from '@/lib/analytics-funnels';
import { FilterList, LABELS, SELECT, SplitControl, complete, queryErrorSentence, useDatabaseToday } from '@/components/analytics-events';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { TrendChart, type ChartAnswer } from '@/components/trend-chart';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';

/**
 * Insights → Funnels (UX Analytics PRD 8.1, 5.4; AN-080 to AN-089): the saved funnels, and a funnel
 * opened in the editor with its steps view (one bar per step, both conversions, the median time
 * beside each gap, "See who dropped" per step) or its trend view (conversion per entry day, week or
 * month, incomplete groups dashed and listed as such). The open funnel is the address's `funnel`
 * parameter (a saved ID, or `new`). The editor always runs its current definition inline, which the
 * API computes as it computes the saved one (AN-082), so a Viewer can try a variation and not save
 * it. Every user-authored string (names, labels, event names, values) is rendered as text.
 */

type Role = 'admin' | 'creator' | 'viewer';

const DEFAULT_DEFINITION: AnalyticsFunnelDefinition = {
  steps: [
    { event: '', filters: [] },
    { event: '', filters: [] },
  ],
  mode: 'closed',
  window: { value: 7, unit: 'day' },
  unit: 'installation',
  filters: [],
  defaultRange: { preset: 'last30Days' },
  defaultView: { kind: 'steps' },
};

/** AN-089: what the editor says about a user-ID funnel. */
export const USER_UNIT_NOTE = 'A user-ID funnel ignores events without a user ID, so a step such as app_installed, usually sent before sign-in, is often empty.';
/** AN-086, PRD 8.1: the trend view's note. */
const TREND_NOTE = (interval: 'day' | 'week' | 'month', unit: 'installation' | 'user') =>
  `Each ${interval} counts the ${unit === 'user' ? 'user IDs' : 'installations'} that entered that ${interval}, so the ${interval}s need not add up to the whole range.`;

const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);

/** Seconds as the steps view words them: "5 min", "24 h", "2 d 14 h". */
export function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h === 0 ? `${days} d` : `${days} d ${h} h`;
}

const windowText = (window: AnalyticsFunnelDefinition['window']) => `${window.value} ${window.unit}${window.value === 1 ? '' : 's'}`;

export function FunnelsPanel({ databaseId, role, unreachable }: { databaseId: string; role: Role | undefined; unreachable: string }) {
  const [params, setParams] = useSearchParams();
  const open = params.get('funnel');
  const go = (funnel: string | null) => setParams({ tab: 'insights', panel: 'funnels', ...(funnel ? { funnel } : {}) });
  const canSave = role === 'creator' || role === 'admin';
  if (open === 'new') return <FunnelEditor key="new" databaseId={databaseId} saved={null} canSave={canSave} unreachable={unreachable} onBack={() => go(null)} onSaved={(id) => go(id)} />;
  if (open) return <SavedFunnelEditor key={open} databaseId={databaseId} funnelId={open} canSave={canSave} unreachable={unreachable} onBack={() => go(null)} />;
  return <FunnelList databaseId={databaseId} canSave={canSave} onOpen={go} />;
}

function FunnelList({ databaseId, canSave, onOpen }: { databaseId: string; canSave: boolean; onOpen: (funnel: string) => void }) {
  const funnels = useQuery({ queryKey: ['analytics-funnels', databaseId], queryFn: () => funnelsApi.list(databaseId) });
  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Funnels</CardTitle>
          <CardDescription>Where people stop in a sequence of steps, and whether it improves over time.</CardDescription>
        </div>
        {canSave ? (
          <Button size="sm" onClick={() => onOpen('new')}>
            <PlusIcon />
            Create a funnel
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {funnels.isLoading ? (
          <Skeleton className="h-24" />
        ) : funnels.error ? (
          <p role="status" className="text-sm">
            {funnels.error instanceof ApiError ? funnels.error.message : 'The funnels could not be loaded.'}
          </p>
        ) : (funnels.data?.funnels.length ?? 0) === 0 ? (
          <EmptyState title="No funnel yet" description={canSave ? 'Create one: pick the steps people take, in order.' : 'A Creator or Admin can create one; you can open and run them.'} />
        ) : (
          <Table data-testid="funnel-list">
            <caption className="sr-only">Saved funnels</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Window</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {funnels.data!.funnels.map((funnel) => (
                <TableRow key={funnel.id}>
                  <TableCell>
                    <button type="button" className="font-medium underline underline-offset-4" onClick={() => onOpen(funnel.id)}>
                      {funnel.name}
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{funnel.definition.steps.map((step) => step.label ?? step.event).join(' → ')}</TableCell>
                  <TableCell>{funnel.definition.mode === 'open' ? 'Open' : 'Closed'}</TableCell>
                  <TableCell>{windowText(funnel.definition.window)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SavedFunnelEditor(props: { databaseId: string; funnelId: string; canSave: boolean; unreachable: string; onBack: () => void }) {
  const saved = useQuery({ queryKey: ['analytics-funnel', props.databaseId, props.funnelId], queryFn: () => funnelsApi.get(props.databaseId, props.funnelId) });
  if (saved.isLoading) return <Skeleton className="mt-4 h-64" />;
  if (saved.error || !saved.data) {
    return (
      <EmptyState
        className="mt-4"
        title="This funnel could not be loaded"
        description={saved.error instanceof ApiError ? saved.error.message : 'Try reloading the page.'}
        action={
          <Button variant="outline" onClick={props.onBack}>
            All funnels
          </Button>
        }
      />
    );
  }
  return <FunnelEditor {...props} saved={saved.data} onSaved={() => undefined} />;
}

/** The definition sent: complete filters only, and steps that name an event (AN-081 needs two). */
function runnable(definition: AnalyticsFunnelDefinition): AnalyticsFunnelDefinition | null {
  const parsed = analyticsFunnelDefinitionSchema.safeParse({
    ...definition,
    filters: complete(definition.filters),
    steps: definition.steps.map((step) => ({ ...step, filters: complete(step.filters) })),
  });
  return parsed.success ? parsed.data : null;
}

function FunnelEditor({
  databaseId,
  saved,
  canSave,
  unreachable,
  onBack,
  onSaved,
}: {
  databaseId: string;
  saved: SavedFunnel | null;
  canSave: boolean;
  unreachable: string;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(saved?.name ?? '');
  const [draft, setDraft] = useState<AnalyticsFunnelDefinition>(saved?.definition ?? DEFAULT_DEFINITION);
  const [range, setRange] = useState<AnalyticsRange>(saved?.definition.defaultRange ?? { preset: 'last30Days' });
  const today = useDatabaseToday(databaseId);
  const [view, setView] = useState<AnalyticsFunnelRun['view']>(saved?.definition.defaultView ?? { kind: 'steps' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dropped, setDropped] = useState<number | null>(null);
  const catalog = useQuery({ queryKey: ['analytics-events', databaseId, 'picker'], queryFn: () => api.listAnalyticsEvents(databaseId) });
  const names = (catalog.data?.events ?? []).map((entry) => entry.name);
  const definition = useMemo(() => runnable(draft), [draft]);
  const run = useMemo<AnalyticsFunnelRun | null>(() => (definition ? { definition, range, ...(view ? { view } : {}) } : null), [definition, range, view]);
  const update = (patch: Partial<AnalyticsFunnelDefinition>) => setDraft((current) => ({ ...current, ...patch }));
  const setStep = (index: number, patch: Partial<AnalyticsFunnelDefinition['steps'][number]>) =>
    update({ steps: draft.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)) });

  const save = useMutation({
    mutationFn: async () => {
      const body = { ...definition!, defaultRange: range, defaultView: view ?? { kind: 'steps' as const } };
      return saved ? funnelsApi.update(databaseId, saved.id, { name: name.trim(), definition: body }) : funnelsApi.create(databaseId, name.trim(), body);
    },
    onSuccess: async (funnel) => {
      toast.success(saved ? 'Funnel saved.' : 'Funnel created.');
      await queryClient.invalidateQueries({ queryKey: ['analytics-funnels', databaseId] });
      queryClient.setQueryData(['analytics-funnel', databaseId, funnel.id], funnel);
      if (!saved) onSaved(funnel.id);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The funnel could not be saved.'),
  });
  const remove = useMutation({
    mutationFn: () => funnelsApi.remove(databaseId, saved!.id),
    onSuccess: async () => {
      toast.success('Funnel deleted.');
      await queryClient.invalidateQueries({ queryKey: ['analytics-funnels', databaseId] });
      onBack();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The funnel could not be deleted.'),
  });
  const exportAs = async (format: 'csv' | 'json') => {
    try {
      await funnelsApi.download(databaseId, run!, format);
    } catch (error) {
      toast.error(queryErrorSentence(error, unreachable));
    }
  };
  const custom = 'from' in range;

  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
            <ArrowLeftIcon />
            All funnels
          </Button>
          <CardTitle>{saved ? saved.name : 'New funnel'}</CardTitle>
          <CardDescription>{canSave ? 'Change the steps and run it; save when it reads right.' : 'You can change and run this funnel; a Creator or Admin saves it.'}</CardDescription>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {canSave ? (
            <>
              <Input className="h-9 w-56" aria-label="Funnel name" placeholder="Name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
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
        <section className="space-y-3" aria-label="Steps">
          {draft.steps.map((step, index) => (
            <div key={index} className="space-y-2 rounded-md border p-3" data-testid="funnel-step-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">Step {index + 1}</span>
                <select className={SELECT} aria-label={`Event of step ${index + 1}`} value={step.event} onChange={(event) => setStep(index, { event: event.target.value })}>
                  <option value="">Choose an event</option>
                  {[...new Set([...names, ...(step.event ? [step.event] : [])])].map((event) => (
                    <option key={event} value={event}>
                      {event}
                    </option>
                  ))}
                </select>
                <Input
                  className="h-9 w-40"
                  placeholder="Label (optional)"
                  aria-label={`Label of step ${index + 1}`}
                  maxLength={80}
                  value={step.label ?? ''}
                  onChange={(event) => setStep(index, { label: event.target.value || undefined })}
                />
                {draft.steps.length > 2 ? (
                  <Button variant="ghost" size="sm" aria-label={`Remove step ${index + 1}`} onClick={() => update({ steps: draft.steps.filter((_, i) => i !== index) })}>
                    <XIcon />
                  </Button>
                ) : null}
              </div>
              <FilterList databaseId={databaseId} event={step.event || '*'} filters={step.filters} label={`step ${index + 1}`} onChange={(filters: AnalyticsFilter[]) => setStep(index, { filters })} />
            </div>
          ))}
          {draft.steps.length < 10 ? (
            <Button variant="outline" size="sm" onClick={() => update({ steps: [...draft.steps, { event: '', filters: [] }] })}>
              <PlusIcon />
              Add a step
            </Button>
          ) : null}
        </section>

        <section className="flex flex-wrap items-end gap-4" aria-label="Mode, window and unit">
          <label className="space-y-1 text-[13px]">
            <span className="block font-medium">Mode</span>
            <select className={SELECT} aria-label="Mode" value={draft.mode} onChange={(event) => update({ mode: event.target.value as 'closed' | 'open' })}>
              <option value="closed">Closed: enter at step 1</option>
              <option value="open">Open: enter at any step</option>
            </select>
          </label>
          <label className="space-y-1 text-[13px]">
            <span className="block font-medium">Window</span>
            <span className="flex gap-2">
              <Input
                type="number"
                min={1}
                className="h-9 w-20"
                aria-label="Window length"
                value={draft.window.value}
                onChange={(event) => update({ window: { ...draft.window, value: Math.max(1, Math.floor(Number(event.target.value) || 1)) } })}
              />
              <select className={SELECT} aria-label="Window unit" value={draft.window.unit} onChange={(event) => update({ window: { ...draft.window, unit: event.target.value as 'minute' | 'hour' | 'day' } })}>
                <option value="minute">Minutes</option>
                <option value="hour">Hours</option>
                <option value="day">Days</option>
              </select>
            </span>
          </label>
          <label className="space-y-1 text-[13px]">
            <span className="block font-medium">Count</span>
            <select className={SELECT} aria-label="Counting unit" value={draft.unit} onChange={(event) => update({ unit: event.target.value as 'installation' | 'user' })}>
              <option value="installation">Installations</option>
              <option value="user">User IDs</option>
            </select>
          </label>
          <SplitControl split={draft.split} disabled={false} onChange={(split) => (split ? update({ split }) : setDraft(({ split: _, ...rest }) => rest))} />
        </section>
        {draft.unit === 'user' ? (
          <p className="text-xs text-muted-foreground" data-testid="user-unit-note">
            {USER_UNIT_NOTE}
          </p>
        ) : null}
        <section className="space-y-2 rounded-md border p-3" aria-label="Filters on every step">
          <p className="text-[13px] font-medium">Filters on every step</p>
          <FilterList databaseId={databaseId} event={draft.steps[0]?.event || '*'} filters={draft.filters} label="every step" onChange={(filters) => update({ filters })} />
        </section>

        <section className="flex flex-wrap items-end gap-4" aria-label="Range and view">
          <label className="space-y-1 text-[13px]">
            <span className="block font-medium">Range</span>
            <select
              className={SELECT}
              aria-label="Range"
              value={custom ? 'custom' : range.preset}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'custom') setRange({ from: today(), to: today() });
                else setRange({ preset: value as (typeof ANALYTICS_RANGE_PRESETS)[number] });
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
                <Input type="date" className="h-9" aria-label="From" value={range.from} onChange={(event) => event.target.value && setRange({ ...range, from: event.target.value })} />
              </label>
              <label className="space-y-1 text-[13px]">
                <span className="block font-medium">To</span>
                <Input type="date" className="h-9" aria-label="To" value={range.to} onChange={(event) => event.target.value && setRange({ ...range, to: event.target.value })} />
              </label>
            </>
          ) : null}
          <label className="space-y-1 text-[13px]">
            <span className="block font-medium">View</span>
            <select
              className={SELECT}
              aria-label="View"
              value={view?.kind === 'trend' ? view.interval : 'steps'}
              onChange={(event) => setView(event.target.value === 'steps' ? { kind: 'steps' } : { kind: 'trend', interval: event.target.value as 'day' | 'week' | 'month' })}
            >
              <option value="steps">Steps</option>
              <option value="day">Trend by day</option>
              <option value="week">Trend by week</option>
              <option value="month">Trend by month</option>
            </select>
          </label>
        </section>

        {run ? <FunnelResults databaseId={databaseId} run={run} unreachable={unreachable} onDropped={setDropped} /> : <p className="text-sm text-muted-foreground">Choose an event for every step to run the funnel.</p>}
        {run && dropped !== null ? <DroppedUnits databaseId={databaseId} run={run} step={dropped} onClose={() => setDropped(null)} unreachable={unreachable} /> : null}
      </CardContent>
      {saved ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete “${saved.name}”?`}
          description="Only the saved funnel goes; no event is touched."
          onConfirm={() => remove.mutate()}
          pending={remove.isPending}
        />
      ) : null}
    </Card>
  );
}

/** AN-089: a long trend shows its progress; the API gives none, so the elapsed time. */
function Elapsed() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="funnel-running">
      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      Running the funnel… {seconds > 0 ? `${seconds} s` : ''}
    </p>
  );
}

function FunnelResults({ databaseId, run, unreachable, onDropped }: { databaseId: string; run: AnalyticsFunnelRun; unreachable: string; onDropped: (step: number) => void }) {
  const answer = useQuery({
    queryKey: ['analytics-funnel-run', databaseId, run],
    queryFn: ({ signal }) => funnelsApi.run(databaseId, run, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (answer.error) {
    return (
      <p role="status" className="rounded-md border border-destructive/40 px-3 py-2 text-sm" data-testid="funnel-error">
        {queryErrorSentence(answer.error, unreachable)}
      </p>
    );
  }
  if (!answer.data) return answer.isFetching ? <Elapsed /> : <Skeleton className="h-60" />;
  return (
    <div className="space-y-4">
      {answer.isFetching ? <Elapsed /> : null}
      <Notices answer={answer.data} />
      {answer.data.view === 'steps' ? <StepsView answer={answer.data} onDropped={onDropped} /> : <TrendView answer={answer.data} />}
    </div>
  );
}

function Notices({ answer }: { answer: FunnelAnswer }) {
  return (
    <div className="space-y-1 text-[13px] text-muted-foreground">
      <p data-testid="funnel-covered">{answer.covered ? `Covers ${answer.covered.from} to ${answer.covered.to}, ${answer.timezone}.` : 'This range is entirely before the oldest event kept, so it has no data.'}</p>
      {answer.covered && answer.covered.from > answer.range.from ? <p>Events are kept from {answer.covered.from}; earlier days have no data.</p> : null}
      {answer.warnings.map((warning) => (
        <p key={warning.step} className="text-foreground" data-testid="funnel-warning">
          Step {warning.step} names {warning.event}, which was deleted: it has no units.
        </p>
      ))}
      {answer.split?.descriptive ? (
        <p className="text-foreground" data-testid="split-descriptive">
          {answer.split.note}
        </p>
      ) : null}
    </div>
  );
}

function StepBars({ result, onDropped }: { result: FunnelResult; onDropped?: (step: number) => void }) {
  return (
    <ol className="space-y-2" aria-hidden="true" data-testid="funnel-bars">
      {result.steps.map((step) => (
        <li key={step.index} className="space-y-1">
          {step.index > 1 ? <p className="pl-2 text-xs text-muted-foreground">↓ median {duration(step.medianSeconds)}</p> : null}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="w-44 truncate font-mono text-xs">{step.label ?? step.event}</span>
            <span className="relative h-6 min-w-40 flex-1 rounded bg-muted">
              <span className="absolute inset-y-0 left-0 rounded bg-primary/70" style={{ width: `${Math.max(0.5, (step.shareOfEntered ?? 0) * 100)}%` }} />
            </span>
            <span className="numeric w-72 text-xs">
              {step.reached.toLocaleString()} · {percent(step.shareOfEntered)} of entries{step.index > 1 ? ` · ${percent(step.shareOfPrevious)} of previous` : ''}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function StepsTable({ result, open, caption, onDropped }: { result: FunnelResult; open: boolean; caption: string; onDropped?: (step: number) => void }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm" data-testid="funnel-steps-table">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted/40 text-left text-[13px]">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Step
            </th>
            {open ? (
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Entered here
              </th>
            ) : null}
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Reached
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Of entries
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Of previous
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Median time
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Mean time
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Dropped
            </th>
          </tr>
        </thead>
        <tbody>
          {result.steps.map((step) => (
            <tr key={step.index} className="border-t">
              <th scope="row" className="px-3 py-1.5 text-left font-normal">
                {step.index}. <span className="font-mono text-xs">{step.label ?? step.event}</span>
              </th>
              {open ? <td className="numeric px-3 py-1.5 text-right">{step.entered?.toLocaleString() ?? '—'}</td> : null}
              <td className="numeric px-3 py-1.5 text-right">{step.reached.toLocaleString()}</td>
              <td className="numeric px-3 py-1.5 text-right">{percent(step.shareOfEntered)}</td>
              <td className="numeric px-3 py-1.5 text-right">{step.index === 1 ? '—' : percent(step.shareOfPrevious)}</td>
              <td className="numeric px-3 py-1.5 text-right">{duration(step.medianSeconds)}</td>
              <td className="numeric px-3 py-1.5 text-right">{duration(step.meanSeconds)}</td>
              <td className="numeric px-3 py-1.5 text-right">
                {step.dropped === null ? (
                  '—'
                ) : onDropped && step.dropped > 0 ? (
                  <button type="button" className="underline underline-offset-4" onClick={() => onDropped(step.index)}>
                    See who dropped ({step.dropped.toLocaleString()})
                  </button>
                ) : (
                  step.dropped.toLocaleString()
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StepsView({ answer, onDropped }: { answer: FunnelStepsAnswer; onDropped: (step: number) => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm" data-testid="funnel-summary">
        <strong className="numeric">{answer.entered.toLocaleString()}</strong> {answer.unit === 'user' ? 'user IDs' : 'installations'} entered; overall conversion{' '}
        <strong className="numeric">{percent(answer.conversion)}</strong>, median time to convert {duration(answer.medianSeconds)}.
      </p>
      <StepBars result={answer} />
      <StepsTable result={answer} open={answer.mode === 'open'} caption="Each step’s units, conversions and times" onDropped={onDropped} />
      {answer.splits ? (
        <section className="space-y-2" aria-label="Split">
          <h3 className="text-sm font-medium">
            By {answer.split?.field}
            {answer.split?.key ? ` ${answer.split.key}` : ''}
            {answer.split?.descriptive ? <Badge variant="outline" className="ml-2">Descriptive</Badge> : null}
          </h3>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="funnel-split-table">
              <caption className="sr-only">Conversion per split value</caption>
              <thead className="bg-muted/40 text-left text-[13px]">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Value
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Entered
                  </th>
                  {answer.steps.slice(1).map((step) => (
                    <th key={step.index} scope="col" className="px-3 py-2 text-right font-medium">
                      Reached step {step.index}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Conversion
                  </th>
                </tr>
              </thead>
              <tbody>
                {answer.splits.map((split) => (
                  <tr key={`${split.group}-${split.label}`} className="border-t">
                    <th scope="row" className="px-3 py-1.5 text-left font-normal">
                      {split.label}
                    </th>
                    <td className="numeric px-3 py-1.5 text-right">{split.entered.toLocaleString()}</td>
                    {split.steps.slice(1).map((step) => (
                      <td key={step.index} className="numeric px-3 py-1.5 text-right">
                        {step.reached.toLocaleString()} ({percent(step.shareOfEntered)})
                      </td>
                    ))}
                    <td className="numeric px-3 py-1.5 text-right">{percent(split.conversion)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The trend view as the trend chart draws it: conversion in percent per entry group (AN-086). A
 * group nobody entered has no conversion (null), drawn as a gap rather than a 0% that did not happen.
 */
function trendShape(answer: FunnelTrendAnswer, show: 'overall' | number): ChartAnswer {
  const value = (group: FunnelGroup, step: number | 'overall') => {
    const share = step === 'overall' ? group.conversion : group.stepShares[step - 1];
    return share === null || share === undefined ? null : Math.round(share * 1000) / 10;
  };
  const series = (label: string, groups: FunnelGroup[], step: number | 'overall', group?: 'value' | 'other' | 'none') => ({
    label,
    event: label,
    metric: 'installations' as const,
    ...(group ? { group } : {}),
    covered: answer.covered,
    notice: answer.notice,
    points: groups.map((g) => ({ start: g.start, label: g.label, value: value(g, step), incomplete: g.incomplete })),
  });
  const stepName = (index: number) => {
    const step = answer.steps[index - 1]!;
    return `Step ${index}: ${step.label ?? step.event}`;
  };
  let lines;
  if (answer.splits) lines = answer.splits.map((split) => series(split.label, split.groups, show, split.group));
  else if (show === 'overall') lines = [series('Overall conversion (%)', answer.groups, 'overall')];
  else lines = [series(`${stepName(show)} (% of entries)`, answer.groups, show)];
  return { range: answer.range, interval: answer.interval, timezone: answer.timezone, keptFrom: answer.keptFrom, series: lines };
}

function TrendView({ answer }: { answer: FunnelTrendAnswer }) {
  const [show, setShow] = useState<'overall' | 'all' | number>('overall');
  const charts =
    show === 'all' && !answer.splits
      ? [
          {
            ...trendShape(answer, 'overall'),
            series: answer.steps.map((step) => ({ ...trendShape(answer, step.index).series[0]!, label: `Step ${step.index}: ${step.label ?? step.event} (% of entries)` })),
          },
        ]
      : [trendShape(answer, show === 'all' ? 'overall' : show)];
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-[13px]">
        <span className="font-medium">Show</span>
        <select className={SELECT} aria-label="Show" value={String(show)} onChange={(event) => setShow(event.target.value === 'overall' || event.target.value === 'all' ? event.target.value : Number(event.target.value))}>
          <option value="overall">Overall conversion</option>
          {answer.splits ? null : <option value="all">All steps</option>}
          {answer.steps.map((step) => (
            <option key={step.index} value={step.index}>
              Step {step.index}: {step.label ?? step.event}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[13px] text-muted-foreground" data-testid="funnel-trend-note">
        {TREND_NOTE(answer.interval, answer.unit)} A group is incomplete while its entries’ window is still open.
      </p>
      {charts.map((chart, index) => (
        <TrendChart key={index} answer={chart} />
      ))}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="funnel-groups-table">
          <caption className="sr-only">Entries and conversion per group</caption>
          <thead className="bg-muted/40 text-left text-[13px]">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Entered in
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Entered
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Conversion
              </th>
            </tr>
          </thead>
          <tbody>
            {answer.groups.map((group) => (
              <tr key={group.start} className="border-t">
                <th scope="row" className="px-3 py-1.5 text-left font-normal">
                  {group.label}
                  {group.incomplete ? <span className="text-muted-foreground"> (incomplete)</span> : null}
                </th>
                <td className="numeric px-3 py-1.5 text-right">{group.entered.toLocaleString()}</td>
                <td className="numeric px-3 py-1.5 text-right">{percent(group.conversion)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** AN-088: the units that reached a step and not the next, each linked to its profile. */
function DroppedUnits({ databaseId, run, step, onClose, unreachable }: { databaseId: string; run: AnalyticsFunnelRun; step: number; onClose: () => void; unreachable: string }) {
  const [pages, setPages] = useState<{ units: FunnelUnit[]; nextCursor: string | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const { view: _view, ...body } = run;
  const load = async (cursor?: string) => {
    setLoading(true);
    try {
      const page = await funnelsApi.units(databaseId, { ...body, step, kind: 'dropped', ...(cursor ? { cursor } : {}) });
      setPages((current) => ({ units: [...(cursor ? (current?.units ?? []) : []), ...page.units], nextCursor: page.nextCursor }));
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // A new step or run starts a new list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, JSON.stringify(body)]);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Dropped after step {step}</DialogTitle>
          <DialogDescription>The units that reached step {step} and not step {step + 1}, by ID. Each opens its profile.</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="status" className="text-sm">
            {queryErrorSentence(error, unreachable)}
          </p>
        ) : !pages ? (
          <Skeleton className="h-32" />
        ) : pages.units.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody dropped at this step.</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <Table data-testid="dropped-units">
              <caption className="sr-only">Units that dropped after step {step}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Installation</TableHead>
                  <TableHead>User ID</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>App version</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Also has</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pages.units.map((unit) => (
                  <TableRow key={unit.unit}>
                    <TableCell>
                      <Link className="font-mono text-xs underline underline-offset-4" to={profileHref(databaseId, { kind: 'installation', id: unit.installationId })}>
                        {unit.installationId}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {unit.userId ? (
                        <Link className="underline underline-offset-4" to={profileHref(databaseId, { kind: 'user', id: unit.userId })}>
                          {unit.userId}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>{unit.platform ?? '—'}</TableCell>
                    <TableCell>{unit.appVersion ?? '—'}</TableCell>
                    <TableCell className="numeric">{unit.lastSeen ? formatDateTime(unit.lastSeen) : '—'}</TableCell>
                    <TableCell className="space-x-1">
                      {unit.crashReports ? <Badge variant="outline">Crash reports</Badge> : null}
                      {unit.feedback ? <Badge variant="outline">Feedback</Badge> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {pages.nextCursor ? (
              <Button variant="outline" size="sm" className="mt-3" disabled={loading} onClick={() => void load(pages.nextCursor!)}>
                Load more
              </Button>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
