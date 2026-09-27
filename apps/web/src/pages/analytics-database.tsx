import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PauseIcon, PlayIcon, SendIcon, TrashIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type AnalyticsLiveEvent, type CurrentUser } from '@/lib/api';
import { ANALYTICS_CONSENT_NOTE, analyticsSnippets } from '@/lib/analytics-snippets';
import { AccessPanel } from '@/components/access-panel';
import { EventsPanel } from '@/components/analytics-events';
import { AppShell } from '@/components/app-shell';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyField } from '@/components/copy-field';
import { DatabaseSwitcher } from '@/components/database-switcher';
import { EmptyState } from '@/components/empty-state';
import { NotifyPanel } from '@/components/notify-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { pluralize } from '@/lib/format';

/**
 * One analytics database (UX Analytics PRD section 8.1): Insights (Overview, Events,
 * Funnels, Cohorts), Users, Collect and Settings (General, Storage, Notifications, Access).
 * It opens on Insights → Overview. Piece 2 builds the shell and Settings, piece 3 Collect, piece
 * 4 Events; the other panels say what they will hold until the pieces that build them replace them.
 */
const TABS = [
  {
    value: 'insights',
    label: 'Insights',
    panels: [
      { value: 'overview', label: 'Overview' },
      { value: 'events', label: 'Events' },
      { value: 'funnels', label: 'Funnels' },
      { value: 'cohorts', label: 'Cohorts' },
    ],
  },
  { value: 'users', label: 'Users', panels: [] },
  { value: 'collect', label: 'Collect', panels: [] },
  {
    value: 'settings',
    label: 'Settings',
    panels: [
      { value: 'general', label: 'General' },
      { value: 'storage', label: 'Storage' },
      { value: 'notifications', label: 'Notifications' },
      { value: 'access', label: 'Access' },
    ],
  },
] as const;

/** What each panel not yet built will show, in one sentence. */
const COMING: Record<string, string> = {
  overview: 'Active installations, sessions, retention and crash-free sessions will appear here.',
  funnels: 'Funnels will appear here.',
  cohorts: 'Cohorts, the standard Retention cohort first, will appear here.',
  users: 'Installation and user profiles will appear here.',
  storage: 'The storage settings, usage and data health will appear here.',
};

/** UX Analytics 8.1: every analytics screen says so, in one sentence, and the rest of Inlet works. */
export const EVENT_STORE_UNREACHABLE =
  'The analytics event store is unreachable, so this database cannot be read or collect events for now; the rest of Inlet works as usual.';

export function AnalyticsDatabasePage({ user }: { user: CurrentUser }) {
  const { databaseId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((entry) => entry.value === params.get('tab')) ?? TABS[0];
  const panel = tab.panels.find((entry) => entry.value === params.get('panel'))?.value ?? tab.panels[0]?.value;
  const show = (nextTab: string, nextPanel?: string) => setParams({ tab: nextTab, ...(nextPanel ? { panel: nextPanel } : {}) });
  // The caller's effective role decides which Lexicon actions the Events panel offers; the
  // API enforces it either way.
  const members = useQuery({ queryKey: ['members', 'analyticsDatabase', databaseId], queryFn: () => api.listDatabaseMembers(databaseId) });
  const role = members.data?.find((member) => member.userId === user.id)?.effectiveRole;

  const database = useQuery({ queryKey: ['analytics-database', databaseId], queryFn: () => api.getAnalyticsDatabase(databaseId) });
  const project = useQuery({
    queryKey: ['project', database.data?.projectId],
    queryFn: () => api.getProject(database.data!.projectId),
    enabled: Boolean(database.data),
  });

  const placeholder = (key: string) => <EmptyState className="mt-4" title="Not here yet" description={COMING[key]} />;

  return (
    <AppShell
      user={user}
      crumbs={[{ label: 'Projects', to: '/' }, { label: database.data?.name ?? 'Analytics database' }]}
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
          title="This analytics database could not be loaded"
          description={database.error instanceof ApiError ? database.error.message : 'Try reloading the page.'}
          action={
            <Button variant="outline" asChild>
              <Link to="/">Back to projects</Link>
            </Button>
          }
        />
      ) : database.data ? (
        <>
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">{database.data.name}</h1>
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
              <Badge variant="outline">Analytics</Badge>
              <span>{database.data.timezone}</span>
            </div>
          </div>
          {database.data.eventStore === 'unavailable' ? (
            <p role="status" data-testid="event-store-unreachable" className="mt-4 rounded-md border border-destructive/40 px-3 py-2 text-sm">
              {EVENT_STORE_UNREACHABLE}
            </p>
          ) : null}

          <Tabs className="mt-6" value={tab.value} onValueChange={(next) => show(next)}>
            <TabsList>
              {TABS.map((entry) => (
                <TabsTrigger key={entry.value} value={entry.value}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {TABS.map((entry) => (
              <TabsContent key={entry.value} value={entry.value}>
                {entry.value === 'collect' ? (
                  <CollectPanel databaseId={databaseId} projectId={database.data.projectId} />
                ) : entry.panels.length === 0 ? (
                  placeholder(entry.value)
                ) : (
                  <Tabs value={panel ?? entry.panels[0].value} onValueChange={(next) => show(entry.value, next)}>
                    <TabsList>
                      {entry.panels.map((sub) => (
                        <TabsTrigger key={sub.value} value={sub.value}>
                          {sub.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                    {entry.panels.map((sub) => (
                      <TabsContent key={sub.value} value={sub.value}>
                        {sub.value === 'events' ? (
                          <EventsPanel databaseId={databaseId} role={role} unreachable={EVENT_STORE_UNREACHABLE} />
                        ) : sub.value === 'general' ? (
                          <GeneralSettings database={database.data} userId={user.id} />
                        ) : sub.value === 'notifications' ? (
                          <NotifyPanel databaseId={databaseId} hideContentLevel />
                        ) : sub.value === 'access' ? (
                          <AccessPanel scope={{ kind: 'analyticsDatabase', databaseId, name: database.data.name }} currentUserId={user.id} />
                        ) : (
                          placeholder(sub.value)
                        )}
                      </TabsContent>
                    ))}
                  </Tabs>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </>
      ) : null}
    </AppShell>
  );
}

function GeneralSettings({
  database,
  userId,
}: {
  database: { id: string; projectId: string; name: string; timezone: string; countryDerivation: boolean };
  userId: string;
}) {
  const [draftName, setDraftName] = useState(database.name);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // AN-003: only a database or project Admin switches country derivation; the member list
  // carries the caller's effective role, as the access panel reads it.
  const members = useQuery({ queryKey: ['members', 'analyticsDatabase', database.id], queryFn: () => api.listDatabaseMembers(database.id) });
  const isAdmin = members.data?.find((member) => member.userId === userId)?.effectiveRole === 'admin';
  const impact = useQuery({ queryKey: ['analytics-deletion-impact', database.id], queryFn: () => api.analyticsDeletionImpact(database.id), enabled: deleting });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['analytics-database', database.id] });
    await queryClient.invalidateQueries({ queryKey: ['analytics-databases', database.projectId] });
  };
  const update = useMutation({
    mutationFn: (patch: { name?: string; countryDerivation?: boolean }) => api.updateAnalyticsDatabase(database.id, patch),
    onSuccess: async (_, patch) => {
      await refresh();
      toast.success(patch.name !== undefined ? 'Analytics database renamed.' : patch.countryDerivation ? 'Country derivation is on.' : 'Country derivation is off.');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The change did not complete.'),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAnalyticsDatabase(database.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['analytics-databases', database.projectId] });
      toast.success('Analytics database deleted.');
      await navigate(`/projects/${database.projectId}`, { replace: true });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The deletion did not complete.'),
  });

  const count = (value: number | null, noun: string) => (value === null ? `an unknown number of ${noun}s` : pluralize(value, noun));

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Name</CardTitle>
          <CardDescription>The identifier never changes, so an integrated application keeps sending events.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate({ name: draftName.trim() });
            }}
          >
            <Input value={draftName} maxLength={200} aria-label="Name" onChange={(event) => setDraftName(event.target.value)} />
            <Button type="submit" disabled={update.isPending || draftName.trim() === '' || draftName.trim() === database.name}>
              Rename
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reporting timezone</CardTitle>
          <CardDescription>
            Every day, week, month and year is counted in {database.timezone}. It cannot change, because each stored event
            already carries its day in this zone; to report in another zone, create another analytics database.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-sm" data-testid="reporting-timezone">
            {database.timezone}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Country</CardTitle>
          <CardDescription>
            When this is on, each event received gets the country its request came from. The address is used for the lookup
            and never stored. Turning it off applies to events received from now on; stored countries stay.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              id="country-derivation"
              checked={database.countryDerivation}
              disabled={!isAdmin || update.isPending}
              onCheckedChange={(checked) => update.mutate({ countryDerivation: checked })}
            />
            <Label htmlFor="country-derivation">Derive the country of each event</Label>
          </div>
          {members.data && !isAdmin ? <p className="text-[13px] text-muted-foreground">Only an Admin can change this.</p> : null}
          <p className="text-[13px] text-muted-foreground">
            IP to country data by{' '}
            <a className="underline" href="https://db-ip.com" target="_blank" rel="noreferrer">
              DB-IP (db-ip.com)
            </a>
            , CC BY 4.0
          </p>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Delete this analytics database</CardTitle>
          <CardDescription>Every event, installation, funnel and cohort goes with it.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => setDeleting(true)}>
            <TrashIcon />
            Delete
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${database.name}?`}
        confirmText={database.name}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        description={
          impact.data ? (
            <>
              <p>
                This deletes{' '}
                <strong className="text-foreground numeric">{count(impact.data.events, 'event')}</strong>,{' '}
                <strong className="text-foreground numeric">{count(impact.data.installations, 'installation')}</strong>,{' '}
                <strong className="text-foreground numeric">{count(impact.data.users, 'user ID')}</strong>,{' '}
                <strong className="text-foreground numeric">{pluralize(impact.data.funnels, 'funnel')}</strong> and{' '}
                <strong className="text-foreground numeric">{pluralize(impact.data.cohorts, 'cohort')}</strong>.
              </p>
              {impact.data.eventStore === 'unavailable' ? <p>{EVENT_STORE_UNREACHABLE}</p> : null}
              <p>{impact.data.notice}</p>
            </>
          ) : impact.error ? (
            <p>{impact.error instanceof ApiError ? impact.error.message : 'What would be deleted could not be read.'}</p>
          ) : (
            <p>Working out what would be deleted.</p>
          )
        }
      />
    </div>
  );
}

// --- Collect (PRD 8.1) ----------------------------------------------------------------

/**
 * What an application needs to send events, the snippets that send them (consent first,
 * AN-186), a test event (AN-025) and the live feed (AN-058). The snippets come from
 * `lib/analytics-snippets.ts`, the one place piece 11 checks the SDK against.
 */
function CollectPanel({ databaseId, projectId }: { databaseId: string; projectId: string }) {
  const credentials = useQuery({ queryKey: ['credentials', projectId], queryFn: () => api.listCredentials(projectId) });
  const publishable = (credentials.data ?? []).filter((credential) => credential.type === 'publishable' && !credential.revokedAt && credential.key);
  const snippets = analyticsSnippets({
    baseUrl: window.location.origin,
    publishableKey: publishable[0]?.key ?? 'ipk_your_publishable_client_key',
    analyticsDatabaseId: databaseId,
  });
  const queryClient = useQueryClient();
  const test = useMutation({
    mutationFn: () => api.sendAnalyticsTestEvent(databaseId),
    onSuccess: async (answer) => {
      await queryClient.invalidateQueries({ queryKey: ['analytics-live', databaseId] });
      toast.success(answer.accepted === 1 ? 'Test event stored. It appears in the live feed below.' : 'The test event was not stored.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError && error.code === 'analytics_unavailable' ? EVENT_STORE_UNREACHABLE : error instanceof ApiError ? error.message : 'The test event was not sent.'),
  });

  return (
    <div className="mt-4 max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>What your app needs</CardTitle>
          <CardDescription>This analytics database ID and a publishable client key of the project. Both are safe to ship in an application.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyField label="Analytics database ID" value={databaseId} />
          {publishable.length > 0 ? (
            publishable.map((credential) => <CopyField key={credential.id} label={`Publishable client key (${credential.label})`} value={credential.key!} />)
          ) : credentials.data ? (
            <div className="space-y-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              <p>This project has no publishable client key yet.</p>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/projects/${projectId}`}>Create one in API keys</Link>
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
              <SendIcon />
              {test.isPending ? 'Sending' : 'Send a test event'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Sends <code className="font-mono">test_event</code> in environment <code className="font-mono">development</code> through the ingest path. It
              counts in no installation figure and takes no slot of the event-name limit.
            </p>
          </div>
        </CardContent>
      </Card>

      <LiveFeed databaseId={databaseId} />

      <Card>
        <CardHeader>
          <CardTitle>Send events with inlet-sdk</CardTitle>
          <CardDescription>{ANALYTICS_CONSENT_NOTE}</CardDescription>
        </CardHeader>
      </Card>
      {snippets.map((snippet) => (
        <Card key={snippet.runtime}>
          <CardHeader>
            <CardTitle>{snippet.runtime}</CardTitle>
            {snippet.note ? <CardDescription>{snippet.note}</CardDescription> : null}
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-relaxed">{snippet.code}</pre>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** AN-058, PRD 8.1: polled every three seconds with the cursor, so each event is listed once. */
function LiveFeed({ databaseId }: { databaseId: string }) {
  const [paused, setPaused] = useState(false);
  const [events, setEvents] = useState<AnalyticsLiveEvent[]>([]);
  const cursor = useRef<string | undefined>(undefined);
  const feed = useQuery({
    queryKey: ['analytics-live', databaseId],
    queryFn: async () => {
      const from = cursor.current;
      const page = await api.analyticsLiveFeed(databaseId, from);
      // A test event refetches at once, even over a poll still on its way from the same cursor:
      // only the first answer from a cursor is listed, and the next poll brings what it missed.
      if (cursor.current !== from) return page;
      cursor.current = page.cursor;
      if (page.events.length > 0) setEvents((previous) => [...page.events, ...previous].slice(0, 500));
      return page;
    },
    refetchInterval: paused ? false : 3_000,
    retry: false,
  });
  const unreachable = feed.error instanceof ApiError && feed.error.code === 'analytics_unavailable';

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Live feed</CardTitle>
          <CardDescription>
            The latest events this database accepted, newest first, refreshed every three seconds. Held in memory: it starts empty when
            the server restarts.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setPaused((value) => !value)} aria-pressed={paused}>
          {paused ? <PlayIcon /> : <PauseIcon />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </CardHeader>
      <CardContent>
        {unreachable ? (
          <p role="status" className="text-sm text-muted-foreground">
            {EVENT_STORE_UNREACHABLE}
          </p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="live-feed-empty">
            {feed.isLoading ? 'Loading.' : 'No events yet. Send a test event, or start your app with the snippet below.'}
          </p>
        ) : (
          <Table data-testid="live-feed">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Installation</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>App version</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event, index) => (
                <TableRow key={`${event.time}-${event.installationId}-${event.name}-${index}`}>
                  <TableCell className="numeric whitespace-nowrap">{new Date(event.time).toLocaleTimeString()}</TableCell>
                  <TableCell className="font-mono text-xs">{event.name}</TableCell>
                  <TableCell className="font-mono text-xs" title={event.installationId}>
                    {event.installationId.slice(0, 8)}
                  </TableCell>
                  <TableCell>{event.platform}</TableCell>
                  <TableCell className="font-mono text-xs">{event.appVersion}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
