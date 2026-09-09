import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DownloadIcon,
  ExternalLinkIcon,
  InboxIcon,
  PencilRulerIcon,
  RotateCcwIcon,
  TrashIcon,
  UploadIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type CurrentUser, type FormVersion } from '@/lib/api';
import { AccessPanel } from '@/components/access-panel';
import { AppShell, PageHeader } from '@/components/app-shell';
import { answerPreview } from '@/components/answer-view';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyField } from '@/components/copy-field';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDateTime, pluralize } from '@/lib/format';

/**
 * One feedback database: its responses, how to integrate it, its published versions,
 * and its settings (FR-021 to FR-025, FR-042E to FR-042G, FR-063, FR-110).
 */
export function DatabasePage({ user }: { user: CurrentUser }) {
  const { databaseId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'responses';

  const database = useQuery({
    queryKey: ['database', databaseId],
    queryFn: () => api.getDatabase(databaseId),
  });

  // The database response carries only its project's ID, so the project is fetched to
  // name it in the breadcrumb.
  const project = useQuery({
    queryKey: ['project', database.data?.projectId],
    queryFn: () => api.getProject(database.data?.projectId ?? ''),
    enabled: Boolean(database.data?.projectId),
  });

  return (
    <AppShell
      user={user}
      crumbs={[
        { label: 'Projects', to: '/' },
        {
          label: project.data?.name ?? 'Project',
          ...(database.data ? { to: `/projects/${database.data.projectId}` } : {}),
        },
        { label: database.data?.name ?? 'Feedback database' },
      ]}
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
          <PageHeader
            title={database.data.name}
            description={`${pluralize(database.data.submissionCount, 'response')} collected`}
            actions={
              <>
                {database.data.activeFormVersion === null ? (
                  <Badge variant="outline">Unpublished</Badge>
                ) : (
                  <Badge variant="primary">Version {database.data.activeFormVersion}</Badge>
                )}
                <Button variant="outline" asChild>
                  <Link to={`/databases/${databaseId}/builder`}>
                    <PencilRulerIcon />
                    Open the builder
                  </Link>
                </Button>
              </>
            }
          />

          <Tabs
            value={tab}
            onValueChange={(next) => setParams(next === 'responses' ? {} : { tab: next })}
          >
            <TabsList>
              <TabsTrigger value="responses">Responses</TabsTrigger>
              <TabsTrigger value="integrate">Integrate</TabsTrigger>
              <TabsTrigger value="versions">Versions</TabsTrigger>
              <TabsTrigger value="access">Access</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>

            <TabsContent value="responses">
              <ResponsesTab databaseId={databaseId} />
            </TabsContent>
            <TabsContent value="integrate">
              <IntegrateTab databaseId={databaseId} projectId={database.data.projectId} />
            </TabsContent>
            <TabsContent value="versions">
              <VersionsTab databaseId={databaseId} />
            </TabsContent>
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
            <TabsContent value="settings">
              <SettingsTab
                databaseId={databaseId}
                projectId={database.data.projectId}
                name={database.data.name}
              />
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </AppShell>
  );
}

function ResponsesTab({ databaseId }: { databaseId: string }) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const versions = useQuery({
    queryKey: ['versions', databaseId],
    queryFn: () => api.listVersions(databaseId),
  });
  const page = useQuery({
    queryKey: ['submissions', databaseId, cursor ?? 'first'],
    queryFn: () => api.listSubmissions(databaseId, { limit: 25, ...(cursor ? { cursor } : {}) }),
  });

  const definitionFor = (version: number) =>
    versions.data?.find((candidate) => candidate.version === version)?.definition;

  if (page.isLoading) return <Skeleton className="h-48" />;

  if (page.error) {
    return (
      <EmptyState
        title="Responses could not be loaded"
        description={page.error instanceof ApiError ? page.error.message : 'Try reloading.'}
      />
    );
  }

  if (!page.data || page.data.total === 0) {
    return (
      <EmptyState
        icon={<InboxIcon />}
        title="No responses yet"
        description="Publish the form and point your app at this feedback database. Responses appear here as they arrive."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground numeric">
          {pluralize(page.data.total, 'response')}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={api.exportUrl(databaseId, 'json')} download>
              <DownloadIcon />
              Export JSON
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={api.exportUrl(databaseId, 'csv')} download>
              <DownloadIcon />
              Export CSV
            </a>
          </Button>
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Received</TableHead>
              <TableHead>Response</TableHead>
              <TableHead className="w-20">Version</TableHead>
              <TableHead className="w-24 text-right">Screenshots</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.data.submissions.map((submission) => (
              <TableRow key={submission.id}>
                <TableCell className="numeric whitespace-nowrap text-muted-foreground">
                  <Link
                    to={`/databases/${databaseId}/submissions/${submission.id}`}
                    className="hover:text-primary"
                  >
                    {formatDateTime(submission.createdAt)}
                  </Link>
                </TableCell>
                <TableCell className="max-w-md">
                  <Link
                    to={`/databases/${databaseId}/submissions/${submission.id}`}
                    className="line-clamp-1 hover:text-primary"
                  >
                    {answerPreview(definitionFor(submission.formVersion), submission.answers) ||
                      'Open the response'}
                  </Link>
                </TableCell>
                <TableCell className="numeric">{submission.formVersion}</TableCell>
                <TableCell className="numeric text-right">
                  {submission.attachmentCount > 0 ? submission.attachmentCount : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {page.data.nextCursor ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setCursor(page.data.nextCursor ?? undefined)}>
            Load more
          </Button>
        </div>
      ) : null}

      {cursor ? (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
            Back to the newest
          </Button>
        </div>
      ) : null}
    </div>
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
          <CardTitle>Collect feedback in four calls</CardTitle>
          <CardDescription>
            Read the form, open an intent, attach any screenshots, then submit everything at once.
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
