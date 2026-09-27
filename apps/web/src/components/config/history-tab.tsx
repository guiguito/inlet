import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDownIcon, DownloadIcon, HistoryIcon } from 'lucide-react';
import { CONFIG_LIMITS, type ConfigChangeSummary, type Role } from '@inlet/shared';
import { api, ApiError, configExportPath, type ConfigActivity, type ConfigDatabase, type ConfigSource, type ConfigVersion } from '@/lib/api';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime, pluralize } from '@/lib/format';
import { draftKey, failureMessage } from './parameters-tab';
import { ConfigDiffView } from './publish-dialog';

export const historyKey = (databaseId: string) => ['config-history', databaseId] as const;
export const reachKey = (databaseId: string) => ['config-reach', databaseId] as const;

/** A share of fetches (a fraction to four decimals) as text. */
export function sharePercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** RC-052: a version's change summary in words. */
export function summaryText(summary: ConfigChangeSummary): string {
  const part = (noun: string, added: number, changed: number, removed: number) => {
    const bits = [added && `${added} added`, changed && `${changed} changed`, removed && `${removed} removed`].filter(Boolean);
    return bits.length ? `${noun}: ${bits.join(', ')}` : null;
  };
  const c = summary.counts;
  const parts = [
    part('Parameters', c.parametersAdded, c.parametersChanged, c.parametersRemoved),
    part('Conditions', c.conditionsAdded, c.conditionsChanged, c.conditionsRemoved),
    summary.conditions.reordered ? 'Conditions reordered' : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join('. ')}.` : 'No change.';
}

const actorName = (entry: ConfigActivity) => (entry.actor ? (entry.actor.name ?? (entry.actor.kind === 'key' ? 'A deleted key' : 'A deleted user')) : 'Someone');

type Page = { activity: ConfigActivity[]; nextCursor: string | null; versions: Map<number, ConfigVersion> };

/**
 * The History group of a config database (Remote Config PRD 8.1, RC-053 to RC-058, RC-064,
 * RC-072): the activity newest first, each version with its summary, the Active badge, its
 * share of the last 24 hours' fetches, View, Compare with…, Roll back, Copy to draft and
 * Export; Unpublish and the history export at the top. A Viewer reads, compares and exports.
 */
export function HistoryTab({ database, role }: { database: ConfigDatabase; role: Role | undefined }) {
  const canEdit = role === 'admin' || role === 'creator';
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ kind: 'view' | 'compare' | 'rollback' | 'copy'; version: number } | { kind: 'unpublish' } | null>(null);

  // Each activity page reads the versions it names in one request: versions are numbered, so
  // those below `max + 1` are exactly the page's range.
  const history = useInfiniteQuery({
    queryKey: historyKey(database.id),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: Page) => page.nextCursor ?? undefined,
    queryFn: async ({ pageParam }): Promise<Page> => {
      const { activity, nextCursor } = await api.listConfigActivity(database.id, pageParam);
      const numbers = activity.flatMap((entry) => (entry.version === null ? [] : [entry.version]));
      const versions = new Map<number, ConfigVersion>();
      if (numbers.length > 0) {
        const max = Math.max(...numbers);
        const page = await api.listConfigVersions(database.id, Math.min(200, max - Math.min(...numbers) + 1), String(max + 1));
        for (const version of page.versions) versions.set(version.number, version);
      }
      return { activity, nextCursor, versions };
    },
  });
  const reach = useQuery({ queryKey: reachKey(database.id), queryFn: () => api.getConfigReach(database.id), retry: false, staleTime: 60_000 });
  const shares = new Map((reach.data?.summary.last24Hours.versions ?? []).map((entry) => [entry.version, entry]));

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: historyKey(database.id) }),
      queryClient.invalidateQueries({ queryKey: draftKey(database.id) }),
      queryClient.invalidateQueries({ queryKey: ['config-database', database.id] }),
      queryClient.invalidateQueries({ queryKey: ['config-databases', database.projectId] }),
      queryClient.invalidateQueries({ queryKey: reachKey(database.id) }),
    ]);

  const copy = useMutation({
    mutationFn: (version: number) => api.copyConfigVersionToDraft(database.id, version),
    onSuccess: async (_, version) => {
      await refresh();
      setDialog(null);
      toast.success(`Version ${version} copied to the draft.`);
    },
    onError: (error) => toast.error(failureMessage(error)),
  });
  const unpublish = useMutation({
    mutationFn: (confirm: string) => api.unpublishConfig(database.id, confirm),
    onSuccess: async () => {
      await refresh();
      setDialog(null);
      toast.success('Unpublished. Apps use their in-app defaults from their next fetch.');
    },
    onError: (error) => toast.error(failureMessage(error)),
  });

  if (history.isLoading) return <Skeleton className="h-64" />;
  if (history.error || !history.data) {
    return <EmptyState title="The history could not be loaded" description={history.error instanceof ApiError ? history.error.message : 'Try reloading the page.'} />;
  }
  const entries = history.data.pages.flatMap((page) => page.activity.map((entry) => ({ entry, version: entry.version === null ? undefined : page.versions.get(entry.version) })));
  const known = [...new Set(entries.flatMap(({ version }) => (version ? [version.number] : [])))];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium" data-testid="history-state">
            {database.activeVersion === null ? 'Nothing is published. Apps use their in-app defaults.' : `Version ${database.activeVersion} is active.`}
          </p>
          <p className="text-[13px] text-muted-foreground" data-testid="history-reach">
            {reach.data
              ? `${pluralize(reach.data.summary.last24Hours.fetches, 'fetch', 'fetches')} in the last 24 hours. These are fetches, not devices.`
              : 'Each version’s share of the last 24 hours’ fetches appears here once apps fetch. These are fetches, not devices.'}
          </p>
        </div>
        <Button variant="outline" asChild>
          <a href={`/v1/config-databases/${database.id}/export/history`} download>
            <DownloadIcon />
            Export the history
          </a>
        </Button>
        {canEdit && database.activeVersion !== null ? (
          <Button variant="destructive" onClick={() => setDialog({ kind: 'unpublish' })}>
            Unpublish
          </Button>
        ) : null}
      </div>

      {entries.length === 0 ? (
        <EmptyState icon={<HistoryIcon />} title="Nothing published yet" description="Each publish, rollback and unpublish is listed here, newest first." />
      ) : (
        <ol className="space-y-2" aria-label="Activity">
          {entries.map(({ entry, version }) => {
            const share = version ? shares.get(version.number) : undefined;
            return (
              <li key={entry.id} className="space-y-2 rounded-lg border bg-card px-4 py-3" data-testid={`activity-${entry.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">
                    {entry.kind === 'unpublish'
                      ? 'Unpublished: apps use their in-app defaults from their next fetch'
                      : entry.kind === 'rollback'
                        ? `Version ${entry.version} published, rolling back${version?.rolledBackFrom ? ` to version ${version.rolledBackFrom}` : ''}`
                        : `Version ${entry.version} published`}
                  </p>
                  {version?.active ? <Badge variant="primary">Active</Badge> : null}
                  <span className="text-[13px] text-muted-foreground">
                    by {actorName(entry)}, {formatDateTime(entry.at)}
                  </span>
                </div>
                {entry.note ? <p className="text-[13px]">{entry.note}</p> : null}
                {version ? (
                  <>
                    <p className="text-[13px] text-muted-foreground">{summaryText(version.changeSummary)}</p>
                    <p className="text-[13px] text-muted-foreground" data-testid={`version-${version.number}-share`}>
                      {share && share.share !== null
                        ? `${sharePercent(share.share)} of the last 24 hours’ fetches (${pluralize(share.fetches, 'fetch', 'fetches')}, not devices)`
                        : 'No fetch of this version in the last 24 hours'}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'view', version: version.number })}>
                        View
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'compare', version: version.number })}>
                        Compare with…
                      </Button>
                      {canEdit && !version.active ? (
                        <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'rollback', version: version.number })}>
                          Roll back to this version
                        </Button>
                      ) : null}
                      {canEdit ? (
                        <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'copy', version: version.number })}>
                          Copy to draft
                        </Button>
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="outline" aria-label={`Export version ${version.number}`}>
                            Export
                            <ChevronDownIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem asChild>
                            <a href={configExportPath(database.id, version.number)} download>
                              The template (JSON, for import)
                            </a>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <a href={configExportPath(database.id, version.number, 'ts')} download>
                              The defaults (TypeScript)
                            </a>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <a href={configExportPath(database.id, version.number, 'defaults')} download>
                              The defaults (JSON)
                            </a>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {history.hasNextPage ? (
        <Button variant="outline" disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>
          {history.isFetchingNextPage ? 'Loading…' : 'Show older activity'}
        </Button>
      ) : null}

      {dialog?.kind === 'view' ? <ViewDialog databaseId={database.id} version={dialog.version} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'compare' ? <CompareDialog database={database} version={dialog.version} versions={known} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'rollback' ? <RollbackDialog database={database} version={dialog.version} onDone={refresh} onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={dialog?.kind === 'copy'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={dialog?.kind === 'copy' ? `Copy version ${dialog.version} to the draft?` : ''}
        confirmLabel="Copy to draft"
        pending={copy.isPending}
        pendingLabel="Copying…"
        onConfirm={() => dialog?.kind === 'copy' && copy.mutate(dialog.version)}
        description={<p>This replaces the whole draft with the version’s template. Changes in the draft that are not published are lost. Nothing is published.</p>}
      />
      <ConfirmDialog
        open={dialog?.kind === 'unpublish'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Unpublish ${database.name}?`}
        confirmLabel="Unpublish"
        confirmText={database.name}
        pending={unpublish.isPending}
        pendingLabel="Unpublishing…"
        onConfirm={() => unpublish.mutate(database.name)}
        description={
          <p>
            Every app falls back to its in-app defaults at its next fetch. Every version is kept: publishing or rolling back undoes it.
          </p>
        }
      />
    </div>
  );
}

/** RC-058: a version's template, read-only, as the text its export downloads. */
function ViewDialog({ databaseId, version, onClose }: { databaseId: string; version: number; onClose: () => void }) {
  const template = useQuery({ queryKey: ['config-export', databaseId, version, 'json'], queryFn: () => api.exportConfig(databaseId, version, 'json') });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Version {version}</DialogTitle>
          <DialogDescription>The template, read-only. Versions never change.</DialogDescription>
        </DialogHeader>
        {template.isLoading ? (
          <Skeleton className="h-40" />
        ) : template.error ? (
          <p className="text-sm text-destructive">{failureMessage(template.error)}</p>
        ) : (
          <pre data-testid="version-template" className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
            {template.data}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}

const sourceLabel = (source: ConfigSource) => (source === 'draft' ? 'the draft' : source === 'active' ? 'the active version' : `version ${source}`);

/** The names of the conditions both sides hold, so a conditional value reads by its condition's name. */
async function conditionNames(databaseId: string, sources: ConfigSource[]) {
  const names = new Map<string, string>();
  // Names are for reading only: a side that cannot be read (nothing active) names nothing.
  const texts = await Promise.all(sources.map((source) => api.exportConfig(databaseId, source, 'json').catch(() => '{"conditions":[]}')));
  for (const text of texts) {
    for (const condition of (JSON.parse(text) as { conditions: Array<{ id: string; name: string }> }).conditions) names.set(condition.id, condition.name);
  }
  return names;
}

/** A difference and the names it needs, or "No difference". */
function DiffBody({ databaseId, from, to }: { databaseId: string; from: ConfigSource; to: ConfigSource }) {
  const diff = useQuery({
    queryKey: ['config-diff', databaseId, from, to],
    gcTime: 0,
    queryFn: async () => {
      const [answer, names] = await Promise.all([api.diffConfig(databaseId, from, to), conditionNames(databaseId, [from, to])]);
      return { answer, names };
    },
  });
  if (diff.isLoading) return <Skeleton className="h-40" />;
  if (diff.error || !diff.data) return <p className="text-sm text-destructive">{failureMessage(diff.error)}</p>;
  const { answer, names } = diff.data;
  const same = answer.parameters.length === 0 && answer.conditions.length === 0 && !answer.conditionsReordered;
  return (
    <div className="space-y-5" data-testid="config-diff">
      {same ? <p className="text-sm text-muted-foreground">No difference.</p> : <ConfigDiffView diff={answer} names={names} />}
    </div>
  );
}

/** RC-057: this version against the draft, the active version or another version. */
function CompareDialog({ database, version, versions, onClose }: { database: ConfigDatabase; version: number; versions: number[]; onClose: () => void }) {
  const [other, setOther] = useState<string>(database.activeVersion !== null && database.activeVersion !== version ? 'active' : 'draft');
  const target: ConfigSource = other === 'draft' || other === 'active' ? other : Number(other);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Compare version {version}</DialogTitle>
          <DialogDescription>
            What changes going from version {version} (before) to {sourceLabel(target)} (after).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="compare-with">Compare with</Label>
          <Select value={other} onValueChange={setOther}>
            <SelectTrigger id="compare-with" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="draft">The draft</SelectItem>
              {database.activeVersion !== null ? <SelectItem value="active">The active version ({database.activeVersion})</SelectItem> : null}
              {versions
                .filter((number) => number !== version)
                .map((number) => (
                  <SelectItem key={number} value={String(number)}>
                    Version {number}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <DiffBody databaseId={database.id} from={version} to={target} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * RC-053, RC-054: the review of a rollback — the difference between the active version and
 * the one rolled back to, with the RC-017 warnings for it, and a note — then the new version.
 * The draft is not changed, and the review says so.
 */
function RollbackDialog({ database, version, onDone, onClose }: { database: ConfigDatabase; version: number; onDone: () => Promise<unknown>; onClose: () => void }) {
  const [note, setNote] = useState('');
  const rollback = useMutation({
    mutationFn: () => api.rollbackConfig(database.id, version, note.trim() || undefined),
    onSuccess: async (answer) => {
      await onDone();
      toast.success(
        answer.created
          ? `Version ${answer.version.number} published, equal to version ${version}. The draft is unchanged.`
          : `Nothing was published: version ${version} equals the active version.`,
      );
      onClose();
    },
    onError: (error) => toast.error(failureMessage(error)),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Roll back to version {version}</DialogTitle>
          <DialogDescription>
            {database.activeVersion === null
              ? `What apps will receive, against nothing published. Rolling back publishes a new version equal to version ${version}.`
              : `What changes against version ${database.activeVersion}, the active version. Rolling back publishes a new version equal to version ${version}.`}
          </DialogDescription>
        </DialogHeader>
        <DiffBody databaseId={database.id} from="active" to={version} />
        <p className="rounded-md border px-3 py-2 text-[13px]" data-testid="rollback-draft-note">
          The draft is not changed, so it may still hold what you are rolling back. Copy version {version} to the draft to remove it there.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="rollback-note">Note (optional)</Label>
          <Textarea id="rollback-note" rows={2} maxLength={CONFIG_LIMITS.noteMaxLength} value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={rollback.isPending}>
            Cancel
          </Button>
          <Button disabled={rollback.isPending} onClick={() => rollback.mutate()}>
            {rollback.isPending ? 'Rolling back…' : `Roll back to version ${version}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
