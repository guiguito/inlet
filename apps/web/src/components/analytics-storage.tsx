import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { INCIDENT_LABELS, storageApi, type AnalyticsDataHealth, type AnalyticsStorage, type StorageSettings } from '@/lib/analytics-storage';
import { formatDateTime } from '@/lib/format';
import { queryErrorSentence } from '@/components/analytics-events';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * Settings → Storage (UX Analytics PRD 8.1, AN-160 to AN-169): the settings with their bounds,
 * the usage and the recommendations, the statement of what a lowered limit removes with the
 * database's name to type, and data health with its refusals and incidents. Storage is an
 * Admin's; data health any member's, so a Viewer sees data health alone.
 */

const count = (n: number) => n.toLocaleString('en-US');

/** Decimal units, as the recommendations write them. */
function disk(bytes: number): string {
  for (const [size, unit] of [
    [1e12, 'TB'],
    [1e9, 'GB'],
    [1e6, 'MB'],
    [1e3, 'KB'],
  ] as const) {
    if (bytes >= size) return `${Number((bytes / size).toFixed(bytes / size >= 10 ? 0 : 1))} ${unit}`;
  }
  return `${bytes} B`;
}

function longDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const FIELDS: { key: keyof StorageSettings; label: string; unit: string }[] = [
  { key: 'maxAgeDays', label: 'Maximum age', unit: 'days' },
  { key: 'maxEvents', label: 'Maximum events', unit: 'events' },
  { key: 'latenessDays', label: 'Lateness window', unit: 'days' },
];

export function StoragePanel({ databaseId, databaseName, unreachable }: { databaseId: string; databaseName: string; unreachable: string }) {
  const storage = useQuery({ queryKey: ['analytics-storage', databaseId], queryFn: () => storageApi.get(databaseId), retry: false });
  const forbidden = storage.error instanceof ApiError && storage.error.status === 403;
  const { hash } = useLocation();
  // AN-021: the Collect notice links to data health. A client-side navigation does not scroll to
  // a hash, so the panel does, once the cards above data health have their height.
  useEffect(() => {
    if (hash === '#data-health' && !storage.isLoading) document.getElementById('data-health')?.scrollIntoView();
  }, [hash, storage.isLoading]);

  return (
    <div className="mt-4 max-w-3xl space-y-4">
      {storage.isLoading ? (
        <Skeleton className="h-48" />
      ) : forbidden ? (
        <p className="text-sm text-muted-foreground">Only a database or project Admin can read and change the storage settings.</p>
      ) : storage.error ? (
        <p role="status" className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
          {queryErrorSentence(storage.error, unreachable)}
        </p>
      ) : storage.data ? (
        <>
          <SettingsCard databaseId={databaseId} databaseName={databaseName} storage={storage.data} />
          <UsageCard storage={storage.data} />
        </>
      ) : null}
      <DataHealthCard databaseId={databaseId} />
    </div>
  );
}

function SettingsCard({ databaseId, databaseName, storage }: { databaseId: string; databaseName: string; storage: AnalyticsStorage }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<keyof StorageSettings, string>>(() => textOf(storage.settings));
  const [confirming, setConfirming] = useState<AnalyticsStorage['removes'] | null>(null);
  useEffect(() => setDraft(textOf(storage.settings)), [storage.settings]);

  const values = Object.fromEntries(FIELDS.map(({ key }) => [key, Number(draft[key])])) as StorageSettings;
  const valid = FIELDS.every(({ key }) => draft[key].trim() !== '' && Number.isInteger(values[key]));
  const changed = FIELDS.some(({ key }) => values[key] !== storage.settings[key]);
  const lowers = values.maxAgeDays < storage.settings.maxAgeDays || values.maxEvents < storage.settings.maxEvents;
  const raises = values.maxAgeDays > storage.settings.maxAgeDays || values.maxEvents > storage.settings.maxEvents;
  const body = () => Object.fromEntries(FIELDS.filter(({ key }) => values[key] !== storage.settings[key]).map(({ key }) => [key, values[key]]));

  const preview = useMutation({
    mutationFn: () => storageApi.update(databaseId, { ...body(), preview: true }),
    onSuccess: (answer) => setConfirming(answer.removes ?? null),
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'What the change removes could not be worked out.'),
  });
  const save = useMutation({
    mutationFn: (confirm?: string) => storageApi.update(databaseId, { ...body(), ...(confirm ? { confirm } : {}) }),
    onSuccess: async (answer) => {
      setConfirming(null);
      queryClient.setQueryData(['analytics-storage', databaseId], answer);
      await queryClient.invalidateQueries({ queryKey: ['analytics-database', databaseId] });
      toast.success(answer.notice ?? 'Storage settings saved.');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The settings were not saved.'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage settings</CardTitle>
        <CardDescription>What this database keeps. A change takes effect at the next retention pass, within the hour.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            // AN-161: a lowered limit states what it removes and asks for the name first.
            if (lowers) preview.mutate();
            else save.mutate(undefined);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {FIELDS.map(({ key, label, unit }) => {
              const bound = storage.bounds[key];
              return (
                <div key={key} className="space-y-1.5">
                  <Label htmlFor={`storage-${key}`}>{label}</Label>
                  <Input
                    id={`storage-${key}`}
                    inputMode="numeric"
                    value={draft[key]}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value.replace(/[^\d]/g, '') })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {count(bound.min)} to {count(bound.max)} {unit}; {count(bound.default)} by default.
                  </p>
                </div>
              );
            })}
          </div>
          {raises ? <p className="text-[13px] text-muted-foreground">A raised limit keeps more from now on and never restores events already removed.</p> : null}
          <Button type="submit" disabled={!valid || !changed || preview.isPending || save.isPending}>
            Save
          </Button>
        </form>
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
          {storage.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </CardContent>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => (open ? null : setConfirming(null))}
        title="Lower the storage limits?"
        confirmLabel="Lower the limits"
        confirmText={databaseName}
        pending={save.isPending}
        onConfirm={() => save.mutate(databaseName)}
        description={
          <>
            <p data-testid="storage-removes">{confirming?.statement}</p>
            <p>The next retention pass removes them, within the hour. Raising the limits again restores nothing.</p>
          </>
        }
      />
    </Card>
  );
}

function textOf(settings: StorageSettings): Record<keyof StorageSettings, string> {
  return { maxAgeDays: String(settings.maxAgeDays), maxEvents: String(settings.maxEvents), latenessDays: String(settings.latenessDays) };
}

function UsageCard({ storage }: { storage: AnalyticsStorage }) {
  const { usage } = storage;
  const rows: [string, string][] = [
    ['Events a day, seven-day average', count(usage.eventsPerDay.average)],
    ['Events kept', count(usage.events)],
    ['Oldest week kept', usage.oldestWeek ? `Week of ${longDay(usage.oldestWeek)}` : 'No event yet'],
    ['Disk used by this database in the event store', disk(usage.bytes.database)],
    ['Disk used by the whole event store', disk(usage.bytes.eventStore)],
    ['Disk used by the PostgreSQL database', disk(usage.bytes.postgres)],
    ['The limit that binds now', storage.binding === 'maxEvents' ? 'Maximum events' : 'Maximum age'],
    ['Days of events kept at this volume', storage.keptDays ? `Between ${storage.keptDays.min} and ${storage.keptDays.max}` : 'Not measured yet'],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage</CardTitle>
        <CardDescription>Measured from the event store’s own partitions, so rows erased but not yet removed from its files may count.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table data-testid="storage-usage">
          <TableBody>
            {rows.map(([label, value]) => (
              <TableRow key={label}>
                <TableCell>{label}</TableCell>
                <TableCell className="numeric text-right">{value}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Recommendations</h3>
          <ul data-testid="storage-recommendations" className="list-disc space-y-1 pl-5 text-sm">
            {storage.recommendations.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        </div>
        <details>
          <summary className="cursor-pointer text-sm">Events a day over the last 30 days</summary>
          <Table data-testid="storage-days">
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">Events</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.eventsPerDay.days.map((entry) => (
                <TableRow key={entry.day}>
                  <TableCell>{entry.day}</TableCell>
                  <TableCell className="numeric text-right">{count(entry.events)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      </CardContent>
    </Card>
  );
}

const REFUSALS: [string, string][] = [
  ['rate_limit_exceeded', 'Over the key’s rate limit'],
  ['installation_rate_limited', 'Over an installation’s rate limit'],
  ['event_too_old', 'Too old'],
  ['event_too_large', 'Too large'],
  ['event_name_limit', 'Beyond the event-name limit'],
  ['event_name_rate', 'Beyond the hourly allowance of new names'],
  ['event_blocked', 'Blocked name'],
  ['invalid_event', 'Invalid'],
  ['unknown_field', 'Unknown field'],
  ['missing_identity', 'No installation ID or user ID'],
];
const WARNINGS: [string, string][] = [
  ['truncated', 'Values truncated'],
  ['param_key_limit', 'Param keys dropped'],
  ['category_limit', 'Categories dropped'],
  ['placeholder_user_id', 'Placeholder user IDs dropped'],
  ['clock_corrected', 'Timestamps corrected'],
];

export function DataHealthCard({ databaseId }: { databaseId: string }) {
  const health = useQuery({ queryKey: ['analytics-data-health', databaseId], queryFn: () => storageApi.dataHealth(databaseId) });
  return (
    <Card id="data-health">
      <CardHeader>
        <CardTitle>Data health</CardTitle>
        <CardDescription>Events refused or removed and why, over the last 24 hours and 7 days, and the incidents announced in Slack.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4" data-testid="data-health">
        {health.data ? <HealthTables health={health.data} /> : health.error ? <p className="text-sm">{health.error instanceof ApiError ? health.error.message : 'Data health could not be read.'}</p> : <Skeleton className="h-32" />}
      </CardContent>
    </Card>
  );
}

function HealthTables({ health }: { health: AnalyticsDataHealth }) {
  const rows: [string, number, number][] = [
    ...REFUSALS.map(([code, label]): [string, number, number] => [`Refused: ${label}`, health.refused.last24h[code] ?? 0, health.refused.last7d[code] ?? 0]),
    ['Removed by the cap', health.removedByCap.last24h, health.removedByCap.last7d],
    ...WARNINGS.map(([code, label]): [string, number, number] => [label, health.warned.last24h[code] ?? 0, health.warned.last7d[code] ?? 0]),
    ['Duplicates received', health.duplicates.last24h, health.duplicates.last7d],
    ['Events stored', health.accepted.last24h, health.accepted.last7d],
  ];
  return (
    <>
      <Table data-testid="data-health-counts">
        <TableHeader>
          <TableRow>
            <TableHead>What</TableHead>
            <TableHead className="text-right">Last 24 hours</TableHead>
            <TableHead className="text-right">Last 7 days</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([label, day, week]) => (
            <TableRow key={label}>
              <TableCell>{label}</TableCell>
              <TableCell className="numeric text-right">{count(day)}</TableCell>
              <TableCell className="numeric text-right">{count(week)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Incidents</h3>
        {health.incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-incidents">
            No incident in the last 7 days.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="incidents">
            {health.incidents.map((incident) => (
              <li key={incident.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{INCIDENT_LABELS[incident.kind]}</span>
                  <Badge variant={incident.resolvedAt ? 'outline' : 'destructive'}>{incident.resolvedAt ? 'Resolved' : 'Open'}</Badge>
                </div>
                <p className="mt-1">{incident.summary}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Opened {formatDateTime(incident.openedAt)}
                  {incident.resolvedAt ? `, resolved ${formatDateTime(incident.resolvedAt)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * AN-021, PRD 8.1 Collect: while events are refused for the event-name limit or the hourly
 * allowance of new names (an open incident of either kind), a notice linking to data health.
 */
export function EventNameNotice({ databaseId, dataHealthHref }: { databaseId: string; dataHealthHref: string }) {
  const health = useQuery({ queryKey: ['analytics-data-health', databaseId], queryFn: () => storageApi.dataHealth(databaseId), refetchInterval: 60_000 });
  const open = (health.data?.incidents ?? []).filter((incident) => incident.resolvedAt === null && (incident.kind === 'event_name_limit' || incident.kind === 'event_name_rate'));
  if (open.length === 0) return null;
  const limit = open.some((incident) => incident.kind === 'event_name_limit');
  return (
    <p role="status" data-testid="event-name-notice" className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
      {limit
        ? 'Events with new names are being refused: this database holds as many event names as it may. Events with existing names are still stored. Delete or block unused names in Events.'
        : 'Events with new names are being refused: more new names arrived within an hour than this database accepts. Events with existing names are still stored.'}{' '}
      <Link className="underline" to={dataHealthHref}>
        See data health
      </Link>
    </p>
  );
}
