import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DatabaseIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RotateCwIcon,
  TrashIcon,
  XCircleIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type Credential, type CurrentUser } from '@/lib/api';
import { formerTimezoneName } from '@/lib/timezones';
import { AccessPanel } from '@/components/access-panel';
import { AppShell, PageHeader } from '@/components/app-shell';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyField } from '@/components/copy-field';
import { EmptyState } from '@/components/empty-state';
import { ErasePanel } from '@/components/erase-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelative, pluralize } from '@/lib/format';

/**
 * A project: its feedback databases, its credentials, and its settings
 * (FR-012, FR-013, FR-020, FR-080 to FR-085).
 */
export function ProjectPage({ user }: { user: CurrentUser }) {
  const { projectId = '' } = useParams();
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
  });

  return (
    <AppShell
      user={user}
      crumbs={[
        { label: 'Projects', to: '/' },
        { label: project.data?.name ?? 'Project' },
      ]}
    >
      {project.isLoading ? (
        <Skeleton className="h-64" />
      ) : project.error ? (
        <EmptyState
          title="This project could not be loaded"
          description={
            project.error instanceof ApiError ? project.error.message : 'Try reloading the page.'
          }
          action={
            <Button variant="outline" asChild>
              <Link to="/">Back to projects</Link>
            </Button>
          }
        />
      ) : project.data ? (
        <>
          <PageHeader title={project.data.name} description={`Project ${project.data.id}`} />
          <Tabs defaultValue="databases">
            <TabsList>
              <TabsTrigger value="databases">Databases</TabsTrigger>
              <TabsTrigger value="keys">API keys</TabsTrigger>
              <TabsTrigger value="access">Access</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>

            <TabsContent value="databases">
              <div className="space-y-10">
                <section className="space-y-3">
                  <h2 className="text-base font-semibold">Feedback databases</h2>
                  <DatabasesTab projectId={projectId} />
                </section>
                {/* FD-001, FD-003: a second database type under its own heading. */}
                <section className="space-y-3">
                  <h2 className="text-base font-semibold">Crash databases</h2>
                  <CrashDatabasesSection projectId={projectId} />
                </section>
                {/* FD-001, FD-003, UX Analytics 8.1: the third type, under its own heading. */}
                <section className="space-y-3">
                  <h2 className="text-base font-semibold">Analytics databases</h2>
                  <AnalyticsDatabasesSection projectId={projectId} />
                </section>
                {/* FD-001, FD-003, Remote Config 8.1: the fourth type, under its own heading. */}
                <section className="space-y-3">
                  <h2 className="text-base font-semibold">Config databases</h2>
                  <ConfigDatabasesSection projectId={projectId} />
                </section>
              </div>
            </TabsContent>
            <TabsContent value="keys">
              <CredentialsTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="access">
              <AccessPanel
                scope={{ kind: 'project', projectId, name: project.data.name }}
                currentUserId={user.id}
              />
            </TabsContent>
            <TabsContent value="settings">
              <SettingsTab projectId={projectId} name={project.data.name} />
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </AppShell>
  );
}

function DatabasesTab({ projectId }: { projectId: string }) {
  const [creating, setCreating] = useState(false);
  const databases = useQuery({
    queryKey: ['databases', projectId],
    queryFn: () => api.listDatabases(projectId),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Each feedback database is one form and the responses it collects.
        </p>
        <Button onClick={() => setCreating(true)}>
          <PlusIcon />
          New feedback database
        </Button>
      </div>

      {databases.isLoading ? (
        <Skeleton className="h-32" />
      ) : databases.data && databases.data.length > 0 ? (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Form</TableHead>
                <TableHead className="text-right">Responses</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {databases.data.map((database) => (
                <TableRow key={database.id}>
                  <TableCell>
                    <Link
                      to={`/databases/${database.id}`}
                      className="font-medium hover:text-primary"
                    >
                      {database.name}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{database.id}</p>
                  </TableCell>
                  <TableCell>
                    {database.activeFormVersion === null ? (
                      <Badge variant="outline">Unpublished</Badge>
                    ) : (
                      <Badge variant="primary">Version {database.activeFormVersion}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="numeric text-right">{database.submissionCount}</TableCell>
                  <TableCell className="numeric text-muted-foreground">
                    {formatRelative(database.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <EmptyState
          icon={<DatabaseIcon />}
          title="No feedback databases yet"
          description="Create one, build its form, then publish it to start collecting."
          action={
            <Button onClick={() => setCreating(true)}>
              <PlusIcon />
              Create a feedback database
            </Button>
          }
        />
      )}

      <CreateDatabaseDialog projectId={projectId} open={creating} onOpenChange={setCreating} />
    </div>
  );
}

/** Release 6: the project's crash databases, listed beside its feedback databases. */
function CrashDatabasesSection({ projectId }: { projectId: string }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const databases = useQuery({
    queryKey: ['crash-databases', projectId],
    queryFn: () => api.listCrashDatabases(projectId),
  });
  const create = useMutation({
    mutationFn: () => api.createCrashDatabase(projectId, name.trim()),
    onSuccess: async (database) => {
      await queryClient.invalidateQueries({ queryKey: ['crash-databases', projectId] });
      setName('');
      setCreating(false);
      await navigate(`/crash-databases/${database.id}?tab=collect`);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'The crash database could not be created.'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          A crash database receives failure reports from one application and groups them, so a
          crash loop is one line here and one message in Slack.
        </p>
        <Button variant="outline" onClick={() => setCreating(true)}>
          <PlusIcon />
          New crash database
        </Button>
      </div>

      {databases.isLoading ? (
        <Skeleton className="h-24" />
      ) : databases.data && databases.data.length > 0 ? (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Groups</TableHead>
                <TableHead className="text-right">Reports kept</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {databases.data.map((database) => (
                <TableRow key={database.id}>
                  <TableCell>
                    <Link to={`/crash-databases/${database.id}`} className="font-medium hover:text-primary">
                      {database.name}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{database.id}</p>
                  </TableCell>
                  <TableCell className="numeric text-right">{database.groupCount}</TableCell>
                  <TableCell className="numeric text-right">{database.reportCount}</TableCell>
                  <TableCell className="numeric text-muted-foreground">{formatRelative(database.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">No crash databases yet.</p>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>New crash database</DialogTitle>
              <DialogDescription>
                One per application. Your project’s publishable key already lets it report; the
                Collect tab has the snippet.
              </DialogDescription>
            </DialogHeader>
            <div className="my-5 space-y-1.5">
              <Label htmlFor="crash-database-name">Name</Label>
              <Input
                id="crash-database-name"
                value={name}
                autoFocus
                required
                maxLength={200}
                placeholder="Desktop app"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || name.trim().length === 0}>
                {create.isPending ? 'Creating' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Remote Config 8.1: the project's config databases, listed beside the other types. */
function ConfigDatabasesSection({ projectId }: { projectId: string }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const databases = useQuery({
    queryKey: ['config-databases', projectId],
    queryFn: () => api.listConfigDatabases(projectId),
  });
  const create = useMutation({
    mutationFn: () => api.createConfigDatabase(projectId, name.trim()),
    onSuccess: async (database) => {
      await queryClient.invalidateQueries({ queryKey: ['config-databases', projectId] });
      setName('');
      setCreating(false);
      await navigate(`/config-databases/${database.id}`);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The config database could not be created.'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          A config database holds the values a product’s apps fetch at launch, and who gets which:
          feature switches, limits and copy, changed without shipping a release.
        </p>
        <Button variant="outline" onClick={() => setCreating(true)}>
          <PlusIcon />
          New config database
        </Button>
      </div>

      {databases.isLoading ? (
        <Skeleton className="h-24" />
      ) : databases.data && databases.data.length > 0 ? (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Active version</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {databases.data.map((database) => (
                <TableRow key={database.id}>
                  <TableCell>
                    <Link to={`/config-databases/${database.id}`} className="font-medium hover:text-primary">
                      {database.name}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{database.id}</p>
                  </TableCell>
                  <TableCell className="numeric text-muted-foreground">
                    {database.activeVersion === null ? 'Nothing published' : `Version ${database.activeVersion}`}
                  </TableCell>
                  <TableCell className="numeric text-muted-foreground">{formatRelative(database.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">No config databases yet.</p>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>New config database</DialogTitle>
              <DialogDescription>
                One per product, which may ship several apps. Your project’s publishable key already lets
                them fetch from it.
              </DialogDescription>
            </DialogHeader>
            <div className="my-5 space-y-1.5">
              <Label htmlFor="config-database-name">Name</Label>
              <Input
                id="config-database-name"
                value={name}
                autoFocus
                required
                maxLength={200}
                placeholder="Mobile app"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || name.trim().length === 0}>
                {create.isPending ? 'Creating' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * UX Analytics 8.1: the project's analytics databases. Creating one asks for a reporting
 * timezone, proposed from the browser and confirmed by the person (AN-002), because it
 * decides every day, week and month the database reports and can never change.
 */
function AnalyticsDatabasesSection({ projectId }: { projectId: string }) {
  const [creating, setCreating] = useState(false);
  const databases = useQuery({
    queryKey: ['analytics-databases', projectId],
    queryFn: () => api.listAnalyticsDatabases(projectId),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          An analytics database counts how a product is used: active installations, funnels and
          retention, from the events its apps send.
        </p>
        <Button variant="outline" onClick={() => setCreating(true)}>
          <PlusIcon />
          New analytics database
        </Button>
      </div>

      {databases.isLoading ? (
        <Skeleton className="h-24" />
      ) : databases.data && databases.data.length > 0 ? (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Reporting timezone</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {databases.data.map((database) => (
                <TableRow key={database.id}>
                  <TableCell>
                    <Link to={`/analytics-databases/${database.id}`} className="font-medium hover:text-primary">
                      {database.name}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{database.id}</p>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{database.timezone}</TableCell>
                  <TableCell className="numeric text-muted-foreground">{formatRelative(database.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">No analytics databases yet.</p>
      )}

      {creating ? <CreateAnalyticsDatabaseDialog projectId={projectId} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

/**
 * AN-005's message names a command and a variable between backticks, as the API sends it;
 * they are shown as code rather than as literal backticks.
 */
function withCodeSpans(text: string) {
  return text.split('`').map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="font-mono text-[12px]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

function CreateAnalyticsDatabaseDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [confirmed, setConfirmed] = useState(false);
  const [zoneProblem, setZoneProblem] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createAnalyticsDatabase(projectId, name.trim(), timezone.trim()),
    onSuccess: async (database) => {
      await queryClient.invalidateQueries({ queryKey: ['analytics-databases', projectId] });
      onClose();
      await navigate(`/analytics-databases/${database.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'analytics_not_enabled') {
        setNotEnabled(error.message);
        return;
      }
      if (error instanceof ApiError && error.code === 'timezone_invalid') {
        // AN-002: a zone renamed after the server's timezone data was published is known to
        // it by its former name; propose that, and ask again.
        const former = formerTimezoneName(timezone.trim());
        setConfirmed(false);
        if (former) {
          setTimezone(former);
          setZoneProblem(`The server does not list ${timezone.trim()}. It knows the same zone as ${former}, which is filled in. Confirm it to continue.`);
        } else {
          setZoneProblem(`${error.message} Enter another zone, such as Europe/Paris.`);
        }
        return;
      }
      toast.error(error instanceof ApiError ? error.message : 'The analytics database could not be created.');
    },
  });

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        {notEnabled ? (
          <>
            <DialogHeader>
              <DialogTitle>Analytics is not enabled</DialogTitle>
              <DialogDescription>{withCodeSpans(notEnabled)}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>New analytics database</DialogTitle>
              <DialogDescription>
                One per product, which may ship several apps. Your project’s publishable key already
                lets its apps send events.
              </DialogDescription>
            </DialogHeader>
            <div className="my-5 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="analytics-database-name">Name</Label>
                <Input
                  id="analytics-database-name"
                  value={name}
                  autoFocus
                  required
                  maxLength={200}
                  placeholder="Checkout app"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="analytics-database-timezone">Reporting timezone</Label>
                <Input
                  id="analytics-database-timezone"
                  value={timezone}
                  required
                  maxLength={64}
                  onChange={(event) => {
                    setTimezone(event.target.value);
                    setConfirmed(false);
                    setZoneProblem(null);
                  }}
                />
                {zoneProblem ? (
                  <p role="alert" className="text-[13px] text-destructive">
                    {zoneProblem}
                  </p>
                ) : null}
                <div className="flex items-start gap-2 pt-1">
                  <Checkbox
                    id="analytics-database-timezone-confirm"
                    checked={confirmed}
                    onCheckedChange={(value) => setConfirmed(value === true)}
                  />
                  <Label htmlFor="analytics-database-timezone-confirm" className="text-[13px] leading-snug font-normal">
                    Days, weeks and months are counted in {timezone.trim() || 'this zone'}. It cannot be
                    changed later.
                  </Label>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || name.trim().length === 0 || timezone.trim().length === 0 || !confirmed}>
                {create.isPending ? 'Creating' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateDatabaseDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createDatabase(projectId, name.trim()),
    onSuccess: async (database) => {
      await queryClient.invalidateQueries({ queryKey: ['databases', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      setName('');
      onOpenChange(false);
      await navigate(`/databases/${database.id}/builder`);
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError ? error.message : 'The feedback database could not be created.',
      ),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>New feedback database</DialogTitle>
            <DialogDescription>
              This creates one form. You go straight to the builder.
            </DialogDescription>
          </DialogHeader>

          <div className="my-5 space-y-1.5">
            <Label htmlFor="database-name">Name</Label>
            <Input
              id="database-name"
              value={name}
              autoFocus
              required
              maxLength={200}
              placeholder="In-app feedback"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || name.trim().length === 0}>
              {create.isPending ? 'Creating' : 'Create and open the builder'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CredentialsTab({ projectId }: { projectId: string }) {
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ secret: string; type: string } | null>(null);
  const [revoking, setRevoking] = useState<Credential | null>(null);
  const queryClient = useQueryClient();

  const credentials = useQuery({
    queryKey: ['credentials', projectId],
    queryFn: () => api.listCredentials(projectId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['credentials', projectId] });

  const rotate = useMutation({
    mutationFn: (credentialId: string) => api.rotateCredential(projectId, credentialId),
    onSuccess: async (credential) => {
      await invalidate();
      setRevealed({ secret: credential.secret, type: credential.type });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'That key could not be rotated.'),
  });

  const revoke = useMutation({
    mutationFn: (credentialId: string) => api.revokeCredential(projectId, credentialId),
    onSuccess: async () => {
      await invalidate();
      setRevoking(null);
      toast.success('That key no longer works.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'That key could not be revoked.'),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-1 text-sm text-muted-foreground">
          <p>
            A <strong className="font-medium text-foreground">publishable client key</strong> is
            safe to ship in a browser or mobile app. It can read the published form, open a
            submission intent, upload screenshots and submit.
          </p>
          <p>
            A <strong className="font-medium text-foreground">secret server key</strong> carries
            Admin authority over this project. Keep it on a server. It is shown once.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <PlusIcon />
          New key
        </Button>
      </div>

      {credentials.isLoading ? (
        <Skeleton className="h-32" />
      ) : credentials.data && credentials.data.length > 0 ? (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {credentials.data.map((credential) => (
                <TableRow key={credential.id} className={credential.revokedAt ? 'opacity-60' : ''}>
                  <TableCell>
                    <span className="font-medium">{credential.label}</span>
                    {credential.revokedAt ? (
                      <Badge variant="destructive" className="ml-2">
                        Revoked
                      </Badge>
                    ) : null}
                    {credential.rotatedAt && !credential.revokedAt ? (
                      <Badge variant="muted" className="ml-2">
                        Rotated {formatRelative(credential.rotatedAt)}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={credential.type === 'secret' ? 'primary' : 'default'}>
                      {credential.type === 'secret' ? 'Secret server' : 'Publishable client'}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-64">
                    {credential.revokedAt ? (
                      <span className="text-sm text-muted-foreground">Destroyed on revoke</span>
                    ) : credential.key ? (
                      <CopyField value={credential.key} />
                    ) : (
                      <code className="font-mono text-xs text-muted-foreground">
                        {credential.prefix}
                        {'•'.repeat(8)}
                        {credential.lastFour}
                      </code>
                    )}
                  </TableCell>
                  <TableCell className="numeric text-muted-foreground">
                    {credential.lastUsedAt ? formatRelative(credential.lastUsedAt) : 'Never'}
                  </TableCell>
                  <TableCell>
                    {credential.revokedAt ? null : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Manage ${credential.label}`}>
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => rotate.mutate(credential.id)}>
                            <RotateCwIcon />
                            Rotate
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setRevoking(credential)}
                          >
                            <XCircleIcon />
                            Revoke
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <EmptyState
          icon={<KeyRoundIcon />}
          title="No API keys yet"
          description="Create a publishable client key to integrate your app."
          action={
            <Button onClick={() => setCreating(true)}>
              <PlusIcon />
              Create a key
            </Button>
          }
        />
      )}

      <CreateCredentialDialog
        projectId={projectId}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(credential) => setRevealed({ secret: credential.secret, type: credential.type })}
      />

      <Dialog open={revealed !== null} onOpenChange={() => setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {revealed?.type === 'secret' ? 'Copy this secret server key now' : 'Your new key'}
            </DialogTitle>
            <DialogDescription>
              {revealed?.type === 'secret'
                ? 'This is the only time the full key is shown. Store it where your server can read it.'
                : 'A publishable key stays readable here, so you can copy it again later.'}
            </DialogDescription>
          </DialogHeader>
          {revealed ? <CopyField value={revealed.secret} label="Key" /> : null}
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={() => setRevoking(null)}
        title={`Revoke ${revoking?.label ?? 'this key'}`}
        confirmLabel="Revoke key"
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        description={
          <>
            <p>Every request made with this key is refused from now on.</p>
            <p>
              Any client still using it stops working. The key value is destroyed and cannot be
              recovered.
            </p>
          </>
        }
      />
    </div>
  );
}

function CreateCredentialDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (credential: { secret: string; type: string }) => void;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<'publishable' | 'secret'>('publishable');
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createCredential(projectId, type, label.trim()),
    onSuccess: async (credential) => {
      await queryClient.invalidateQueries({ queryKey: ['credentials', projectId] });
      setLabel('');
      onOpenChange(false);
      onCreated(credential);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'That key could not be created.'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>Keys belong to the project, not to you.</DialogDescription>
          </DialogHeader>

          <div className="my-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="credential-type">Type</Label>
              <Select value={type} onValueChange={(next) => setType(next as typeof type)}>
                <SelectTrigger id="credential-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="publishable">Publishable client key</SelectItem>
                  <SelectItem value="secret">Secret server key</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {type === 'publishable'
                  ? 'Safe to embed in a browser or mobile app. Limited to the feedback flow.'
                  : 'Full Admin authority over this project. Shown once.'}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="credential-label">Label</Label>
              <Input
                id="credential-label"
                value={label}
                required
                maxLength={100}
                placeholder={type === 'publishable' ? 'iOS app' : 'Reporting job'}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || label.trim().length === 0}>
              {create.isPending ? 'Creating' : 'Create key'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SettingsTab({ projectId, name }: { projectId: string; name: string }) {
  const [draftName, setDraftName] = useState(name);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const databases = useQuery({
    queryKey: ['databases', projectId],
    queryFn: () => api.listDatabases(projectId),
  });

  const rename = useMutation({
    mutationFn: () => api.renameProject(projectId, draftName.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project renamed.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'The project could not be renamed.'),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteProject(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project deleted.');
      await navigate('/', { replace: true });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'The project could not be deleted.'),
  });

  const totalSubmissions = (databases.data ?? []).reduce(
    (sum, database) => sum + database.submissionCount,
    0,
  );

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Name</CardTitle>
          <CardDescription>Shown in the project list and in breadcrumbs.</CardDescription>
        </CardHeader>
        <CardContent>
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
              aria-label="Project name"
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
        </CardContent>
      </Card>

      {/* Foundations FD-033: the project's erasure of an installation or user ID. */}
      <ErasePanel projectId={projectId} />

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Delete this project</CardTitle>
          <CardDescription>
            This removes every feedback database, form version, response, screenshot and API key it
            contains. It cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => setDeleting(true)}>
            <TrashIcon />
            Delete project
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${name}`}
        confirmText={name}
        confirmLabel="Delete project"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        description={
          <>
            <p>
              This deletes {pluralize(databases.data?.length ?? 0, 'feedback database')} and{' '}
              {pluralize(totalSubmissions, 'response')}, with every screenshot attached to them.
            </p>
            <p>
              Exports contain data only. Download any screenshots you need before deleting. Every
              API key in this project stops working immediately.
            </p>
          </>
        }
      />
    </div>
  );
}
