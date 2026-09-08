import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, TrashIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type CurrentUser } from '@/lib/api';
import { AppShell, PageHeader } from '@/components/app-shell';
import { AnswerList } from '@/components/answer-view';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes, formatDateTime, pluralize } from '@/lib/format';

/**
 * One submission (FR-064, FR-064A, FR-065, FR-068).
 *
 * Layout per PRD section 20.5: the screenshot leads, the answers sit beside it, and
 * the operational metadata goes below.
 */
export function SubmissionPage({ user }: { user: CurrentUser }) {
  const { databaseId = '', submissionId = '' } = useParams();
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  const submission = useQuery({
    queryKey: ['submission', databaseId, submissionId],
    queryFn: () => api.getSubmission(databaseId, submissionId),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteSubmission(databaseId, submissionId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['submissions', databaseId] });
      await queryClient.invalidateQueries({ queryKey: ['database', databaseId] });
      toast.success('Response deleted, with its screenshots.');
      await navigate(`/databases/${databaseId}`, { replace: true });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'The deletion did not complete.'),
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
        { label: database.data?.name ?? 'Feedback database', to: `/databases/${databaseId}` },
        { label: 'Response' },
      ]}
    >
      {submission.isLoading ? (
        <Skeleton className="h-72" />
      ) : submission.error ? (
        <EmptyState
          title="This response could not be loaded"
          description={
            submission.error instanceof ApiError
              ? submission.error.message
              : 'Try reloading the page.'
          }
          action={
            <Button variant="outline" asChild>
              <Link to={`/databases/${databaseId}`}>Back to responses</Link>
            </Button>
          }
        />
      ) : submission.data ? (
        <>
          <PageHeader
            title={formatDateTime(submission.data.createdAt)}
            description={`Answered against form version ${submission.data.formVersion}`}
            actions={
              <>
                <Button variant="ghost" size="sm" asChild>
                  <Link to={`/databases/${databaseId}`}>
                    <ArrowLeftIcon />
                    All responses
                  </Link>
                </Button>
                <Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>
                  <TrashIcon />
                  Delete
                </Button>
              </>
            }
          />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
            {submission.data.attachments.length > 0 ? (
              <div className="space-y-3">
                {submission.data.attachments.map((file) => (
                  <Card key={file.id} className="overflow-hidden">
                    <a
                      href={api.attachmentPath(file.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="block"
                    >
                      <img
                        src={api.attachmentPath(file.id)}
                        alt={`Screenshot ${file.id}`}
                        width={file.width}
                        height={file.height}
                        className="w-full bg-muted object-contain"
                      />
                    </a>
                    <CardContent className="flex items-center justify-between gap-2 p-3 pt-3 text-xs text-muted-foreground">
                      <span className="numeric">
                        {file.width} × {file.height}
                      </span>
                      <span className="numeric">{formatBytes(file.bytes)}</span>
                      <Badge variant="muted">{file.mediaType.replace('image/', '')}</Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : null}

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Answers</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <AnswerList
                    definition={submission.data.formDefinition}
                    answers={submission.data.answers}
                    attachments={submission.data.attachments}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Metadata</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 pt-0 text-sm">
                  <MetaRow label="Response ID" value={submission.data.id} mono />
                  <MetaRow label="Received" value={formatDateTime(submission.data.createdAt)} />
                  <MetaRow label="Form version" value={String(submission.data.formVersion)} />
                  <MetaRow
                    label="Observed IP"
                    value={submission.data.observedIp ?? 'Not recorded'}
                    mono
                    note="The address the request came from, after trusted-proxy resolution. For a server-to-server submission this is the integrating server, not the respondent."
                  />
                  <MetaRow
                    label="Screenshots"
                    value={pluralize(submission.data.attachments.length, 'file')}
                  />

                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Client context</p>
                    {submission.data.clientContext === null ||
                    submission.data.clientContext === undefined ? (
                      <p className="text-sm text-muted-foreground/70">None supplied</p>
                    ) : (
                      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
                        {JSON.stringify(submission.data.clientContext, null, 2)}
                      </pre>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Supplied by your client and stored exactly as sent. You are responsible for
                      what it contains.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title="Delete this response"
            confirmLabel="Delete response"
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
            description={
              <>
                <p>
                  This deletes the answers, any collected email address, and{' '}
                  {pluralize(submission.data.attachments.length, 'screenshot')}. It cannot be
                  undone.
                </p>
                <p>
                  If the original client retries its submission afterwards, it is told the response
                  was deleted rather than having it recreated.
                </p>
              </>
            }
          />
        </>
      ) : null}
    </AppShell>
  );
}

function MetaRow({
  label,
  value,
  mono = false,
  note,
}: {
  label: string;
  value: string;
  mono?: boolean;
  note?: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={mono ? 'font-mono text-xs' : 'text-sm'}>{value}</p>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
