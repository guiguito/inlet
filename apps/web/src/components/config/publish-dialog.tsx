import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangleIcon } from 'lucide-react';
import { toast } from 'sonner';
import { CONFIG_LIMITS, type ConfigCondition, type ConfigParameter } from '@inlet/shared';
import { api, ApiError, type ConfigDatabase, type ConfigDiff } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { describeCondition, prettyValue, TYPE_LABELS } from './format';
import { draftKey, failureMessage } from './parameters-tab';

const CHANGE_LABELS = { added: 'Added', changed: 'Changed', removed: 'Removed' } as const;

/**
 * Publish (RC-052, RC-053): the review of the draft against the active version, grouped by
 * parameters and conditions, with the values before and after as text, the RC-017 warnings, the
 * publish problems (Publish is disabled while any remain) and a note. The draft is read before the
 * difference, and its revision is what is published, so a change made after the read makes the
 * publish fail with `stale_draft_revision` instead of publishing something not shown.
 */
export function PublishDialog({ database, onClose }: { database: ConfigDatabase; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [stale, setStale] = useState(false);
  const review = useQuery({
    queryKey: ['config-publish-review', database.id],
    gcTime: 0,
    queryFn: async () => {
      const draft = await api.getConfigDraft(database.id);
      queryClient.setQueryData(draftKey(database.id), draft);
      const [diff, versions] = await Promise.all([api.diffConfig(database.id), api.listConfigVersions(database.id, 1)]);
      return { draft, diff, next: (versions.versions[0]?.number ?? 0) + 1 };
    },
  });

  const publish = useMutation({
    mutationFn: (revision: number) => api.publishConfig(database.id, revision, note.trim() || undefined),
    onSuccess: async (answer) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: draftKey(database.id) }),
        queryClient.invalidateQueries({ queryKey: ['config-database', database.id] }),
        queryClient.invalidateQueries({ queryKey: ['config-databases', database.projectId] }),
      ]);
      toast.success(answer.created ? `Version ${answer.version.number} published.` : `Nothing was published: the draft equals version ${answer.version.number}, which is active.`);
      onClose();
    },
    onError: async (error) => {
      if (error instanceof ApiError && (error.code === 'stale_draft_revision' || error.code === 'config_template_invalid')) {
        setStale(error.code === 'stale_draft_revision');
        await review.refetch();
      } else toast.error(failureMessage(error));
    },
  });

  const data = review.data;
  const names = new Map<string, string>();
  if (data) {
    for (const entry of data.diff.conditions) for (const condition of [entry.before, entry.after]) if (condition) names.set(condition.id, condition.name);
    for (const condition of data.draft.template.conditions) names.set(condition.id, condition.name);
  }
  const blocked = !data || data.draft.problems.length > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Publish the draft</DialogTitle>
          <DialogDescription>
            {database.activeVersion === null ? 'What apps will receive, against nothing published.' : `What changes against version ${database.activeVersion}, the active version.`}
          </DialogDescription>
        </DialogHeader>

        {review.isLoading ? (
          <Skeleton className="h-40" />
        ) : review.error || !data ? (
          <p className="text-sm text-destructive">{failureMessage(review.error)}</p>
        ) : (
          <div className="space-y-5" data-testid="publish-review">
            {stale ? (
              <p role="alert" className="rounded-md border border-warning/50 px-3 py-2 text-[13px]">
                The draft changed since this review. Here is the review of revision {data.draft.revision}; check it before publishing.
              </p>
            ) : null}
            {!data.draft.differsFromActive ? <p className="text-sm text-muted-foreground">The draft equals the active version: publishing creates nothing.</p> : null}

            <ConfigDiffView diff={data.diff} names={names} />

            {data.draft.problems.length > 0 ? (
              <div className="space-y-1 rounded-md border border-destructive/40 px-3 py-2" data-testid="publish-problems">
                <p className="text-[13px] font-medium text-destructive">Publishing is refused until these are fixed:</p>
                <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-destructive">
                  {data.draft.problems.map((problem) => (
                    <li key={`${problem.path}:${problem.code}:${problem.valuePath ?? ''}`}>
                      {problem.message}
                      {problem.valuePath ? ` (at ${problem.valuePath})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="publish-note">Note (optional)</Label>
              <Textarea id="publish-note" rows={2} maxLength={CONFIG_LIMITS.noteMaxLength} value={note} onChange={(event) => setNote(event.target.value)} />
              <p className="numeric text-right text-xs text-muted-foreground">
                {note.length}/{CONFIG_LIMITS.noteMaxLength}
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={publish.isPending}>
            Cancel
          </Button>
          <Button disabled={blocked || publish.isPending || review.isFetching} onClick={() => data && publish.mutate(data.draft.revision)}>
            {publish.isPending ? 'Publishing…' : data ? `Publish version ${data.next}` : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A difference (RC-057) grouped by parameters and conditions, with the values before and after
 * as text, and the RC-017 warnings. The publish review uses it, and so do History's Compare and
 * rollback review (piece 8). `names` names the conditions conditional values refer to.
 */
export function ConfigDiffView({ diff, names }: { diff: ConfigDiff; names: Map<string, string> }) {
  return (
    <>
      {diff.parameters.length > 0 ? (
        <section className="space-y-2" aria-labelledby="review-parameters">
          <h3 id="review-parameters" className="text-sm font-medium">
            Parameters
          </h3>
          <ul className="space-y-2">
            {diff.parameters.map((entry) => (
              <li key={entry.key} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{entry.key}</span>
                  <Badge variant={entry.change === 'removed' ? 'destructive' : entry.change === 'added' ? 'primary' : 'outline'}>{CHANGE_LABELS[entry.change]}</Badge>
                </div>
                <BeforeAfter before={entry.before && <ParameterText parameter={entry.before} names={names} />} after={entry.after && <ParameterText parameter={entry.after} names={names} />} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {diff.conditions.length > 0 || diff.conditionsReordered ? (
        <section className="space-y-2" aria-labelledby="review-conditions">
          <h3 id="review-conditions" className="text-sm font-medium">
            Conditions
          </h3>
          {diff.conditionsReordered ? <p className="text-[13px]">The conditions’ priority order changes.</p> : null}
          <ul className="space-y-2">
            {diff.conditions.map((entry) => (
              <li key={entry.id} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{(entry.after ?? entry.before)?.name}</span>
                  <Badge variant={entry.change === 'removed' ? 'destructive' : entry.change === 'added' ? 'primary' : 'outline'}>{CHANGE_LABELS[entry.change]}</Badge>
                </div>
                {entry.before && entry.after && entry.before.salt !== entry.after.salt ? (
                  <p className="text-[13px]">Reshuffled: every unit gets a new bucket for this condition.</p>
                ) : null}
                <BeforeAfter before={entry.before && <ConditionText condition={entry.before} />} after={entry.after && <ConditionText condition={entry.after} />} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {diff.warnings.length > 0 ? (
        <ul className="space-y-1" aria-label="Warnings">
          {diff.warnings.map((warning) => (
            <li key={`${warning.parameter}:${warning.code}`} className="flex items-start gap-2 text-[13px]">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              {warning.message}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function BeforeAfter({ before, after }: { before: ReactNode; after: ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Before</p>
        {before || <p className="text-xs text-muted-foreground">Not there</p>}
      </div>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">After</p>
        {after || <p className="text-xs text-muted-foreground">Removed</p>}
      </div>
    </div>
  );
}

/** A value as text, pretty-printed; a long one collapsed behind its first line. */
function ValueText({ value }: { value: unknown }) {
  const text = prettyValue(value);
  const long = text.length > 200 || text.split('\n').length > 8;
  const pre = <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 font-mono text-xs">{text}</pre>;
  if (!long) return pre;
  return (
    <details>
      <summary className="cursor-pointer truncate font-mono text-xs">{text.split('\n')[0]}…</summary>
      {pre}
    </details>
  );
}

function ParameterText({ parameter, names }: { parameter: ConfigParameter; names: Map<string, string> }) {
  return (
    <div className="space-y-1 text-xs">
      <p>
        {TYPE_LABELS[parameter.type]}
        {parameter.live ? ', live' : ''}
      </p>
      {parameter.description ? <p className="text-muted-foreground">{parameter.description}</p> : null}
      <p className="text-muted-foreground">Default</p>
      <ValueText value={parameter.default} />
      {parameter.conditional.map((entry) => (
        <div key={`${entry.condition}:${entry.variant ?? ''}`} className="space-y-1">
          <p className="text-muted-foreground">
            Under {names.get(entry.condition) ?? entry.condition}
            {entry.variant ? `: ${entry.variant}` : ''}
          </p>
          <ValueText value={entry.value} />
        </div>
      ))}
      {parameter.schema !== undefined ? (
        <>
          <p className="text-muted-foreground">Schema</p>
          <ValueText value={parameter.schema} />
        </>
      ) : null}
    </div>
  );
}

function ConditionText({ condition }: { condition: ConfigCondition }) {
  return (
    <div className="space-y-1 text-xs">
      <p>
        {condition.name} ({condition.kind === 'match' ? 'match' : `split, experiment ${condition.experiment}`})
      </p>
      <p className="text-muted-foreground">{describeCondition(condition)}</p>
    </div>
  );
}
