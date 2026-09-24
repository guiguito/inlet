import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, TrashIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type CrashReport, type CrashStateChange, type CurrentUser } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CrashTimelineChart, type TimelineRange } from '@/components/crash-timeline';
import { DatabaseSwitcher } from '@/components/database-switcher';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, formatRelative, pluralize } from '@/lib/format';
import { ResolveDialog, StateBadge, groupTitle } from '@/pages/crash-database';

/**
 * One crash group (section 8.1 "Group detail", CR-041, CR-042, CR-049): header with the
 * state control, aggregates, its own timeline, breakdowns, and the recent reports with one
 * opened as a stack. Frames and context are rendered as text, never as HTML (section 11).
 */
export function CrashGroupPage({ user }: { user: CurrentUser }) {
  const { databaseId = '', groupId = '' } = useParams();
  const [range, setRange] = useState<TimelineRange>(30);
  const [resolving, setResolving] = useState(false);
  const [resolveRelease, setResolveRelease] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const database = useQuery({ queryKey: ['crash-database', databaseId], queryFn: () => api.getCrashDatabase(databaseId) });
  const project = useQuery({
    queryKey: ['project', database.data?.projectId],
    queryFn: () => api.getProject(database.data!.projectId),
    enabled: Boolean(database.data),
  });
  const group = useQuery({ queryKey: ['crash-group', databaseId, groupId, range], queryFn: () => api.getCrashGroup(databaseId, groupId, range) });
  const reports = useQuery({ queryKey: ['crash-group-reports', databaseId, groupId], queryFn: () => api.listCrashGroupReports(databaseId, groupId, 20) });
  const releases = useQuery({ queryKey: ['crash-releases', databaseId], queryFn: () => api.listCrashReleases(databaseId) });
  const members = useQuery({ queryKey: ['members', 'crashDatabase', databaseId], queryFn: () => api.listDatabaseMembers(databaseId) });
  const myRole = members.data?.find((member) => member.userId === user.id)?.effectiveRole;
  const canChange = myRole === 'admin' || myRole === 'creator';

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['crash-group', databaseId, groupId] });
    await queryClient.invalidateQueries({ queryKey: ['crash-groups', databaseId] });
  };
  const change = useMutation({
    mutationFn: (next: CrashStateChange) => api.setCrashGroupState(databaseId, groupId, next),
    onSuccess: async (updated) => {
      await refresh();
      setResolving(false);
      toast.success(updated.state === 'resolved' ? `Resolved${updated.resolvedInRelease ? ` in ${updated.resolvedInRelease}` : ''}.` : updated.state === 'ignored' ? 'Ignored.' : 'Reopened.');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'That change did not go through.'),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCrashGroup(databaseId, groupId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['crash-groups', databaseId] });
      await queryClient.invalidateQueries({ queryKey: ['crash-database', databaseId] });
      toast.success('Group deleted.');
      await navigate(`/crash-databases/${databaseId}`, { replace: true });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The deletion did not complete.'),
  });

  const g = group.data;

  return (
    <AppShell
      user={user}
      crumbs={[
        { label: 'Projects', to: '/' },
        { label: database.data?.name ?? 'Crash database', to: `/crash-databases/${databaseId}` },
        { label: g ? groupTitle(g) : 'Group' },
      ]}
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
      {group.isLoading ? (
        <Skeleton className="h-64" />
      ) : group.error || !g ? (
        <EmptyState
          title="This group could not be loaded"
          description={group.error instanceof ApiError ? group.error.message : 'It may have been deleted.'}
          action={
            <Button variant="outline" asChild>
              <Link to={`/crash-databases/${databaseId}`}>
                <ArrowLeftIcon />
                Back to groups
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <h1 className="truncate text-xl font-semibold tracking-tight">{groupTitle(g)}</h1>
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                <StateBadge group={g} />
                <Badge variant="muted">{g.kind}</Badge>
                {g.resolvedInRelease ? <span>resolved in {g.resolvedInRelease}</span> : null}
                {g.sampleMessage ? <span className="truncate" title="The message of the first report; the SDK may have redacted it before sending.">{g.sampleMessage}</span> : null}
              </div>
            </div>
            {canChange ? (
              <div className="flex flex-wrap items-center gap-2">
                {g.state !== 'resolved' ? <Button onClick={() => setResolving(true)}>Resolve</Button> : null}
                {g.state !== 'ignored' ? (
                  <Button variant="outline" onClick={() => change.mutate({ state: 'ignored' })}>
                    Ignore
                  </Button>
                ) : null}
                {g.state !== 'open' ? (
                  <Button variant="outline" onClick={() => change.mutate({ state: 'open' })}>
                    Reopen
                  </Button>
                ) : null}
                {myRole === 'admin' ? (
                  <Button variant="ghost" onClick={() => setDeleting(true)} aria-label="Delete this group">
                    <TrashIcon />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                ['Reports', String(g.count)],
                ['Users affected', String(g.affectedUsers)],
                ['First seen', formatRelative(g.firstSeenAt)],
                ['Last seen', formatRelative(g.lastSeenAt)],
                ['First release', g.firstRelease ?? '—'],
                ['Last release', g.lastRelease ?? '—'],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="numeric mt-1 text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>

          <Card>
            <CardContent className="pt-6">
              <CrashTimelineChart timeline={g.timeline} range={range} onRangeChange={setRange} title="This group" showNewGroups={false} />
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>By release</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {g.byRelease.map((row) => (
                      <TableRow key={row.version}>
                        <TableCell>{row.version}</TableCell>
                        <TableCell className="numeric text-right">{row.count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>By operating system</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {g.byOs.map((row) => (
                      <TableRow key={row.os || 'unknown'}>
                        <TableCell>{row.os || 'Unknown'}</TableCell>
                        <TableCell className="numeric text-right">{row.count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Recent reports</CardTitle>
              <CardDescription>
                The retained reports, newest first. Reports expire under retention; the counts above do not.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {reports.isLoading ? (
                <Skeleton className="m-4 h-24" />
              ) : (reports.data?.reports.length ?? 0) === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No retained reports. Every report of this group has expired under retention.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Received</TableHead>
                      <TableHead>Release</TableHead>
                      <TableHead>System</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reports.data!.reports.map((report) => (
                      <TableRow key={report.id} data-testid="crash-report-row">
                        <TableCell className="numeric" title={report.clockSkew ? 'The client clock was off; the received time is used.' : undefined}>
                          {formatDateTime(report.receivedAt)}
                          {report.clockSkew ? <Badge variant="outline" className="ml-2">clock skew</Badge> : null}
                        </TableCell>
                        <TableCell>{report.release}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {[report.os.name, report.os.version, report.os.arch].filter(Boolean).join(' ') || '—'}
                          {report.environment !== 'production' ? <Badge variant="muted" className="ml-2">{report.environment}</Badge> : null}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{report.userId ?? '—'}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => setOpenReport(openReport === report.id ? null : report.id)}>
                            {openReport === report.id ? 'Hide' : 'Open'}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {openReport ? <ReportView report={reports.data!.reports.find((r) => r.id === openReport)!} /> : null}

          <ResolveDialog
            open={resolving}
            onOpenChange={setResolving}
            release={resolveRelease}
            onReleaseChange={setResolveRelease}
            releases={(releases.data?.releases ?? []).map((r) => r.version)}
            pending={change.isPending}
            onConfirm={() => change.mutate({ state: 'resolved', ...(resolveRelease ? { resolvedInRelease: resolveRelease } : {}) })}
            count={1}
          />
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title="Delete this group?"
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
            description={
              <p>
                This removes the group, its {pluralize(g.count, 'report')} as counted, its timeline and its user associations. A new report with the same
                fingerprint starts a new group.
              </p>
            }
          />
        </div>
      )}
    </AppShell>
  );
}

/** CR-042: frames as a stack, tags and context as key-value pairs, raw JSON on request. */
function ReportView({ report }: { report: CrashReport }) {
  const [raw, setRaw] = useState(false);
  const { databaseId } = useParams();
  const e = report.envelope;
  return (
    <Card data-testid="crash-report-view">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>
              {e.exception?.type ?? e.native?.fault ?? e.exit?.reason ?? report.kind}
              {e.exception ? <span className="ml-2 font-normal text-muted-foreground">{e.exception.handled ? 'handled' : 'unhandled'}</span> : null}
            </CardTitle>
            <CardDescription className="font-mono text-xs">{report.id} · event {report.eventId}</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setRaw(!raw)}>
            {raw ? 'Readable' : 'Raw JSON'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {raw ? (
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-relaxed">{JSON.stringify(e, null, 2)}</pre>
        ) : (
          <>
            {e.exception ? (
              <div className="space-y-2">
                <p className="text-sm">
                  {e.exception.message}
                  {e.exception.message.endsWith('<redacted>') ? (
                    <span className="ml-2 text-xs text-muted-foreground">(redacted by the SDK before sending)</span>
                  ) : null}
                </p>
                <ol className="rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                  {e.exception.frames.map((frame, index) => (
                    <li key={index} className={frame.inApp ? 'text-foreground' : 'text-muted-foreground'}>
                      {frame.function ?? '<anonymous>'}
                      {frame.file ? ` (${frame.file}${frame.line !== undefined ? `:${frame.line}${frame.col !== undefined ? `:${frame.col}` : ''}` : ''})` : ''}
                      {frame.inApp ? '' : '  [external]'}
                    </li>
                  ))}
                  {e.exception.frames.length === 0 ? <li className="text-muted-foreground">No frames</li> : null}
                </ol>
              </div>
            ) : null}
            {e.native ? <KeyValues title="Native crash" entries={Object.entries(e.native)} /> : null}
            {e.exit ? <KeyValues title="Exit" entries={Object.entries(e.exit)} /> : null}
            <KeyValues
              title="Environment"
              entries={[
                ['platform', e.platform],
                ['runtime', e.runtime ? `${e.runtime.name} ${e.runtime.version ?? ''}`.trim() : undefined],
                ['os', e.os ? `${e.os.name} ${e.os.version ?? ''} ${e.os.arch ?? ''}`.trim() : undefined],
                ['release', e.release ? [e.release.version, e.release.build && `build ${e.release.build}`, e.release.channel].filter(Boolean).join(' · ') : undefined],
                ['environment', e.environment],
                ['sdk', e.sdk ? `${e.sdk.name} ${e.sdk.version}` : undefined],
                ['user', e.user?.id],
                ['client time', e.timestamp],
              ]}
            />
            {report.sessionId || report.installationId ? (
              <div className="space-y-1" data-testid="crash-report-identity">
                <KeyValues
                  title="SDK identity"
                  entries={[
                    ['session', report.sessionId],
                    ['installation', report.installationId],
                  ]}
                />
                {/* CR-040: the other crashes of the same session or installation, one click away. */}
                <div className="flex flex-wrap gap-3 text-xs">
                  {report.sessionId ? (
                    <Link className="underline underline-offset-4" to={`/crash-databases/${databaseId}?tab=groups&sessionId=${report.sessionId}`}>
                      Groups in this session
                    </Link>
                  ) : null}
                  {report.installationId ? (
                    <Link className="underline underline-offset-4" to={`/crash-databases/${databaseId}?tab=groups&installationId=${report.installationId}`}>
                      Groups on this installation
                    </Link>
                  ) : null}
                </div>
              </div>
            ) : null}
            {e.tags && Object.keys(e.tags).length > 0 ? <KeyValues title="Tags" entries={Object.entries(e.tags)} /> : null}
            {e.context && Object.keys(e.context).length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Context (integrator-supplied, unreviewed)</p>
                <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{JSON.stringify(e.context, null, 2)}</pre>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function KeyValues({ title, entries }: { title: string; entries: [string, unknown][] }) {
  const shown = entries.filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (shown.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {shown.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="break-all font-mono text-xs">{String(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
