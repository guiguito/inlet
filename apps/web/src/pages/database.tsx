import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  InboxIcon,
  Link2Icon,
  PencilRulerIcon,
  RotateCcwIcon,
  TrashIcon,
  UploadIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { FormDefinition } from '@inlet/shared';
import { api, ApiError, type CurrentUser, type FormVersion, type SubmissionFilter, type SubmissionSummary } from '@/lib/api';
import { AccessPanel } from '@/components/access-panel';
import { AppShell } from '@/components/app-shell';
import { answerSummary } from '@/components/answer-view';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyField } from '@/components/copy-field';
import { DatabaseSwitcher } from '@/components/database-switcher';
import { NotifyPanel } from '@/components/notify-panel';
import { SharePanel } from '@/components/share-panel';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDateTime, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * One feedback database: its responses, how to integrate it, its published versions,
 * and its settings (FR-021 to FR-025, FR-042E to FR-042G, FR-063, FR-110).
 */
/**
 * FR-186, FR-186A, FR-187: the tabs, and where the seven this page used to have went.
 *
 * Four of the seven were configuration, which made the row of tabs a settings menu
 * with the actual work hidden at one end. Integrate, Share and Notify are all "how
 * feedback gets here", so they became Collect; Access and the rest are administration,
 * so they became Settings. Versions is what the form has looked like, which is Form.
 */
const TABS = [
  { value: 'responses', label: 'Responses' },
  { value: 'form', label: 'Form' },
  {
    value: 'collect',
    label: 'Collect',
    // Both are ways feedback gets in. Slack is not: it is how a response gets out
    // again once collected, which makes it a setting rather than a channel.
    panels: [
      { value: 'app', label: 'Your app' },
      { value: 'link', label: 'A shared link' },
    ],
  },
  {
    value: 'settings',
    label: 'Settings',
    // General leads because a tab's first panel is what a bare `?tab=settings`
    // opens, and that address meant the name-and-delete panel before this
    // regrouping. Changing what an existing address opens is the one thing the
    // regrouping is not allowed to do.
    panels: [
      { value: 'general', label: 'General' },
      { value: 'notifications', label: 'Notifications' },
      { value: 'access', label: 'Access' },
    ],
  },
] as const;

/** The panels of a grouped tab, or none for a tab that is a single panel. */
function panelsFor(tab: string): readonly { value: string; label: string }[] {
  const entry = TABS.find((candidate) => candidate.value === tab);
  return entry && 'panels' in entry ? entry.panels : [];
}

/**
 * Where a link written against the old seven tabs now lands. Kept rather than dropped
 * because these addresses are in people's bookmarks, in Slack, and in the docs — and
 * each one resolves to the exact panel it used to open, not just the group.
 */
const MOVED_TABS: Record<string, { tab: string; panel?: string }> = {
  integrate: { tab: 'collect', panel: 'app' },
  share: { tab: 'collect', panel: 'link' },
  notify: { tab: 'settings', panel: 'notifications' },
  versions: { tab: 'form' },
  access: { tab: 'settings', panel: 'access' },
};

export function DatabasePage({ user }: { user: CurrentUser }) {
  const { databaseId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') ?? 'responses';
  const moved = MOVED_TABS[requested];
  const tab = moved?.tab ?? requested;
  // A panel belongs to one tab, so a stale or foreign panel falls back to the first
  // panel of the tab actually being shown rather than rendering nothing.
  const panels = panelsFor(tab);
  const requestedPanel = params.get('panel') ?? moved?.panel;
  const panel =
    panels.find((entry) => entry.value === requestedPanel)?.value ?? panels[0]?.value ?? '';

  const show = (nextTab: string, nextPanel?: string) => {
    if (nextTab === 'responses') return setParams({});
    return setParams({ tab: nextTab, ...(nextPanel ? { panel: nextPanel } : {}) });
  };

  const database = useQuery({
    queryKey: ['database', databaseId],
    queryFn: () => api.getDatabase(databaseId),
  });

  // The database response carries only its project's ID, so the project is fetched to
  // name it in the switcher.
  const project = useQuery({
    queryKey: ['project', database.data?.projectId],
    queryFn: () => api.getProject(database.data?.projectId ?? ''),
    enabled: Boolean(database.data?.projectId),
  });

  // An old address is rewritten rather than merely honoured, so a reader who bookmarks
  // it again gets the tab that exists.
  useEffect(() => {
    const target = MOVED_TABS[requested];
    if (!target) return;
    setParams(
      { tab: target.tab, ...(target.panel ? { panel: target.panel } : {}) },
      { replace: true },
    );
  }, [requested, setParams]);

  return (
    <AppShell
      user={user}
      crumbs={[{ label: 'Projects', to: '/' }, { label: database.data?.name ?? 'Feedback database' }]}
      {...(database.data
        ? {
            context: (
              <DatabaseSwitcher
                projectId={database.data.projectId}
                projectName={project.data?.name ?? 'Project'}
                databaseId={databaseId}
                databaseName={database.data.name}
              />
            ),
          }
        : {})}
    >
      {database.isLoading ? (
        <Skeleton className="h-64" />
      ) : database.error ? (
        <EmptyState
          title="This feedback database could not be loaded"
          description={
            database.error instanceof ApiError
              ? database.error.message
              : 'Try reloading the page.'
          }
          action={
            <Button variant="outline" asChild>
              <Link to="/">Back to projects</Link>
            </Button>
          }
        />
      ) : database.data ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold tracking-tight">{database.data.name}</h1>
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                {database.data.activeFormVersion === null ? (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground/50" />
                      Not collecting
                    </span>
                    <span aria-hidden="true" className="text-border">
                      ·
                    </span>
                    <span>No published version</span>
                  </>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
                      Collecting
                    </span>
                    <span aria-hidden="true" className="text-border">
                      ·
                    </span>
                    <span className="numeric">Version {database.data.activeFormVersion} live</span>
                  </>
                )}
                <span aria-hidden="true" className="text-border">
                  ·
                </span>
                <span className="numeric">
                  {pluralize(database.data.submissionCount, 'response')}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" asChild>
                <Link to={`/databases/${databaseId}/builder`}>
                  <PencilRulerIcon />
                  Open the builder
                </Link>
              </Button>
              <Button onClick={() => show('collect', 'link')}>
                <Link2Icon />
                Share the form
              </Button>
            </div>
          </div>

          <Tabs className="mt-6" value={tab} onValueChange={(next) => show(next)}>
            <TabsList>
              {TABS.map((entry) => (
                <TabsTrigger key={entry.value} value={entry.value}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="responses">
              <ResponsesTab databaseId={databaseId} />
            </TabsContent>

            <TabsContent value="form">
              <VersionsTab databaseId={databaseId} />
            </TabsContent>

            {/* One panel at a time in both grouped tabs: each saves on its own, and
                several Save buttons down one page is the confusion this regrouping was
                meant to remove rather than move. */}
            <TabsContent value="collect">
              <PanelTabs tab="collect" panel={panel} show={show}>
                <TabsContent value="app">
                  <IntegrateTab databaseId={databaseId} projectId={database.data.projectId} />
                </TabsContent>
                <TabsContent value="link">
                  <SharePanel databaseId={databaseId} />
                </TabsContent>
              </PanelTabs>
            </TabsContent>

            <TabsContent value="settings">
              <PanelTabs tab="settings" panel={panel} show={show}>
                <TabsContent value="access">
                  <AccessPanel
                    scope={{
                      kind: 'feedbackDatabase',
                      databaseId,
                      name: database.data.name,
                    }}
                    currentUserId={user.id}
                  />
                </TabsContent>
                <TabsContent value="notifications">
                  <NotifyPanel databaseId={databaseId} />
                </TabsContent>
                <TabsContent value="general">
                  <SettingsTab
                    databaseId={databaseId}
                    projectId={database.data.projectId}
                    name={database.data.name}
                  />
                </TabsContent>
              </PanelTabs>
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </AppShell>
  );
}

/** The sub-navigation of a grouped tab, driven by the same `panel` search parameter. */
function PanelTabs({
  tab,
  panel,
  show,
  children,
}: {
  tab: string;
  panel: string;
  show: (tab: string, panel?: string) => void;
  children: React.ReactNode;
}) {
  return (
    <Tabs value={panel} onValueChange={(next) => show(tab, next)}>
      <TabsList>
        {panelsFor(tab).map((entry) => (
          <TabsTrigger key={entry.value} value={entry.value}>
            {entry.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  );
}

/**
 * FR-063, FR-173 to FR-185: the responses list.
 *
 * The response is the content, so it gets the reading position: the rating it chose as
 * a chip, what it typed at reading size, the screenshot as a thumbnail rather than a
 * number, and a dot against whatever arrived since this reader last looked. It replaced
 * a table whose widest column was a truncated grey line between a date and two counters.
 */
function ResponsesTab({ databaseId }: { databaseId: string }) {
  const [filter, setFilter] = useState<SubmissionFilter>('all');
  const [formVersion, setFormVersion] = useState<number | undefined>(undefined);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const versions = useQuery({
    queryKey: ['versions', databaseId],
    queryFn: () => api.listVersions(databaseId),
  });
  const page = useQuery({
    queryKey: ['submissions', databaseId, filter, formVersion ?? 'any', cursor ?? 'first'],
    queryFn: () =>
      api.listSubmissions(databaseId, {
        limit: 25,
        filter,
        ...(cursor ? { cursor } : {}),
        ...(formVersion === undefined ? {} : { formVersion }),
      }),
  });

  /**
   * FR-185: the unread boundary is frozen at whatever the first load reported, so
   * narrowing the list or paging through it does not move the dots under the reader.
   */
  const [unread, setUnread] = useState<{ since: string | null; count: number } | null>(null);
  useEffect(() => {
    setUnread((current) => current ?? page.data?.unread ?? null);
  }, [page.data]);

  /**
   * Leaving marks the list read, not arriving. Marking on arrival would clear the dots
   * in the same breath as drawing them, and would leave the unread filter with nothing
   * to select for the rest of the visit.
   */
  useEffect(() => {
    return () => {
      void api.markSubmissionsSeen(databaseId).catch(() => {
        // A marker that failed to move costs a reader one stale dot. Not worth a toast.
      });
    };
  }, [databaseId]);

  const definitionFor = (version: number) =>
    versions.data?.find((candidate) => candidate.version === version)?.definition;

  const narrow = (next: SubmissionFilter) => {
    setFilter(next);
    setCursor(undefined);
  };
  const onlyVersion = (next: number | undefined) => {
    setFormVersion(next);
    setCursor(undefined);
  };

  if (page.error) {
    return (
      <EmptyState
        title="Responses could not be loaded"
        description={page.error instanceof ApiError ? page.error.message : 'Try reloading.'}
      />
    );
  }

  const showing = page.data?.submissions ?? [];
  const unfiltered = filter === 'all' && formVersion === undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1" data-testid="response-filters">
          <FilterChip active={filter === 'all'} onClick={() => narrow('all')}>
            All
          </FilterChip>
          <FilterChip active={filter === 'unread'} onClick={() => narrow('unread')}>
            Unread
            {unread && unread.count > 0 ? (
              <span className="numeric font-normal text-muted-foreground">{unread.count}</span>
            ) : null}
          </FilterChip>
          <FilterChip active={filter === 'screenshots'} onClick={() => narrow('screenshots')}>
            With screenshots
          </FilterChip>
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="text-[13px]">
                {formVersion === undefined ? 'All versions' : `Version ${formVersion}`}
                <ChevronDownIcon className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onlyVersion(undefined)}>
                All versions
              </DropdownMenuItem>
              {versions.data?.map((version) => (
                <DropdownMenuItem
                  key={version.version}
                  onSelect={() => onlyVersion(version.version)}
                >
                  Version {version.version}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Exporting stays two plain buttons. A menu would save a little width and
              cost a click on the thing people come here to do. */}
          <Button variant="outline" size="sm" className="text-[13px]" asChild>
            <a href={api.exportUrl(databaseId, 'json')} download>
              <DownloadIcon />
              Export JSON
            </a>
          </Button>
          <Button variant="outline" size="sm" className="text-[13px]" asChild>
            <a href={api.exportUrl(databaseId, 'csv')} download>
              <DownloadIcon />
              Export CSV
            </a>
          </Button>
        </div>
      </div>

      {page.isLoading ? (
        <Skeleton className="h-48" />
      ) : showing.length === 0 ? (
        <EmptyState
          icon={<InboxIcon />}
          title={unfiltered ? 'No responses yet' : 'Nothing matches that'}
          description={
            unfiltered
              ? 'Publish the form and point your app at this feedback database, or share its link. Responses appear here as they arrive.'
              : 'Widen the filters to see the rest.'
          }
          {...(unfiltered
            ? {}
            : {
                action: (
                  <Button
                    variant="outline"
                    onClick={() => {
                      narrow('all');
                      onlyVersion(undefined);
                    }}
                  >
                    Show everything
                  </Button>
                ),
              })}
        />
      ) : (
        <ul className="divide-y" data-testid="response-list">
          {showing.map((submission) => (
            <ResponseRow
              key={submission.id}
              databaseId={databaseId}
              submission={submission}
              definition={definitionFor(submission.formVersion)}
              unread={Boolean(unread?.since && submission.createdAt > unread.since)}
            />
          ))}
        </ul>
      )}

      {page.data && showing.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="numeric text-[13px] text-muted-foreground">
            Showing {showing.length} of {page.data.total}
          </p>
          <div className="flex gap-2">
            {cursor ? (
              <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
                Back to the newest
              </Button>
            ) : null}
            {page.data.nextCursor ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCursor(page.data.nextCursor ?? undefined)}
              >
                Load more
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function ResponseRow({
  databaseId,
  submission,
  definition,
  unread,
}: {
  databaseId: string;
  submission: SubmissionSummary;
  definition: FormDefinition | undefined;
  unread: boolean;
}) {
  const { chip, text } = answerSummary(definition, submission.answers);

  return (
    <li>
      <Link
        to={`/databases/${databaseId}/submissions/${submission.id}`}
        className="flex items-center gap-3.5 rounded-md px-3 py-3 transition-colors hover:bg-muted/50"
      >
        {/* The dot is decoration; the state it stands for is announced as text, since
            a screen reader gets nothing from a coloured circle. */}
        {unread ? <span className="sr-only">Unread. </span> : null}
        <span
          aria-hidden="true"
          className={cn('size-1.5 shrink-0 rounded-full', unread ? 'bg-primary' : 'bg-transparent')}
        />

        {chip ? (
          <Badge variant="default" className="shrink-0 gap-1.5 px-2.5 py-1">
            {chip.emoji ? <span aria-hidden="true">{chip.emoji}</span> : null}
            {chip.label}
          </Badge>
        ) : null}

        <p
          className={cn(
            'min-w-0 flex-1 truncate text-[15px]',
            unread ? 'font-medium' : 'font-normal',
          )}
        >
          {text || <span className="text-muted-foreground">Open the response</span>}
        </p>

        {submission.firstAttachmentId ? (
          <span className="flex w-[74px] shrink-0 items-center gap-1.5">
            <img
              // Twice the rendered width, so it stays sharp on a dense display and
              // still costs a fraction of the stored screenshot.
              src={api.attachmentPath(submission.firstAttachmentId, 88)}
              alt=""
              width={44}
              height={30}
              loading="lazy"
              className="h-[30px] w-11 rounded-md border bg-muted object-cover"
            />
            {submission.attachmentCount > 1 ? (
              <span className="numeric text-xs text-muted-foreground">
                ×{submission.attachmentCount}
              </span>
            ) : null}
          </span>
        ) : (
          <span aria-hidden="true" className="w-[74px] shrink-0" />
        )}

        <span className="numeric w-32 shrink-0 whitespace-nowrap text-right text-[13px] text-muted-foreground">
          {formatDateTime(submission.createdAt)}
        </span>
      </Link>
    </li>
  );
}

function IntegrateTab({ databaseId, projectId }: { databaseId: string; projectId: string }) {
  const credentials = useQuery({
    queryKey: ['credentials', projectId],
    queryFn: () => api.listCredentials(projectId),
  });

  const publishable = credentials.data?.find(
    (credential) => credential.type === 'publishable' && !credential.revokedAt,
  );
  const key = publishable?.key ?? 'ipk_your_publishable_client_key';
  const origin = window.location.origin;

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>What your app needs</CardTitle>
          <CardDescription>
            A publishable client key and this feedback database ID. Both are safe in a browser or
            mobile app.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyField label="Feedback database ID" value={databaseId} />
          {publishable?.key ? (
            <CopyField label={`Publishable client key (${publishable.label})`} value={publishable.key} />
          ) : (
            <div className="space-y-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              <p>This project has no publishable client key yet.</p>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/projects/${projectId}`}>Create one in API keys</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Collect with the SDK</CardTitle>
          <CardDescription>
            The inlet-sdk package drives the four calls for you and hands your interface a
            snapshot to draw. It ships no components, so the form looks like your application.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
{`npm install inlet-sdk

import * as feedback from 'inlet-sdk/feedback/browser';

feedback.init({
  baseUrl: '${origin}',
  publishableKey: '${key}',
  feedbackDatabaseId: '${databaseId}',
});

const session = await feedback.createSession();
if (session.ok) {
  const form = session.value;      // subscribe(), getSnapshot(), and the actions
  form.setAnswer(questionId, { value: 'It works' });
  form.next();                     // validates with this server's own rules
  await form.submit();             // retried safely if the network drops
}`}
          </pre>
          <p className="text-xs text-muted-foreground">
            Node, Electron, React and React Native entries exist too; on React Native, import{' '}
            <code className="font-mono">inlet-sdk/feedback/react-native</code> and pass{' '}
            <code className="font-mono">storage: AsyncStorage</code>. Your application does not have
            to share an origin with this server.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Collect with the API</CardTitle>
          <CardDescription>
            The same four calls by hand, for a language or a runtime the SDK does not cover. Read
            the form, open an intent, attach any screenshots, then submit everything at once.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
{`BASE=${origin}
KEY=${key}
DB=${databaseId}

# 1. Read the published form
curl -s "$BASE/v1/feedback-databases/$DB/form" \\
  -H "Authorization: Bearer $KEY"

# 2. Open a submission intent
curl -s -X POST "$BASE/v1/feedback-databases/$DB/submission-intents" \\
  -H "Authorization: Bearer $KEY"

# 3. Attach a screenshot (optional)
curl -s -X POST "$BASE/v1/feedback-databases/$DB/submission-intents/$INTENT/attachments" \\
  -H "Authorization: Bearer $KEY" \\
  -H "X-Inlet-Intent-Token: $TOKEN" \\
  -F questionId=el_xxxxxxxxxxxx -F file=@screenshot.png

# 4. Submit
curl -s -X POST "$BASE/v1/feedback-databases/$DB/submission-intents/$INTENT/submit" \\
  -H "Authorization: Bearer $KEY" \\
  -H "X-Inlet-Intent-Token: $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"formVersion":1,"answers":{"el_xxxxxxxxxxxx":{"value":"It works"}}}'`}
          </pre>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href="/docs" target="_blank" rel="noreferrer">
                <ExternalLinkIcon />
                Full API reference
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a
                href={`/render/${databaseId}${publishable?.key ? `?key=${encodeURIComponent(publishable.key)}` : ''}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLinkIcon />
                Try the reference renderer
              </a>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The reference renderer is an unbranded, themeable form that runs the whole client flow
            against this API. Use it to check a form before you write any client code.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function VersionsTab({ databaseId }: { databaseId: string }) {
  const queryClient = useQueryClient();
  const versions = useQuery({
    queryKey: ['versions', databaseId],
    queryFn: () => api.listVersions(databaseId),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['versions', databaseId] });
    await queryClient.invalidateQueries({ queryKey: ['database', databaseId] });
  };

  const unpublish = useMutation({
    mutationFn: () => api.unpublish(databaseId),
    onSuccess: async () => {
      await refresh();
      toast.success('The form is unpublished. New submissions are blocked.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'The form could not be unpublished.'),
  });

  const rollback = useMutation({
    mutationFn: (version: number) => api.rollback(databaseId, version),
    onSuccess: async (version) => {
      await refresh();
      toast.success(`Version ${version.version} is active again.`);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'The rollback did not complete.'),
  });

  if (versions.isLoading) return <Skeleton className="h-40" />;

  if (!versions.data || versions.data.length === 0) {
    return (
      <EmptyState
        icon={<UploadIcon />}
        title="Nothing published yet"
        description="Build the form, then publish it to create version 1."
        action={
          <Button variant="outline" asChild>
            <Link to={`/databases/${databaseId}/builder`}>Open the builder</Link>
          </Button>
        }
      />
    );
  }

  const active = versions.data.find((version) => version.active);

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Published versions are immutable. Submissions keep the version they were made against, so
        older responses stay readable exactly as they were answered.
      </p>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Version</TableHead>
              <TableHead>Published</TableHead>
              <TableHead>Shape</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.data.map((version) => (
              <TableRow key={version.id} data-testid={`version-${version.version}`}>
                <TableCell className="numeric font-medium">
                  {version.version}
                  {version.active ? (
                    <Badge variant="primary" className="ml-2">
                      Active
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="numeric text-muted-foreground">
                  {formatDateTime(version.publishedAt)}
                </TableCell>
                <TableCell className="text-muted-foreground">{describeVersion(version)}</TableCell>
                <TableCell className="text-right">
                  {version.active ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={rollback.isPending}
                      onClick={() => rollback.mutate(version.version)}
                    >
                      <RotateCcwIcon />
                      Make active
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {active ? (
        <Card>
          <CardHeader>
            <CardTitle>Stop collecting</CardTitle>
            <CardDescription>
              Unpublishing blocks new submissions and hides the form from clients. Versions and
              existing responses are untouched, and any submission already in progress still
              completes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => unpublish.mutate()} disabled={unpublish.isPending}>
              Unpublish version {active.version}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function describeVersion(version: FormVersion): string {
  const pages = version.definition.pages.length;
  const questions = version.definition.pages
    .flatMap((page) => page.elements)
    .filter((element) =>
      ['choice', 'text', 'email', 'screenshot'].includes(element.type),
    ).length;
  return `${pluralize(pages, 'page')}, ${pluralize(questions, 'question')}`;
}

function SettingsTab({
  databaseId,
  projectId,
  name,
}: {
  databaseId: string;
  projectId: string;
  name: string;
}) {
  const [draftName, setDraftName] = useState(name);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const impact = useQuery({
    queryKey: ['deletion-impact', databaseId],
    queryFn: () => api.deletionImpact(databaseId),
    enabled: deleting,
  });

  const rename = useMutation({
    mutationFn: () => api.renameDatabase(databaseId, draftName.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['database', databaseId] });
      await queryClient.invalidateQueries({ queryKey: ['databases', projectId] });
      toast.success('Feedback database renamed.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'The rename did not complete.'),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteDatabase(databaseId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['databases', projectId] });
      toast.success('Feedback database deleted.');
      await navigate(`/projects/${projectId}`, { replace: true });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'The deletion did not complete.'),
  });

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Name</CardTitle>
          <CardDescription>
            The feedback database ID never changes, so renaming is safe for integrated clients.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              rename.mutate();
            }}
          >
            <Input
              value={draftName}
              maxLength={200}
              aria-label="Feedback database name"
              onChange={(event) => setDraftName(event.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={rename.isPending || draftName.trim() === name || draftName.trim() === ''}
            >
              Save
            </Button>
          </form>
          <CopyField label="Feedback database ID" value={databaseId} />
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Delete this feedback database</CardTitle>
          <CardDescription>
            This removes the form, every published version, every response and every screenshot.
            It cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => setDeleting(true)}>
            <TrashIcon />
            Delete feedback database
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${name}`}
        confirmText={name}
        confirmLabel="Delete feedback database"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        description={
          impact.data ? (
            <>
              <p>
                This deletes {pluralize(impact.data.submissions, 'response')} and{' '}
                {pluralize(impact.data.attachments, 'screenshot')}.
              </p>
              <p>{impact.data.notice}</p>
            </>
          ) : (
            <p>Counting what would be deleted.</p>
          )
        }
      >
        {impact.data && impact.data.submissions > 0 ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={api.exportUrl(databaseId, 'json')} download>
                <DownloadIcon />
                Export JSON first
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={api.exportUrl(databaseId, 'csv')} download>
                <DownloadIcon />
                Export CSV first
              </a>
            </Button>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
