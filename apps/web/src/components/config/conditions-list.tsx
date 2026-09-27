import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon, ChevronUpIcon, GripVerticalIcon, PencilIcon, TrashIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { ConfigCondition, ConfigTemplate } from '@inlet/shared';
import { api, type ConfigConditionReach, type ConfigDraft } from '@/lib/api';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { describeCondition } from './format';
import { failureMessage, type RunChange } from './parameters-tab';

function moved(template: ConfigTemplate, order: string[]): ConfigTemplate {
  const byId = new Map(template.conditions.map((condition) => [condition.id, condition]));
  return { ...template, conditions: order.flatMap((id) => byId.get(id) ?? []) };
}

/**
 * The Conditions view (PRD 8.1): the conditions in priority order (RC-020), moved by dragging or
 * by Move up and Move down, which keyboard users reach and a screen reader hears announced. Each
 * shows its name, kind, rules in plain words, the parameters that use it, whether it is unused
 * (RC-029), and its share of the last day's fetches when the reach route answers (RC-072).
 * Deleting one lists the parameters whose values go with it first (RC-028).
 */
export function ConditionsList({ draft, databaseId, canEdit, run, onOpen }: { draft: ConfigDraft; databaseId: string; canEdit: boolean; run: RunChange; onOpen: (id: string) => void }) {
  const conditions = draft.template.conditions;
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; direction: 'up' | 'down' } | null>(null);
  const [deleting, setDeleting] = useState<ConfigCondition | null>(null);
  const usage = useMemo(() => new Map(draft.conditionUsage.map((entry) => [entry.condition, entry.parameters])), [draft.conditionUsage]);
  // Piece 5's reach route: the shares show only once it answers.
  const reach = useQuery({ queryKey: ['config-reach', databaseId], queryFn: () => api.getConfigReach(databaseId), retry: false, staleTime: 60_000 });
  const lastDay = reach.data?.summary?.lastDay;
  const reachOf = useMemo(() => new Map((lastDay?.conditions ?? []).map((entry) => [entry.id, entry])), [lastDay]);

  // A moved row is re-inserted in the DOM, which can drop its focus: put it back on the same control.
  useEffect(() => {
    if (!focus) return;
    const button = document.querySelector<HTMLButtonElement>(`[data-move="${focus.direction}:${focus.id}"]`);
    const other = document.querySelector<HTMLButtonElement>(`[data-move="${focus.direction === 'up' ? 'down' : 'up'}:${focus.id}"]`);
    (button && !button.disabled ? button : other)?.focus();
  }, [focus, conditions]);

  // The order the last Move sent, until the list shows it: a second press before its answer moves
  // from that order, not from the one still on screen, and is sent once the first is answered.
  const sent = useRef<{ order: string[]; done: Promise<unknown> } | null>(null);
  useEffect(() => {
    if (sent.current && sent.current.order.join() === conditions.map((condition) => condition.id).join()) sent.current = null;
  }, [conditions]);

  async function reorder(order: string[], id: string, direction?: 'up' | 'down'): Promise<boolean> {
    const name = conditions.find((condition) => condition.id === id)?.name ?? id;
    try {
      await run({ send: () => api.reorderConfigConditions(databaseId, order), apply: (template) => moved(template, order) });
      setAnnouncement(`${name} moved to position ${order.indexOf(id) + 1} of ${order.length}.`);
      if (direction) setFocus({ id, direction });
      return true;
    } catch (error) {
      toast.error(failureMessage(error));
      return false;
    }
  }

  function move(id: string, by: -1 | 1) {
    const order = [...(sent.current?.order ?? conditions.map((condition) => condition.id))];
    const index = order.indexOf(id);
    if (index < 0 || index + by < 0 || index + by >= order.length) return;
    order.splice(index, 1);
    order.splice(index + by, 0, id);
    const done = (sent.current?.done ?? Promise.resolve()).then(async () => {
      // A refused move leaves the list to the draft read again: the next press starts from it.
      if (!(await reorder(order, id, by === -1 ? 'up' : 'down')) && sent.current?.order === order) sent.current = null;
    });
    sent.current = { order, done };
  }

  async function remove(condition: ConfigCondition) {
    try {
      await run({
        send: () => api.deleteConfigCondition(databaseId, condition.id),
        apply: (template) => ({
          parameters: template.parameters.map((parameter) => ({ ...parameter, conditional: parameter.conditional.filter((entry) => entry.condition !== condition.id) })),
          conditions: template.conditions.filter((other) => other.id !== condition.id),
        }),
      });
      toast.success(`${condition.name} deleted.`);
      setDeleting(null);
    } catch (error) {
      toast.error(failureMessage(error));
    }
  }

  if (conditions.length === 0) {
    return <p className="text-sm text-muted-foreground">No conditions yet. A condition gives some users, devices or versions another value than the default.</p>;
  }
  const affected = deleting ? (usage.get(deleting.id) ?? []) : [];

  return (
    <div className="space-y-2">
      <p className="text-[13px] text-muted-foreground">
        Highest priority first: for each parameter, the first true condition that holds a value for it gives the value.
        {lastDay ? ' Shares count fetches, not devices.' : ''}
      </p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <ol className="divide-y rounded-lg border" aria-label="Conditions in priority order">
        {conditions.map((condition, index) => {
          const users = usage.get(condition.id) ?? [];
          const problems = draft.problems.filter((problem) => problem.condition === condition.id && !problem.parameter);
          return (
            <li
              key={condition.id}
              data-testid={`condition-${condition.id}`}
              draggable={canEdit}
              onDragStart={(event) => {
                setDragging(condition.id);
                event.dataTransfer.effectAllowed = 'move';
                // Firefox starts a drag only once it carries data.
                event.dataTransfer.setData('text/plain', condition.name);
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => {
                if (dragging) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (!dragging || dragging === condition.id) return;
                const order = conditions.map((other) => other.id).filter((id) => id !== dragging);
                order.splice(index, 0, dragging);
                void reorder(order, dragging);
                setDragging(null);
              }}
              className={cn('flex items-start gap-3 px-4 py-3', dragging === condition.id && 'opacity-50')}
            >
              {canEdit ? <GripVerticalIcon className="mt-1 size-4 shrink-0 cursor-grab text-muted-foreground/60" aria-hidden="true" /> : null}
              <span className="numeric mt-0.5 w-5 shrink-0 text-xs text-muted-foreground" aria-label={`Priority ${index + 1}`}>
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{condition.name}</span>
                  <Badge variant="outline">{condition.kind === 'match' ? 'Match' : 'Split'}</Badge>
                  {condition.kind === 'split' ? <Badge variant="muted" className="font-mono">{condition.experiment}</Badge> : null}
                  {condition.kind === 'match' && users.length === 0 ? <Badge variant="muted">Unused</Badge> : null}
                  {problems.length > 0 ? <Badge variant="destructive">{problems.length === 1 ? '1 problem' : `${problems.length} problems`}</Badge> : null}
                </div>
                <p className="text-[13px]">{describeCondition(condition)}</p>
                <p className="text-xs text-muted-foreground">
                  {users.length === 0 ? 'Used by no parameter' : `Used by ${pluralize(users.length, 'parameter')}`}
                  {lastDay ? <ReachShare entry={reachOf.get(condition.id)} /> : null}
                </p>
                {problems.length > 0 ? (
                  <ul className="space-y-0.5 text-xs text-destructive">
                    {problems.map((problem) => (
                      <li key={`${problem.path}:${problem.code}`}>{problem.message}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {canEdit ? (
                  <>
                    <Button variant="ghost" size="icon-sm" data-move={`up:${condition.id}`} disabled={index === 0} aria-label={`Move ${condition.name} up`} onClick={() => move(condition.id, -1)}>
                      <ChevronUpIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      data-move={`down:${condition.id}`}
                      disabled={index === conditions.length - 1}
                      aria-label={`Move ${condition.name} down`}
                      onClick={() => move(condition.id, 1)}
                    >
                      <ChevronDownIcon />
                    </Button>
                  </>
                ) : null}
                <Button variant="ghost" size="icon-sm" aria-label={`${canEdit ? 'Edit' : 'Open'} ${condition.name}`} onClick={() => onOpen(condition.id)}>
                  <PencilIcon />
                </Button>
                {canEdit ? (
                  <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Delete ${condition.name}`} onClick={() => setDeleting(condition)}>
                    <TrashIcon />
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'this condition'}?`}
        description={
          affected.length === 0 ? (
            <p>No parameter holds a value under it.</p>
          ) : (
            <>
              <p>The values these parameters hold under it are deleted with it:</p>
              <ul className="list-disc pl-5 font-mono text-foreground" data-testid="affected-parameters">
                {affected.map((key) => (
                  <li key={key}>{key}</li>
                ))}
              </ul>
            </>
          )
        }
        onConfirm={() => deleting && void remove(deleting)}
      />
    </div>
  );
}

/** RC-070, RC-072: a count from 1 to 9 is "fewer than 10", never a number or a share; 0 is "matched none". */
function ReachShare({ entry }: { entry: ConfigConditionReach | undefined }) {
  if (!entry || entry.matchedNone) return <span className="text-warning" data-testid="reach"> · matched no fetch in the last day</span>;
  if ('withheld' in entry.fetches) return <span data-testid="reach"> · 10 or more fetches in the last day (withheld, so that a smaller count cannot be worked out)</span>;
  if (entry.fetches.count === null) return <span data-testid="reach"> · fewer than 10 fetches in the last day</span>;
  const share = entry.share === null ? '' : `${(entry.share * 100).toFixed(1)}% of the last day’s fetches, `;
  return (
    <span data-testid="reach">
      {' '}
      · {share}
      {pluralize(entry.fetches.count, 'fetch', 'fetches')}
    </span>
  );
}
