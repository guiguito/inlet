import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, EyeIcon, PlusIcon, SendIcon, SlidersHorizontalIcon } from 'lucide-react';
import type { ConfigTemplate, Role } from '@inlet/shared';
import { api, ApiError, type ConfigDatabase, type ConfigDraft, type ConfigDraftChange } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ConditionEditor } from './condition-editor';
import { ConditionsList } from './conditions-list';
import { ParameterEditor } from './parameter-editor';
import { ParametersList } from './parameters-list';
import { PreviewPanel } from './preview-panel';
import { PublishDialog } from './publish-dialog';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** One per-part change (RC-051): the request, and how its answer changes the template held in the cache. */
export type DraftChange = { send: () => Promise<ConfigDraftChange>; apply: (template: ConfigTemplate, answer: ConfigDraftChange) => ConfigTemplate };
export type RunChange = (change: DraftChange) => Promise<ConfigDraftChange>;

export const draftKey = (databaseId: string) => ['config-draft', databaseId] as const;

/**
 * The Parameters group of a config database (Remote Config PRD 8.1): the draft's header with
 * its state, Preview as and Publish, and a switch between the Parameters and Conditions views.
 * Every change goes through a per-part route (RC-051); its answer carries the draft's new state,
 * which replaces the header's, and the part as stored, which replaces the cached one, so a change
 * never refetches the whole draft.
 */
export function ParametersTab({ database, role, view, onView }: { database: ConfigDatabase; role: Role | undefined; view: 'parameters' | 'conditions'; onView: (view: 'parameters' | 'conditions') => void }) {
  const canEdit = role === 'admin' || role === 'creator';
  const queryClient = useQueryClient();
  const draft = useQuery({ queryKey: draftKey(database.id), queryFn: () => api.getConfigDraft(database.id) });
  const [save, setSave] = useState<SaveState>('idle');
  const [editing, setEditing] = useState<{ kind: 'parameter' | 'condition'; id: string | null } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // Radix gives the focus back to a Dialog.Trigger; these dialogs open from many buttons and have
  // none, so the tab gives it back to the button that opened them, once the dialog is gone.
  const opener = useRef<HTMLElement | null>(null);
  const opening = (open: () => void) => () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    open();
  };
  const closing = (close: () => void) => () => {
    close();
    const element = opener.current;
    setTimeout(() => element?.isConnected && element.focus());
  };

  const mutation = useMutation({
    mutationFn: (change: DraftChange) => change.send(),
    onMutate: () => setSave('saving'),
    onSuccess: (answer, change) => {
      const { parameter: _p, condition: _c, affectedParameters: _a, ...state } = answer;
      queryClient.setQueryData<ConfigDraft>(draftKey(database.id), (old) => (old ? { ...old, ...state, template: change.apply(old.template, answer) } : old));
      setSave('saved');
    },
    // The editor that asked keeps its edit and shows the problems; the header says it was not saved.
    // A refusal other than the save checks (a condition someone else deleted, an order missing one
    // they added) means the cached draft is behind: read it again, so the next try can succeed.
    onError: (error) => {
      setSave('error');
      if (error instanceof ApiError && error.code !== 'config_template_invalid') void queryClient.invalidateQueries({ queryKey: draftKey(database.id) });
    },
  });
  const run: RunChange = (change) => mutation.mutateAsync(change);

  if (draft.isLoading) return <Skeleton className="h-64" />;
  // A failed reread keeps the draft on screen (and any open editor with its edit); only a first read shows the failure.
  if (!draft.data) {
    return <EmptyState title="The draft could not be loaded" description={draft.error instanceof ApiError ? draft.error.message : 'Try reloading the page.'} />;
  }
  const data = draft.data;
  const empty = data.template.parameters.length === 0 && data.template.conditions.length === 0;
  const loose = data.problems.filter((problem) => !problem.parameter && !problem.condition);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium" data-testid="draft-changes">
            {data.changes === 0 ? 'No unpublished changes' : `${pluralize(data.changes, 'change')} not published`}
          </p>
          <p className="text-[13px] text-muted-foreground" data-testid="draft-differs">
            {data.activeVersion === null
              ? 'Nothing is published. Apps use their in-app defaults.'
              : data.differsFromActive
                ? `The draft differs from version ${data.activeVersion}, the active version.`
                : `The draft equals version ${data.activeVersion}, the active version.`}
          </p>
        </div>
        <SaveIndicator state={save} revision={data.revision} />
        <Button variant="outline" onClick={opening(() => setPreviewing(true))}>
          <EyeIcon />
          Preview as
        </Button>
        {canEdit ? (
          <Button onClick={opening(() => setPublishing(true))} disabled={!data.differsFromActive}>
            <SendIcon />
            Publish
          </Button>
        ) : null}
      </div>

      {loose.length > 0 ? (
        <ul className="space-y-1 rounded-lg border border-destructive/40 px-4 py-3 text-[13px] text-destructive">
          {loose.map((problem) => (
            <li key={`${problem.path}:${problem.code}`}>{problem.message}</li>
          ))}
        </ul>
      ) : null}

      {empty ? (
        <EmptyState
          icon={<SlidersHorizontalIcon />}
          title="No parameters yet"
          description="A parameter is a named value your app reads, such as a feature switch or a limit. A condition gives some users, devices or versions another value."
          action={
            canEdit ? (
              <Button onClick={opening(() => setEditing({ kind: 'parameter', id: null }))}>
                <PlusIcon />
                Add a parameter
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div role="radiogroup" aria-label="View" className="inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1">
              {(['parameters', 'conditions'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={view === value}
                  onClick={() => onView(value)}
                  className={cn(
                    'rounded-md px-3 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    view === value && 'bg-background text-foreground shadow-xs',
                  )}
                >
                  {value === 'parameters' ? `Parameters (${data.template.parameters.length})` : `Conditions (${data.template.conditions.length})`}
                </button>
              ))}
            </div>
            {canEdit ? (
              <Button className="ml-auto" variant="outline" onClick={opening(() => setEditing({ kind: view === 'parameters' ? 'parameter' : 'condition', id: null }))}>
                <PlusIcon />
                {view === 'parameters' ? 'New parameter' : 'New condition'}
              </Button>
            ) : null}
          </div>
          {view === 'parameters' ? (
            <ParametersList draft={data} onOpen={(key) => opening(() => setEditing({ kind: 'parameter', id: key }))()} />
          ) : (
            <ConditionsList draft={data} databaseId={database.id} canEdit={canEdit} run={run} onOpen={(id) => opening(() => setEditing({ kind: 'condition', id }))()} />
          )}
        </>
      )}

      {editing?.kind === 'parameter' ? (
        <ParameterEditor
          key={editing.id ?? 'new'}
          databaseId={database.id}
          draft={data}
          parameterKey={editing.id}
          readOnly={!canEdit}
          run={run}
          onClose={closing(() => setEditing(null))}
        />
      ) : null}
      {editing?.kind === 'condition' ? (
        <ConditionEditor
          key={editing.id ?? 'new'}
          databaseId={database.id}
          draft={data}
          conditionId={editing.id}
          readOnly={!canEdit}
          run={run}
          onClose={closing(() => setEditing(null))}
        />
      ) : null}
      {publishing ? <PublishDialog database={database} onClose={closing(() => setPublishing(false))} /> : null}
      {previewing ? <PreviewPanel database={database} draft={data} onClose={closing(() => setPreviewing(false))} /> : null}
    </div>
  );
}

function SaveIndicator({ state, revision }: { state: SaveState; revision: number }) {
  const text: Record<SaveState, string> = { idle: `Revision ${revision}`, saving: 'Saving…', saved: 'Saved', error: 'Not saved' };
  return (
    <span
      data-testid="save-state"
      data-state={state}
      aria-live="polite"
      className={cn('inline-flex items-center gap-1.5 text-xs', state === 'error' ? 'text-destructive' : 'text-muted-foreground')}
    >
      {state === 'saved' ? <CheckIcon className="size-3.5 text-success" /> : null}
      {text[state]}
    </span>
  );
}

/** A failure's message for a toast: the API's own, or a network failure that kept the edit. */
export function failureMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The change could not reach the server. Your edit is kept: try again.';
}
