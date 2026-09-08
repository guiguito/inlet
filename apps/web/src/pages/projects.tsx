import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlusIcon, InboxIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type CurrentUser } from '@/lib/api';
import { AppShell, PageHeader } from '@/components/app-shell';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelative, pluralize } from '@/lib/format';

/** FR-010, FR-011: create and list projects. */
export function ProjectsPage({ user }: { user: CurrentUser }) {
  const [creating, setCreating] = useState(false);
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.listProjects() });

  return (
    <AppShell user={user} crumbs={[{ label: 'Projects' }]}>
      <PageHeader
        title="Projects"
        description="A project holds your feedback databases and the API keys that reach them."
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            New project
          </Button>
        }
      />

      {projects.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : projects.error ? (
        <EmptyState
          title="Projects could not be loaded"
          description={
            projects.error instanceof ApiError ? projects.error.message : 'Try reloading the page.'
          }
        />
      ) : projects.data && projects.data.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {projects.data.map((project) => (
            <li key={project.id}>
              <Card className="transition-colors hover:border-primary/40">
                <CardContent className="p-5">
                  <Link to={`/projects/${project.id}`} className="block space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="font-medium leading-tight">{project.name}</h2>
                      <Badge variant="muted">{project.role}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {pluralize(project.feedbackDatabaseCount, 'feedback database')}
                      <span aria-hidden="true"> · </span>
                      <span className="numeric">created {formatRelative(project.createdAt)}</span>
                    </p>
                  </Link>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<InboxIcon />}
          title="No projects yet"
          description="Create a project, add a feedback database, then build its form."
          action={
            <Button onClick={() => setCreating(true)}>
              <FolderPlusIcon />
              Create your first project
            </Button>
          }
        />
      )}

      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </AppShell>
  );
}

function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createProject(name.trim()),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(`Project "${project.name}" is ready.`);
      setName('');
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'The project could not be created.');
    },
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
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>You become this project's Admin.</DialogDescription>
          </DialogHeader>

          <div className="my-5 space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              autoFocus
              required
              maxLength={200}
              placeholder="Deblock App"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || name.trim().length === 0}>
              {create.isPending ? 'Creating' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
