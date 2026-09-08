import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ImageIcon,
  LayersIcon,
  ListIcon,
  MailIcon,
  PlusIcon,
  TextIcon,
  TrashIcon,
  TypeIcon,
  UploadIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { newId, type FormDefinition, type FormElement, type FormPage } from '@inlet/shared';
import { api, ApiError, type CurrentUser } from '@/lib/api';
import { AppShell, PageHeader } from '@/components/app-shell';
import {
  duplicateElement,
  ElementEditor,
  newElement,
} from '@/components/builder/element-editor';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { pluralize } from '@/lib/format';

/**
 * The visual form builder (FR-030 to FR-049).
 *
 * The draft lives in local state and autosaves on a debounce (FR-042A). The server's
 * revision counter is tracked so publishing can assert it and be refused if the draft
 * moved underneath the editor (FR-042C).
 */
const AUTOSAVE_DELAY_MS = 800;

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export function BuilderPage({ user }: { user: CurrentUser }) {
  const { databaseId = '' } = useParams();
  const queryClient = useQueryClient();

  const [definition, setDefinition] = useState<FormDefinition | null>(null);
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const pendingDefinition = useRef<FormDefinition | null>(null);

  const database = useQuery({
    queryKey: ['database', databaseId],
    queryFn: () => api.getDatabase(databaseId),
  });

  const project = useQuery({
    queryKey: ['project', database.data?.projectId],
    queryFn: () => api.getProject(database.data?.projectId ?? ''),
    enabled: Boolean(database.data?.projectId),
  });

  const draft = useQuery({
    queryKey: ['draft', databaseId],
    queryFn: () => api.getDraft(databaseId),
  });

  // Adopt the server's draft once; after that the editor owns the definition.
  useEffect(() => {
    if (!draft.data || definition !== null) return;
    setDefinition(draft.data.definition);
    setRevision(draft.data.revision);
    setActivePageId(draft.data.definition.pages[0]?.id ?? null);
  }, [draft.data, definition]);

  const save = useMutation({
    mutationFn: (next: FormDefinition) => api.saveDraft(databaseId, next),
    onMutate: () => setSaveState('saving'),
    onSuccess: (saved) => {
      setRevision(saved.revision);
      setSaveState(pendingDefinition.current ? 'pending' : 'saved');
      // The response is the fresh draft, including its problems, so seed the cache
      // rather than invalidating and refetching on every keystroke.
      queryClient.setQueryData(['draft', databaseId], saved);
    },
    onError: (error) => {
      setSaveState('error');
      toast.error(
        error instanceof ApiError ? error.message : 'The draft could not be autosaved.',
      );
    },
  });

  /** Debounced autosave. The latest definition always wins (FR-042A). */
  const update = useCallback(
    (next: FormDefinition) => {
      setDefinition(next);
      pendingDefinition.current = next;
      setSaveState('pending');
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const queued = pendingDefinition.current;
        pendingDefinition.current = null;
        if (queued) save.mutate(queued);
      }, AUTOSAVE_DELAY_MS);
    },
    [save],
  );

  // Flush a pending save when the editor is closed, so nothing is lost on navigation.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      const queued = pendingDefinition.current;
      if (queued) void api.saveDraft(databaseId, queued);
    },
    [databaseId],
  );

  const publish = useMutation({
    mutationFn: () => api.publish(databaseId, revision),
    onSuccess: async (version) => {
      await queryClient.invalidateQueries({ queryKey: ['database', databaseId] });
      await queryClient.invalidateQueries({ queryKey: ['versions', databaseId] });
      toast.success(`Version ${version.version} is live.`);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === 'stale_draft_revision') {
        const fresh = await api.getDraft(databaseId);
        setRevision(fresh.revision);
        toast.error(`${error.message} The revision has been refreshed, so try again.`);
        return;
      }
      toast.error(
        error instanceof ApiError ? error.message : 'The form could not be published.',
      );
    },
  });

  const problems = draft.data?.problems ?? [];
  const canPublish =
    definition !== null && problems.length === 0 && saveState !== 'pending' && saveState !== 'saving';

  const activePage = useMemo(
    () => definition?.pages.find((page) => page.id === activePageId) ?? definition?.pages[0],
    [definition, activePageId],
  );

  const setPages = (pages: FormPage[]) => update({ pages });

  const addPage = () => {
    if (!definition) return;
    const page: FormPage = { id: newId('page'), elements: [] };
    setPages([...definition.pages, page]);
    setActivePageId(page.id);
  };

  const setPageElements = (pageId: string, elements: FormElement[]) => {
    if (!definition) return;
    setPages(definition.pages.map((page) => (page.id === pageId ? { ...page, elements } : page)));
  };

  return (
    <AppShell
      user={user}
      crumbs={[
        { label: 'Projects', to: '/' },
        {
          label: project.data?.name ?? 'Project',
          ...(database.data ? { to: `/projects/${database.data.projectId}` } : {}),
        },
        { label: database.data?.name ?? 'Feedback database', to: `/databases/${databaseId}` },
        { label: 'Builder' },
      ]}
    >
      <PageHeader
        title="Form builder"
        description="Changes autosave. Publishing creates a new immutable version."
        actions={
          <>
            <SaveIndicator state={saveState} revision={revision} />
            <Button variant="outline" asChild>
              <a href={`/render/${databaseId}`} target="_blank" rel="noreferrer">
                <ExternalLinkIcon />
                Preview
              </a>
            </Button>
            <Button onClick={() => publish.mutate()} disabled={!canPublish || publish.isPending}>
              <UploadIcon />
              {publish.isPending ? 'Publishing' : 'Publish'}
            </Button>
          </>
        }
      />

      {draft.isLoading || definition === null ? (
        <Skeleton className="h-72" />
      ) : draft.error ? (
        <EmptyState
          title="This draft could not be loaded"
          description={draft.error instanceof ApiError ? draft.error.message : 'Try reloading.'}
          action={
            <Button variant="outline" asChild>
              <Link to={`/databases/${databaseId}`}>Back to the feedback database</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
          <PageRail
            pages={definition.pages}
            activePageId={activePage?.id ?? null}
            onSelect={setActivePageId}
            onAdd={addPage}
            onMove={(index, direction) => {
              const pages = [...definition.pages];
              const target = index + direction;
              if (target < 0 || target >= pages.length) return;
              const [moved] = pages.splice(index, 1);
              if (moved) pages.splice(target, 0, moved);
              setPages(pages);
            }}
            onDuplicate={(index) => {
              const source = definition.pages[index];
              if (!source) return;
              const copy: FormPage = {
                id: newId('page'),
                elements: source.elements.map(duplicateElement),
              };
              const pages = [...definition.pages];
              pages.splice(index + 1, 0, copy);
              setPages(pages);
              setActivePageId(copy.id);
            }}
            onRemove={(index) => {
              const pages = definition.pages.filter((_, position) => position !== index);
              setPages(pages);
              setActivePageId(pages[Math.max(0, index - 1)]?.id ?? null);
            }}
          />

          <div className="space-y-4">
            {problems.length > 0 ? (
              <Card className="border-warning/50 bg-warning/5">
                <CardContent className="flex gap-3 p-4">
                  <AlertTriangleIcon
                    className="mt-0.5 size-4 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  <div className="space-y-1 text-sm">
                    <p className="font-medium">This form cannot be published yet</p>
                    <ul className="space-y-0.5 text-muted-foreground">
                      {problems.map((problem, index) => (
                        <li key={`${problem.code}-${index}`}>{problem.message}</li>
                      ))}
                    </ul>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {activePage ? (
              <PageEditor
                page={activePage}
                problems={problems}
                onChange={(elements) => setPageElements(activePage.id, elements)}
              />
            ) : (
              <EmptyState
                icon={<LayersIcon />}
                title="No pages yet"
                description="A form needs at least one page, and each page needs at least one element."
                action={
                  <Button onClick={addPage}>
                    <PlusIcon />
                    Add the first page
                  </Button>
                }
              />
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}

function SaveIndicator({ state, revision }: { state: SaveState; revision: number }) {
  const text: Record<SaveState, string> = {
    idle: `Revision ${revision}`,
    pending: 'Saving',
    saving: 'Saving',
    saved: `Saved as revision ${revision}`,
    error: 'Not saved',
  };
  return (
    <span
      data-testid="save-state"
      data-state={state}
      className={cn(
        'inline-flex items-center gap-1.5 text-xs',
        state === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {state === 'saved' ? <CheckIcon className="size-3.5 text-success" /> : null}
      {text[state]}
    </span>
  );
}

function PageRail({
  pages,
  activePageId,
  onSelect,
  onAdd,
  onMove,
  onDuplicate,
  onRemove,
}: {
  pages: FormPage[];
  activePageId: string | null;
  onSelect: (pageId: string) => void;
  onAdd: () => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="space-y-2 lg:sticky lg:top-20 lg:self-start">
      <p className="px-1 text-xs font-medium text-muted-foreground">Pages</p>
      <ul className="space-y-1">
        {pages.map((page, index) => (
          <li key={page.id}>
            <div
              className={cn(
                'flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm transition-colors',
                page.id === activePageId
                  ? 'border-primary/50 bg-primary/8'
                  : 'border-transparent hover:bg-accent',
              )}
            >
              {/* Two lines, so a page's element count never wraps mid-phrase. */}
              <button
                type="button"
                className="min-w-0 flex-1 truncate py-0.5 text-left leading-tight"
                aria-current={page.id === activePageId}
                onClick={() => onSelect(page.id)}
              >
                <span className="block font-medium">Page {index + 1}</span>
                <span className="block text-xs text-muted-foreground">
                  {pluralize(page.elements.length, 'element')}
                </span>
              </button>

              <div className="flex items-center">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move page ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => onMove(index, -1)}
                >
                  <ChevronUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move page ${index + 1} down`}
                  disabled={index === pages.length - 1}
                  onClick={() => onMove(index, 1)}
                >
                  <ChevronDownIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Duplicate page ${index + 1}`}
                  onClick={() => onDuplicate(index)}
                >
                  <CopyIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove page ${index + 1}`}
                  className="hover:text-destructive"
                  onClick={() => onRemove(index)}
                >
                  <TrashIcon />
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <Button variant="outline" size="sm" className="w-full" onClick={onAdd}>
        <PlusIcon />
        Add page
      </Button>
    </div>
  );
}

const ADDABLE: { type: FormElement['type']; label: string; icon: typeof TypeIcon }[] = [
  { type: 'choice', label: 'Multiple choice', icon: ListIcon },
  { type: 'text', label: 'Free text', icon: TextIcon },
  { type: 'email', label: 'Email', icon: MailIcon },
  { type: 'screenshot', label: 'Screenshot', icon: ImageIcon },
  { type: 'title', label: 'Title', icon: TypeIcon },
  { type: 'subtitle', label: 'Subtitle', icon: TypeIcon },
  { type: 'body_text', label: 'Body text', icon: FileTextIcon },
];

function PageEditor({
  page,
  problems,
  onChange,
}: {
  page: FormPage;
  problems: { path?: string; code: string; message: string }[];
  onChange: (elements: FormElement[]) => void;
}) {
  const add = (type: FormElement['type']) => onChange([...page.elements, newElement(type)]);

  /** Problems the server reported for a specific element, matched on its ID. */
  const problemsFor = (elementId: string): string[] =>
    problems.filter((problem) => problem.message.includes(elementId)).map((p) => p.message);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Content and questions in one ordered list, so text can sit before, between or after
          questions.
        </p>
        <AddElementMenu onAdd={add} />
      </div>

      {page.elements.length === 0 ? (
        <EmptyState
          icon={<ListIcon />}
          title="This page is empty"
          description="Add a question, or a title to introduce the page."
          action={<AddElementMenu onAdd={add} />}
        />
      ) : (
        <ul className="space-y-3">
          {page.elements.map((element, index) => (
            <li key={element.id}>
              <ElementEditor
                element={element}
                index={index}
                count={page.elements.length}
                problems={problemsFor(element.id)}
                onChange={(next) =>
                  onChange(
                    page.elements.map((candidate, position) =>
                      position === index ? next : candidate,
                    ),
                  )
                }
                onMove={(direction) => {
                  const elements = [...page.elements];
                  const target = index + direction;
                  if (target < 0 || target >= elements.length) return;
                  const [moved] = elements.splice(index, 1);
                  if (moved) elements.splice(target, 0, moved);
                  onChange(elements);
                }}
                onDuplicate={() => {
                  const elements = [...page.elements];
                  elements.splice(index + 1, 0, duplicateElement(element));
                  onChange(elements);
                }}
                onRemove={() =>
                  onChange(page.elements.filter((_, position) => position !== index))
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddElementMenu({ onAdd }: { onAdd: (type: FormElement['type']) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" data-testid="add-element">
          <PlusIcon />
          Add element
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Questions</DropdownMenuLabel>
        {ADDABLE.slice(0, 4).map(({ type, label, icon: Icon }) => (
          <DropdownMenuItem key={type} onSelect={() => onAdd(type)} data-testid={`add-${type}`}>
            <Icon />
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Content</DropdownMenuLabel>
        {ADDABLE.slice(4).map(({ type, label, icon: Icon }) => (
          <DropdownMenuItem key={type} onSelect={() => onAdd(type)} data-testid={`add-${type}`}>
            <Icon />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
