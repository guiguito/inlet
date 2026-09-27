import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TrashIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { Role } from '@inlet/shared';
import { api, ApiError, type ConfigDatabase, type CurrentUser } from '@/lib/api';
import { AccessPanel } from '@/components/access-panel';
import { AppShell } from '@/components/app-shell';
import { HistoryTab } from '@/components/config/history-tab';
import { IntegrateTab } from '@/components/config/integrate-tab';
import { ParametersTab } from '@/components/config/parameters-tab';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CountryAttribution } from '@/components/country-attribution';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { pluralize } from '@/lib/format';

/**
 * One config database (Remote Config PRD section 8.1): Parameters, History, Integrate and
 * Settings (General, Delivery, Notifications, Access). Piece 2 builds the shell and Settings,
 * piece 7 Parameters (the landing group, with its Parameters and Conditions views), piece 8
 * History and Integrate, each one entry here, before Settings.
 */
const TABS = [
  { value: 'parameters', label: 'Parameters', panels: [] },
  { value: 'history', label: 'History', panels: [] },
  { value: 'integrate', label: 'Integrate', panels: [] },
  {
    value: 'settings',
    label: 'Settings',
    panels: [
      { value: 'general', label: 'General' },
      { value: 'delivery', label: 'Delivery' },
      { value: 'notifications', label: 'Notifications' },
      { value: 'access', label: 'Access' },
    ],
  },
] as const;

export function ConfigDatabasePage({ user }: { user: CurrentUser }) {
  const { databaseId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((entry) => entry.value === params.get('tab')) ?? TABS[0];
  const panels: readonly { value: string; label: string }[] = tab.panels;
  const panel = panels.find((entry) => entry.value === params.get('panel'))?.value ?? panels[0]?.value;
  const view = params.get('view') === 'conditions' ? 'conditions' : 'parameters';
  const show = (nextTab: string, nextPanel?: string) => setParams({ tab: nextTab, ...(nextPanel ? { panel: nextPanel } : {}) });
  // The caller's effective role decides which controls are offered; the API enforces it either way.
  const members = useQuery({ queryKey: ['members', 'configDatabase', databaseId], queryFn: () => api.listDatabaseMembers(databaseId) });
  const role = members.data?.find((member) => member.userId === user.id)?.effectiveRole;

  const database = useQuery({ queryKey: ['config-database', databaseId], queryFn: () => api.getConfigDatabase(databaseId) });
  const project = useQuery({
    queryKey: ['project', database.data?.projectId],
    queryFn: () => api.getProject(database.data!.projectId),
    enabled: Boolean(database.data),
  });

  return (
    <AppShell
      user={user}
      crumbs={[{ label: 'Projects', to: '/' }, { label: database.data?.name ?? 'Config database' }]}
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
          title="This config database could not be loaded"
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
              <Badge variant="outline">Remote config</Badge>
              <span data-testid="active-version">
                {database.data.activeVersion === null ? 'Nothing published' : `Version ${database.data.activeVersion} active`}
              </span>
            </div>
          </div>

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
                {entry.value === 'parameters' ? (
                  <ParametersTab database={database.data} role={role} view={view} onView={(next) => setParams({ tab: 'parameters', view: next })} />
                ) : entry.value === 'history' ? (
                  <HistoryTab database={database.data} role={role} />
                ) : entry.value === 'integrate' ? (
                  <IntegrateTab database={database.data} />
                ) : (
                <Tabs value={panel} onValueChange={(next) => show(entry.value, next)}>
                  <TabsList>
                    {entry.panels.map((sub) => (
                      <TabsTrigger key={sub.value} value={sub.value}>
                        {sub.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {entry.panels.map((sub) => (
                    <TabsContent key={sub.value} value={sub.value}>
                      {sub.value === 'general' ? (
                        <GeneralSettings database={database.data} role={role} />
                      ) : sub.value === 'delivery' ? (
                        <DeliverySettings database={database.data} role={role} />
                      ) : sub.value === 'notifications' ? (
                        <NotifyPanel databaseId={databaseId} hideContentLevel />
                      ) : (
                        <AccessPanel scope={{ kind: 'configDatabase', databaseId, name: database.data.name }} currentUserId={user.id} />
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

function useUpdate(database: ConfigDatabase, success: (patch: Parameters<typeof api.updateConfigDatabase>[1]) => string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<typeof api.updateConfigDatabase>[1]) => api.updateConfigDatabase(database.id, patch),
    onSuccess: async (_, patch) => {
      await queryClient.invalidateQueries({ queryKey: ['config-database', database.id] });
      await queryClient.invalidateQueries({ queryKey: ['config-databases', database.projectId] });
      toast.success(success(patch));
    },
  });
}

/** Settings → General (8.1): rename; deletion with its impact and the history export. */
function GeneralSettings({ database, role }: { database: ConfigDatabase; role: Role | undefined }) {
  const [draftName, setDraftName] = useState(database.name);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canRename = role === 'admin' || role === 'creator';
  const impact = useQuery({ queryKey: ['config-deletion-impact', database.id], queryFn: () => api.configDeletionImpact(database.id), enabled: deleting });
  const rename = useUpdate(database, () => 'Config database renamed.');
  const remove = useMutation({
    mutationFn: () => api.deleteConfigDatabase(database.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['config-databases', database.projectId] });
      toast.success('Config database deleted.');
      await navigate(`/projects/${database.projectId}`, { replace: true });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The deletion did not complete.'),
  });

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Name</CardTitle>
          <CardDescription>The identifier never changes, so an integrated application keeps fetching.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              rename.mutate(
                { name: draftName.trim() },
                { onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The change did not complete.') },
              );
            }}
          >
            <Input value={draftName} maxLength={200} aria-label="Name" disabled={!canRename} onChange={(event) => setDraftName(event.target.value)} />
            <Button type="submit" disabled={!canRename || rename.isPending || draftName.trim() === '' || draftName.trim() === database.name}>
              Rename
            </Button>
          </form>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{database.id}</p>
        </CardContent>
      </Card>

      {role === 'admin' ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Delete this config database</CardTitle>
            <CardDescription>
              The draft and every version go with it. Applications fetching it are refused and keep the values they last received; unpublish first to send them to their in-app defaults.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" onClick={() => setDeleting(true)}>
              <TrashIcon />
              Delete
            </Button>
          </CardContent>
        </Card>
      ) : null}

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
                This deletes <strong className="text-foreground numeric">{pluralize(impact.data.versions, 'version')}</strong> and a draft of{' '}
                <strong className="text-foreground numeric">{pluralize(impact.data.draftParameters, 'parameter')}</strong>
                {impact.data.activeParameters === null ? (
                  '; nothing is published.'
                ) : (
                  <>
                    ; the active version has <strong className="text-foreground numeric">{pluralize(impact.data.activeParameters, 'parameter')}</strong>.
                  </>
                )}
              </p>
              <p>{impact.data.notice}</p>
              {/* RC-003, RC-064: the export offered before deletion is the history export. */}
              <p data-testid="config-export-offer">
                Before deleting, you can{' '}
                <a className="font-medium text-foreground underline underline-offset-4" href={impact.data.exportPath} download>
                  export the history
                </a>
                : every version with its template, and not the reach counts, the memberships or the notification settings.
              </p>
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

/**
 * Settings → Delivery (8.1, RC-002): the refresh interval with its bounds, and the country
 * switch with the IP-to-country attribution. A database or project Admin changes them.
 */
function DeliverySettings({ database, role }: { database: ConfigDatabase; role: Role | undefined }) {
  const [minutes, setMinutes] = useState(String(database.refreshIntervalMinutes));
  const [problem, setProblem] = useState<string | null>(null);
  const isAdmin = role === 'admin';
  const { min, max } = database.refreshIntervalBounds;
  const update = useUpdate(database, (patch) =>
    patch.refreshIntervalMinutes !== undefined ? 'Refresh interval saved.' : patch.deriveCountry ? 'Country derivation is on.' : 'Country derivation is off.',
  );
  const failed = (error: Error) => toast.error(error instanceof ApiError ? error.message : 'The change did not complete.');

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Refresh interval</CardTitle>
          <CardDescription>
            How long a running application waits between fetches. A change applies to fetches answered from now on and
            leaves every version unchanged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setProblem(null);
              update.mutate(
                { refreshIntervalMinutes: Number(minutes) },
                {
                  onError: (error) => {
                    if (error instanceof ApiError && (error.code === 'setting_out_of_bounds' || error.code === 'validation_failed')) setProblem(error.message);
                    else failed(error);
                  },
                },
              );
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="refresh-interval">Minutes</Label>
              <Input
                id="refresh-interval"
                className="w-32"
                type="number"
                inputMode="numeric"
                value={minutes}
                disabled={!isAdmin}
                aria-describedby="refresh-interval-bounds"
                onChange={(event) => setMinutes(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={!isAdmin || update.isPending || minutes.trim() === '' || Number(minutes) === database.refreshIntervalMinutes}>
              Save
            </Button>
          </form>
          <p id="refresh-interval-bounds" className="text-[13px] text-muted-foreground">
            From {min.toLocaleString('en-US')} to {max.toLocaleString('en-US')} minutes on this deployment.
          </p>
          {problem ? (
            <p role="alert" className="text-[13px] text-destructive">
              {problem}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Country</CardTitle>
          <CardDescription>
            When this is on, each fetch gets the country its request came from, so a condition can target it. The address is
            used for the lookup and never stored. A change applies to fetches answered from now on.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              id="derive-country"
              checked={database.deriveCountry}
              disabled={!isAdmin || update.isPending}
              onCheckedChange={(checked) => update.mutate({ deriveCountry: checked }, { onError: failed })}
            />
            <Label htmlFor="derive-country">Derive the country of each fetch</Label>
          </div>
          <CountryAttribution className="text-[13px]" />
        </CardContent>
      </Card>

      {role !== undefined && !isAdmin ? <p className="text-[13px] text-muted-foreground">Only an Admin can change the delivery settings.</p> : null}
    </div>
  );
}
