import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BugIcon, DownloadIcon, ExternalLinkIcon, SendIcon, TrashIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  api,
  ApiError,
  type CrashGroup,
  type CrashGroupFilters,
  type CrashGroupSort,
  type CrashGroupState,
  type CrashStateChange,
  type CurrentUser,
} from '@/lib/api';
import { AccessPanel } from '@/components/access-panel';
import { AppShell } from '@/components/app-shell';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyField } from '@/components/copy-field';
import { CrashTimelineChart, Sparkline, type TimelineRange } from '@/components/crash-timeline';
import { DatabaseSwitcher } from '@/components/database-switcher';
import { EmptyState } from '@/components/empty-state';
import { NotifyPanel } from '@/components/notify-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDateTime, formatRelative, pluralize } from '@/lib/format';

/**
 * One crash database (Crash Reports PRD section 8.1, CR-043): Groups, Releases, Collect,
 * Settings. The Groups tab is the work; the other three are how reports get here and how
 * the database is administered.
 */
const TABS = [
  { value: 'groups', label: 'Groups' },
  { value: 'releases', label: 'Releases' },
  { value: 'collect', label: 'Collect' },
  {
    value: 'settings',
    label: 'Settings',
    panels: [
      { value: 'general', label: 'General' },
      { value: 'retention', label: 'Retention' },
      { value: 'notifications', label: 'Notifications' },
      { value: 'access', label: 'Access' },
    ],
  },
] as const;

const STATE_LABEL: Record<CrashGroupState, string> = { open: 'Open', resolved: 'Resolved', ignored: 'Ignored' };

export function groupTitle(group: Pick<CrashGroup, 'exceptionType' | 'topFrame' | 'module' | 'kind'>): string {
  const head = group.exceptionType ?? group.kind;
  const where = group.topFrame ?? group.module;
  return where ? `${head} · ${where}` : head;
}

export function StateBadge({ group }: { group: Pick<CrashGroup, 'state' | 'regressed'> }) {
  if (group.state === 'open' && group.regressed) return <Badge variant="destructive">Regressed</Badge>;
  if (group.state === 'open') return <Badge variant="primary">Open</Badge>;
  if (group.state === 'resolved') return <Badge variant="outline">Resolved</Badge>;
  return <Badge variant="muted">Ignored</Badge>;
}

export function CrashDatabasePage({ user }: { user: CurrentUser }) {
  const { databaseId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'groups';
  const settingsPanels = TABS[3].panels;
  const panel = settingsPanels.find((p) => p.value === params.get('panel'))?.value ?? 'general';
  const show = (nextTab: string, nextPanel?: string) => setParams({ tab: nextTab, ...(nextPanel ? { panel: nextPanel } : {}) });

  const database = useQuery({ queryKey: ['crash-database', databaseId], queryFn: () => api.getCrashDatabase(databaseId) });
  const project = useQuery({
    queryKey: ['project', database.data?.projectId],
    queryFn: () => api.getProject(database.data!.projectId),
    enabled: Boolean(database.data),
  });

  return (
    <AppShell
      user={user}
      crumbs={[{ label: 'Projects', to: '/' }, { label: database.data?.name ?? 'Crash database' }]}
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
          title="This crash database could not be loaded"
          description={database.error instanceof ApiError ? database.error.message : 'Try reloading the page.'}
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
                <Badge variant="outline">Crash reports</Badge>
                <span className="numeric">{pluralize(database.data.groupCount, 'group')}</span>
                <span aria-hidden="true" className="text-border">·</span>
                <span className="numeric">{pluralize(database.data.reportCount, 'report')} kept</span>
                {database.data.dropped24h.rateLimited + database.data.dropped24h.evicted > 0 ? (
                  <>
                    <span aria-hidden="true" className="text-border">·</span>
                    <span className="numeric" title="Reports refused for rate limiting or removed by retention in the last 24 hours (CR-004)">
                      {database.data.dropped24h.rateLimited} rate limited, {database.data.dropped24h.evicted} evicted, last 24 h
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <Button variant="outline" onClick={() => show('collect')}>
              <ExternalLinkIcon />
              Set up the SDK
            </Button>
          </div>

          <Tabs className="mt-6" value={tab} onValueChange={(next) => show(next)}>
            <TabsList>
              {TABS.map((entry) => (
                <TabsTrigger key={entry.value} value={entry.value}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="groups">
              <GroupsTab databaseId={databaseId} />
            </TabsContent>
            <TabsContent value="releases">
              <ReleasesTab databaseId={databaseId} onFilterRelease={(version) => setParams({ tab: 'groups', release: version })} />
            </TabsContent>
            <TabsContent value="collect">
              <CollectTab databaseId={databaseId} projectId={database.data.projectId} />
            </TabsContent>
            <TabsContent value="settings">
              <Tabs value={panel} onValueChange={(next) => show('settings', next)}>
                <TabsList>
                  {settingsPanels.map((entry) => (
                    <TabsTrigger key={entry.value} value={entry.value}>
                      {entry.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value="general">
                  <GeneralSettings databaseId={databaseId} projectId={database.data.projectId} name={database.data.name} />
                </TabsContent>
                <TabsContent value="retention">
                  <RetentionSettings databaseId={databaseId} />
                </TabsContent>
                <TabsContent value="notifications">
                  <NotifyPanel databaseId={databaseId} hideContentLevel />
                </TabsContent>
                <TabsContent value="access">
                  <AccessPanel scope={{ kind: 'crashDatabase', databaseId, name: database.data.name }} currentUserId={user.id} />
                </TabsContent>
              </Tabs>
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </AppShell>
  );
}

// --- Groups (CR-040, CR-044, CR-048, CR-049) ---------------------------------------

const ANY = '__any__';

function GroupsTab({ databaseId }: { databaseId: string }) {
  const [params, setParams] = useSearchParams();
  const filters: CrashGroupFilters = {
    state: (params.get('state') as CrashGroupState | null) ?? undefined,
    kind: params.get('kind') ?? undefined,
    release: params.get('release') ?? undefined,
    os: params.get('os') ?? undefined,
    environment: params.get('environment') ?? undefined,
    userId: params.get('userId') ?? undefined,
    q: params.get('q') ?? undefined,
  };
  const sort = (params.get('sort') as CrashGroupSort | null) ?? 'lastSeen';
  const [range, setRange] = useState<TimelineRange>(30);
  const [query, setQuery] = useState(filters.q ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resolving, setResolving] = useState(false);
  const [resolveRelease, setResolveRelease] = useState('');
  const queryClient = useQueryClient();

  const setFilter = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value === undefined || value === '' || value === ANY) next.delete(key);
    else next.set(key, value);
    next.set('tab', 'groups');
    setParams(next);
  };

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if ((filters.q ?? '') !== query) setFilter('q', query);
    }, 300);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const groups = useQuery({
    queryKey: ['crash-groups', databaseId, filters, sort],
    queryFn: () => api.listCrashGroups(databaseId, { ...filters, sort, limit: 100, days: 30 }),
  });
  const stats = useQuery({
    queryKey: ['crash-stats', databaseId, filters, range],
    queryFn: () => api.getCrashStats(databaseId, { ...filters, days: range }),
  });
  const releases = useQuery({ queryKey: ['crash-releases', databaseId], queryFn: () => api.listCrashReleases(databaseId) });
  // Section 8.1: selects for OS and environment, fed by what the database has actually seen.
  const osSeen = useQuery({ queryKey: ['crash-stats', databaseId, 'os'], queryFn: () => api.getCrashStats(databaseId, { days: 90, by: 'os' }) });
  const environmentsSeen = useQuery({ queryKey: ['crash-stats', databaseId, 'environment'], queryFn: () => api.getCrashStats(databaseId, { days: 90, by: 'environment' }) });
  const kindsSeen = useQuery({ queryKey: ['crash-stats', databaseId, 'kind'], queryFn: () => api.getCrashStats(databaseId, { days: 90, by: 'kind' }) });
  const withCurrent = (rows: { key: string }[] | undefined, current: string | undefined) => {
    const keys = (rows ?? []).map((row) => row.key).filter(Boolean);
    return current && !keys.includes(current) ? [current, ...keys] : keys;
  };

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['crash-groups', databaseId] });
    await queryClient.invalidateQueries({ queryKey: ['crash-database', databaseId] });
    setSelected(new Set());
  };
  const bulk = useMutation({
    mutationFn: (change: CrashStateChange) => api.setCrashGroupsState(databaseId, [...selected], change),
    onSuccess: async (result) => {
      await refresh();
      setResolving(false);
      toast.success(`${pluralize(result.updated, 'group')} updated.`);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'That change did not go through.'),
  });

  const allSelected = (groups.data?.groups.length ?? 0) > 0 && groups.data!.groups.every((g) => selected.has(g.id));

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="pt-6">
          <CrashTimelineChart timeline={stats.data} range={range} onRangeChange={setRange} title="This crash database" />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="group" aria-label="State">
          {([undefined, 'open', 'resolved', 'ignored'] as const).map((state) => (
            <Button
              key={state ?? 'all'}
              size="sm"
              variant={filters.state === state ? 'secondary' : 'ghost'}
              aria-pressed={filters.state === state}
              onClick={() => setFilter('state', state)}
            >
              {state ? STATE_LABEL[state] : 'All states'}
            </Button>
          ))}
        </div>
        <Select value={filters.release ?? ANY} onValueChange={(value) => setFilter('release', value)}>
          <SelectTrigger className="w-40" aria-label="Release">
            <SelectValue placeholder="Any release" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any release</SelectItem>
            {(releases.data?.releases ?? []).map((release) => (
              <SelectItem key={`${release.version}|${release.build}|${release.channel}`} value={release.version}>
                {release.version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.os ?? ANY} onValueChange={(value) => setFilter('os', value)}>
          <SelectTrigger className="w-40" aria-label="Operating system">
            <SelectValue placeholder="Any system" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any system</SelectItem>
            {withCurrent(osSeen.data?.breakdown?.rows, filters.os).map((os) => (
              <SelectItem key={os} value={os}>
                {os}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.environment ?? ANY} onValueChange={(value) => setFilter('environment', value)}>
          <SelectTrigger className="w-40" aria-label="Environment">
            <SelectValue placeholder="Any environment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any environment</SelectItem>
            {withCurrent(environmentsSeen.data?.breakdown?.rows, filters.environment).map((environment) => (
              <SelectItem key={environment} value={environment}>
                {environment}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Section 8.1: chips for the kinds this database has seen. */}
        {withCurrent(kindsSeen.data?.breakdown?.rows, filters.kind).length > 0 ? (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Kind">
            <Button size="sm" variant={filters.kind ? 'ghost' : 'secondary'} aria-pressed={!filters.kind} onClick={() => setFilter('kind', undefined)}>
              All kinds
            </Button>
            {withCurrent(kindsSeen.data?.breakdown?.rows, filters.kind).map((kind) => (
              <Button key={kind} size="sm" variant={filters.kind === kind ? 'secondary' : 'ghost'} aria-pressed={filters.kind === kind} onClick={() => setFilter('kind', kind)}>
                {kind}
              </Button>
            ))}
          </div>
        ) : null}
        <Input className="w-56" placeholder="Search type, frame or message" aria-label="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Select value={sort} onValueChange={(value) => setFilter('sort', value)}>
          <SelectTrigger className="w-40" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="lastSeen">Last seen</SelectItem>
            <SelectItem value="firstSeen">First seen</SelectItem>
            <SelectItem value="count">Most reports</SelectItem>
            <SelectItem value="affectedUsers">Most users</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={api.crashGroupsExportUrl(databaseId, 'json', filters)} download>
              <DownloadIcon />
              JSON
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={api.crashGroupsExportUrl(databaseId, 'csv', filters)} download>
              <DownloadIcon />
              CSV
            </a>
          </Button>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span className="numeric">{pluralize(selected.size, 'group')} selected</span>
          <Button size="sm" onClick={() => setResolving(true)}>
            Resolve
          </Button>
          <Button size="sm" variant="outline" onClick={() => bulk.mutate({ state: 'ignored' })}>
            Ignore
          </Button>
          <Button size="sm" variant="outline" onClick={() => bulk.mutate({ state: 'open' })}>
            Reopen
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {groups.isLoading ? (
        <Skeleton className="h-48" />
      ) : groups.data && groups.data.groups.length > 0 ? (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    aria-label="Select every group shown"
                    checked={allSelected}
                    onCheckedChange={(checked) => setSelected(checked ? new Set(groups.data!.groups.map((g) => g.id)) : new Set())}
                  />
                </TableHead>
                <TableHead>Group</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Reports</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Last 30 days</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.data.groups.map((group) => (
                <TableRow key={group.id} data-testid="crash-group-row">
                  <TableCell>
                    <Checkbox
                      aria-label={`Select ${groupTitle(group)}`}
                      checked={selected.has(group.id)}
                      onCheckedChange={(checked) => {
                        const next = new Set(selected);
                        if (checked) next.add(group.id);
                        else next.delete(group.id);
                        setSelected(next);
                      }}
                    />
                  </TableCell>
                  <TableCell className="max-w-md">
                    <Link to={`/crash-databases/${databaseId}/groups/${group.id}`} className="font-medium hover:text-primary">
                      {groupTitle(group)}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge variant="muted">{group.kind}</Badge>
                      {group.lastRelease ? <Badge variant="outline">{group.lastRelease}</Badge> : null}
                      {group.sampleMessage ? <span className="truncate">{group.sampleMessage}</span> : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StateBadge group={group} />
                  </TableCell>
                  <TableCell className="numeric text-right">{group.count}</TableCell>
                  <TableCell className="numeric text-right">{group.affectedUsers}</TableCell>
                  <TableCell className="numeric text-muted-foreground" title={formatDateTime(group.lastSeenAt)}>
                    {formatRelative(group.lastSeenAt)}
                  </TableCell>
                  <TableCell>
                    <Sparkline values={group.sparkline} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="border-t px-4 py-2 text-xs text-muted-foreground numeric">
            {pluralize(groups.data.total, 'group')} match{groups.data.total === 1 ? 'es' : ''}
            {groups.data.total > groups.data.groups.length ? `, showing the first ${groups.data.groups.length}` : ''}.
          </p>
        </Card>
      ) : (
        <EmptyState
          icon={<BugIcon />}
          title={Object.values(filters).some(Boolean) ? 'No groups match these filters' : 'No crashes reported yet'}
          description={
            Object.values(filters).some(Boolean)
              ? 'Widen the filters, or wait for the next release.'
              : 'Install @inlet/sdk/crash in your application with this database ID and your publishable key; the first report appears here within seconds.'
          }
          action={
            Object.values(filters).some(Boolean) ? undefined : (
              <Button variant="outline" onClick={() => setParams({ tab: 'collect' })}>
                Open Collect
              </Button>
            )
          }
        />
      )}

      <ResolveDialog
        open={resolving}
        onOpenChange={setResolving}
        release={resolveRelease}
        onReleaseChange={setResolveRelease}
        releases={(releases.data?.releases ?? []).map((r) => r.version)}
        pending={bulk.isPending}
        onConfirm={() => bulk.mutate({ state: 'resolved', ...(resolveRelease ? { resolvedInRelease: resolveRelease } : {}) })}
        count={selected.size}
      />
    </div>
  );
}

/** CR-027: resolve, optionally naming the release the fix ships in. Shared with the group page. */
export function ResolveDialog({
  open,
  onOpenChange,
  release,
  onReleaseChange,
  releases,
  pending,
  onConfirm,
  count,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  release: string;
  onReleaseChange: (release: string) => void;
  releases: string[];
  pending: boolean;
  onConfirm: () => void;
  count: number;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={count === 1 ? 'Resolve this group' : `Resolve ${count} groups`}
      confirmLabel="Resolve"
      pending={pending}
      onConfirm={onConfirm}
      description={
        <>
          <p>
            Reports from the release you name, or an earlier one, keep counting silently. A report
            from a release first seen after it reopens the group as a regression and posts to Slack
            once.
          </p>
          <p>Without a release, the next report of any kind reopens it.</p>
        </>
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor="resolve-release">Resolved in release (optional)</Label>
        <Select value={release || ANY} onValueChange={(value) => onReleaseChange(value === ANY ? '' : value)}>
          <SelectTrigger id="resolve-release" className="w-full">
            <SelectValue placeholder="No release" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>No release</SelectItem>
            {releases.map((version) => (
              <SelectItem key={version} value={version}>
                {version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </ConfirmDialog>
  );
}

// --- Releases (CR-045) --------------------------------------------------------------

function ReleasesTab({ databaseId, onFilterRelease }: { databaseId: string; onFilterRelease: (version: string) => void }) {
  const releases = useQuery({ queryKey: ['crash-releases', databaseId], queryFn: () => api.listCrashReleases(databaseId) });
  if (releases.isLoading) return <Skeleton className="h-48" />;
  const rows = releases.data?.releases ?? [];
  if (rows.length === 0) {
    return <EmptyState title="No releases yet" description="A release is recorded the first time a report names its version. Inlet never parses version strings; order is first sighting." />;
  }
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12 text-right">#</TableHead>
            <TableHead>Release</TableHead>
            <TableHead>First seen</TableHead>
            <TableHead className="text-right">Reports</TableHead>
            <TableHead className="text-right">Groups</TableHead>
            <TableHead className="text-right">New groups</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((release) => (
            <TableRow key={`${release.version}|${release.build}|${release.channel}`}>
              <TableCell className="numeric text-right text-muted-foreground">{release.order}</TableCell>
              <TableCell>
                <span className="font-medium">{release.version}</span>
                {release.build || release.channel ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {[release.build && `build ${release.build}`, release.channel].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="numeric text-muted-foreground">{formatDateTime(release.firstSeenAt)}</TableCell>
              <TableCell className="numeric text-right">{release.reports}</TableCell>
              <TableCell className="numeric text-right">{release.groups}</TableCell>
              <TableCell className="numeric text-right">{release.newGroups}</TableCell>
              <TableCell className="text-right">
                <Button size="sm" variant="ghost" onClick={() => onFilterRelease(release.version)}>
                  Show groups
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

// --- Collect (section 8.1) ----------------------------------------------------------

function CollectTab({ databaseId, projectId }: { databaseId: string; projectId: string }) {
  const credentials = useQuery({ queryKey: ['credentials', projectId], queryFn: () => api.listCredentials(projectId) });
  const publishable = credentials.data?.find((credential) => credential.type === 'publishable' && !credential.revokedAt);
  const key = publishable?.key ?? 'ipk_your_publishable_client_key';
  const origin = window.location.origin;
  const queryClient = useQueryClient();
  const test = useMutation({
    mutationFn: () => api.sendCrashTestReport(databaseId, publishable!.key!),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['crash-groups', databaseId] });
      await queryClient.invalidateQueries({ queryKey: ['crash-database', databaseId] });
      toast.success(result.isNewGroup ? 'Test report stored in a new group.' : 'Test report stored in its existing group.');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The test report was not accepted.'),
  });

  const init = `import * as crash from '@inlet/sdk/crash';

crash.init({
  baseUrl: '${origin}',
  publishableKey: '${key}',
  crashDatabaseId: '${databaseId}',
  release: app.getVersion(),
});`;

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>What your app needs</CardTitle>
          <CardDescription>A publishable client key and this crash database ID. Both are safe to ship in an application.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyField label="Crash database ID" value={databaseId} />
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
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" disabled={!publishable?.key || test.isPending} onClick={() => test.mutate()}>
              <SendIcon />
              {test.isPending ? 'Sending' : 'Send a test report'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Posts one report of kind <code className="font-mono">message</code> with the key above, exactly as an application would.
            </p>
          </div>
        </CardContent>
      </Card>

      {(
        [
          ['Node', `${init}\ncrash.installNodeHandlers();`],
          ['Browser', `${init.replace('app.getVersion()', "'1.0.0'")}\ncrash.installBrowserHandlers();`],
          ['Electron main', `${init}\ncrash.installElectronMain({ userDataDir: app.getPath('userData') });`],
          ['Electron renderer', `import * as crash from '@inlet/sdk/crash';\n\n// Every capture routes through the main process over IPC.\ncrash.installElectronRenderer();`],
        ] as const
      ).map(([label, snippet]) => (
        <Card key={label}>
          <CardHeader>
            <CardTitle>{label}</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-relaxed">{snippet}</pre>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Or post an envelope directly</CardTitle>
          <CardDescription>The SDK is a convenience. Any client can send the JSON envelope of the API reference.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
{`curl -s -X POST "${origin}/v1/crash-databases/${databaseId}/reports" \\
  -H "Authorization: Bearer ${key}" \\
  -H 'content-type: application/json' \\
  -d '{"eventId":"'$(uuidgen)'","timestamp":"'$(date -u +%FT%TZ)'",
       "sdk":{"name":"curl","version":"1"},"kind":"exception","release":{"version":"1.0.0"},
       "exception":{"type":"TypeError","message":"boom","handled":false,
                    "frames":[{"function":"main","file":"app.js","inApp":true}]}}'`}
          </pre>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <a href="/docs" target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              Full API reference
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Settings -------------------------------------------------------------------------

function GeneralSettings({ databaseId, projectId, name }: { databaseId: string; projectId: string; name: string }) {
  const [draftName, setDraftName] = useState(name);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const impact = useQuery({ queryKey: ['crash-deletion-impact', databaseId], queryFn: () => api.crashDeletionImpact(databaseId), enabled: deleting });

  const rename = useMutation({
    mutationFn: () => api.renameCrashDatabase(databaseId, draftName.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['crash-database', databaseId] });
      await queryClient.invalidateQueries({ queryKey: ['crash-databases', projectId] });
      toast.success('Crash database renamed.');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The rename did not complete.'),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCrashDatabase(databaseId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['crash-databases', projectId] });
      toast.success('Crash database deleted.');
      await navigate(`/projects/${projectId}`, { replace: true });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The deletion did not complete.'),
  });

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Name</CardTitle>
          <CardDescription>The identifier never changes, so an integrated application keeps reporting.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              rename.mutate();
            }}
          >
            <Input value={draftName} maxLength={200} aria-label="Name" onChange={(event) => setDraftName(event.target.value)} />
            <Button type="submit" disabled={rename.isPending || draftName.trim() === '' || draftName.trim() === name}>
              Rename
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Delete this crash database</CardTitle>
          <CardDescription>Every group, report, release and timeline goes with it. Export the groups first if you want the history.</CardDescription>
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
        title={`Delete ${name}?`}
        confirmText={name}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        description={
          impact.data ? (
            <>
              <p>
                This deletes <strong className="text-foreground numeric">{pluralize(impact.data.groups, 'group')}</strong> and{' '}
                <strong className="text-foreground numeric">{pluralize(impact.data.reports, 'retained report')}</strong>, with the releases,
                timelines, memberships, invitations and notification settings.
              </p>
              <p>{impact.data.notice}</p>
              <p className="flex flex-wrap gap-2 pt-1">
                <Button variant="outline" size="sm" asChild>
                  <a href={api.crashGroupsExportUrl(databaseId, 'json', {})} download>
                    Export groups as JSON
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href={api.crashReportsExportUrl(databaseId, {})} download>
                    Export reports as NDJSON
                  </a>
                </Button>
              </p>
            </>
          ) : (
            <p>Working out what would be deleted.</p>
          )
        }
      />
    </div>
  );
}

function RetentionSettings({ databaseId }: { databaseId: string }) {
  const queryClient = useQueryClient();
  const retention = useQuery({ queryKey: ['crash-retention', databaseId], queryFn: () => api.getCrashRetention(databaseId) });
  const [maxReports, setMaxReports] = useState<string>('');
  const [maxAgeDays, setMaxAgeDays] = useState<string>('');
  const [unlimited, setUnlimited] = useState(false);
  useEffect(() => {
    if (!retention.data) return;
    setMaxReports(String(retention.data.maxReports));
    setMaxAgeDays(retention.data.maxAgeDays === null ? '' : String(retention.data.maxAgeDays));
    setUnlimited(retention.data.maxAgeDays === null);
  }, [retention.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateCrashRetention(databaseId, { maxReports: Number(maxReports), maxAgeDays: unlimited ? null : Number(maxAgeDays) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['crash-retention', databaseId] });
      await queryClient.invalidateQueries({ queryKey: ['crash-database', databaseId] });
      toast.success('Retention updated.');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The retention setting was not saved.'),
  });

  if (retention.isLoading || !retention.data) return <Skeleton className="h-48 max-w-2xl" />;
  const bounds = retention.data.bounds;

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Retention</CardTitle>
        <CardDescription>
          How many reports this database keeps, and for how long. Groups, their counts and their timelines are never subject to retention; only the
          individual reports behind them expire (CR-002, CR-082).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="retention-cap">Maximum retained reports</Label>
            <Input
              id="retention-cap"
              type="number"
              min={bounds.maxReports.min}
              max={bounds.maxReports.max}
              value={maxReports}
              onChange={(event) => setMaxReports(event.target.value)}
            />
            <p className="text-xs text-muted-foreground numeric">
              Between {bounds.maxReports.min.toLocaleString()} and {bounds.maxReports.max.toLocaleString()}; the default is {bounds.maxReports.default.toLocaleString()}. Over the cap, the
              oldest reports of the fullest group go first, and every group keeps its latest.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="retention-age">Maximum report age in days</Label>
            <div className="flex items-center gap-3">
              <Input
                id="retention-age"
                type="number"
                className="w-32"
                min={bounds.maxAgeDays.min}
                max={bounds.maxAgeDays.max}
                value={maxAgeDays}
                disabled={unlimited}
                onChange={(event) => setMaxAgeDays(event.target.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={unlimited} onCheckedChange={(checked) => setUnlimited(checked === true)} />
                Unlimited
              </label>
            </div>
            <p className="text-xs text-muted-foreground numeric">
              Between {bounds.maxAgeDays.min} and {bounds.maxAgeDays.max}; the default is {bounds.maxAgeDays.default}. Checked hourly, so a database that stops
              receiving reports still honours it.
            </p>
          </div>
          <Button type="submit" disabled={save.isPending}>
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

