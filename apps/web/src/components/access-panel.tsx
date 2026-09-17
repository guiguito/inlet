import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinkIcon, MailPlusIcon, UserMinusIcon, XCircleIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { Role } from '@inlet/shared';
import { api, ApiError, type Invitation, type Member } from '@/lib/api';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyField } from '@/components/copy-field';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime, formatRelative } from '@/lib/format';

/**
 * The access settings for one scope (FR-070 to FR-074, journey 7.4).
 *
 * The same panel serves a project and a feedback database, because the operations are
 * the same shape and only the scope differs. What differs is spelled out in the copy:
 * on a feedback database an assignment overrides the project role, so the table shows
 * which role each person actually has and where it came from.
 */

export type AccessScope =
  | { kind: 'project'; projectId: string; name: string }
  | { kind: 'feedbackDatabase'; databaseId: string; name: string }
  /** FD-007: a crash database; the API calls route on the `cdb_` prefix. */
  | { kind: 'crashDatabase'; databaseId: string; name: string };

const ROLE_HELP: Record<Role, string> = {
  admin: 'Manages access, credentials and deletion, and everything a Creator can do.',
  creator: 'Builds and publishes forms, and reads responses.',
  viewer: 'Reads responses. Changes nothing.',
};

export function AccessPanel({
  scope,
  currentUserId,
}: {
  scope: AccessScope;
  /**
   * Whose view this is. Only an Admin of the scope may manage access (FR-073), so the
   * panel reads the caller's own effective role out of the member list rather than
   * offering controls the API will refuse. It also stops the invitations section
   * looking empty to someone who is simply not allowed to see it.
   */
  currentUserId: string;
}) {
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<{ url: string; role: Role } | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const queryClient = useQueryClient();

  const isProject = scope.kind === 'project';
  const scopeKey = isProject ? scope.projectId : scope.databaseId;

  const members = useQuery({
    queryKey: ['members', scope.kind, scopeKey],
    queryFn: () =>
      isProject ? api.listProjectMembers(scope.projectId) : api.listDatabaseMembers(scope.databaseId),
  });

  const canManage =
    (members.data ?? []).find((member) => member.userId === currentUserId)?.effectiveRole ===
    'admin';

  const invitations = useQuery({
    queryKey: ['invitations', scope.kind, scopeKey],
    queryFn: () =>
      isProject
        ? api.listProjectInvitations(scope.projectId)
        : api.listDatabaseInvitations(scope.databaseId),
    enabled: canManage,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['members', scope.kind, scopeKey] });
    await queryClient.invalidateQueries({ queryKey: ['invitations', scope.kind, scopeKey] });
  };

  const invite = useMutation({
    mutationFn: (role: Role) =>
      isProject ? api.inviteToProject(scope.projectId, role) : api.inviteToDatabase(scope.databaseId, role),
    onSuccess: async (invitation) => {
      await refresh();
      setInviting(false);
      setIssued({ url: invitation.url, role: invitation.role });
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError ? error.message : 'The invitation could not be created.',
      ),
  });

  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      isProject
        ? api.setProjectRole(scope.projectId, userId, role)
        : api.setDatabaseRole(scope.databaseId, userId, role),
    onSuccess: async () => {
      await refresh();
      toast.success('Access updated.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'That change did not go through.'),
  });

  const remove = useMutation({
    mutationFn: (userId: string) =>
      isProject
        ? api.removeProjectMember(scope.projectId, userId)
        : api.clearDatabaseRole(scope.databaseId, userId),
    onSuccess: async () => {
      await refresh();
      setRemoving(null);
      toast.success(isProject ? 'Removed from the project.' : 'Assignment cleared.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'That change did not go through.'),
  });

  const revoke = useMutation({
    mutationFn: (invitationId: string) =>
      isProject
        ? api.revokeProjectInvitation(scope.projectId, invitationId)
        : api.revokeDatabaseInvitation(scope.databaseId, invitationId),
    onSuccess: async () => {
      await refresh();
      toast.success('That link no longer works.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'The invitation could not be revoked.'),
  });

  const adminCount = (members.data ?? []).filter((m) => m.effectiveRole === 'admin').length;
  const pending = (invitations.data ?? []).filter((entry) => entry.status === 'pending');
  const past = (invitations.data ?? []).filter((entry) => entry.status !== 'pending');

  return (
    <div className="max-w-4xl space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Who has access</CardTitle>
            <CardDescription>
              {isProject
                ? 'A project role applies to every feedback database in the project.'
                : 'An assignment here overrides the project role for this feedback database only. A project Admin keeps full access and cannot be narrowed.'}
            </CardDescription>
          </div>
          {canManage ? (
            <Button onClick={() => setInviting(true)} data-testid="invite-member">
              <MailPlusIcon />
              Invite
            </Button>
          ) : null}
        </CardHeader>

        <CardContent className="p-0 pb-2">
          {members.isLoading ? (
            <Skeleton className="mx-5 h-24" />
          ) : members.data && members.data.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead className="w-44">Role</TableHead>
                  {isProject ? null : <TableHead className="w-28">Source</TableHead>}
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.data.map((member) => (
                  <TableRow key={member.userId} data-testid={`member-${member.email}`}>
                    <TableCell>
                      <span className="font-medium">{member.displayName}</span>
                      <p className="text-xs text-muted-foreground">{member.email}</p>
                    </TableCell>
                    <TableCell>
                      <RolePicker
                        value={member.role}
                        // FR-014: the last Admin cannot be downgraded, so the control
                        // says so rather than letting the attempt fail.
                        disabled={
                          !canManage ||
                          setRole.isPending ||
                          (isProject && member.role === 'admin' && adminCount <= 1)
                        }
                        onChange={(role) => setRole.mutate({ userId: member.userId, role })}
                      />
                    </TableCell>
                    {isProject ? null : (
                      <TableCell>
                        <Badge variant={member.inherited ? 'muted' : 'primary'}>
                          {member.inherited ? 'Project' : 'Assigned'}
                        </Badge>
                      </TableCell>
                    )}
                    <TableCell>
                      {!canManage ? null : isProject &&
                        member.role === 'admin' &&
                        adminCount <= 1 ? null : member.inherited && !isProject ? null : (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={
                            isProject
                              ? `Remove ${member.email} from the project`
                              : `Clear the assignment for ${member.email}`
                          }
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setRemoving(member)}
                        >
                          <UserMinusIcon />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="px-5 pb-3">
              <EmptyState title="Nobody has access yet" />
            </div>
          )}
        </CardContent>
      </Card>

      {canManage ? (
      <Card>
        <CardHeader>
          <CardTitle>Invitations</CardTitle>
          <CardDescription>
            Inlet sends no email. Create a link, then pass it on however you like. Each link
            works once and expires after seven days.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pb-2">
          {invitations.isLoading ? (
            <Skeleton className="mx-5 h-16" />
          ) : pending.length === 0 && past.length === 0 ? (
            <div className="px-5 pb-3">
              <EmptyState
                icon={<LinkIcon />}
                title="No invitations yet"
                description="Invite someone and you will get a link to send them."
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...pending, ...past].map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell className="font-medium">{invitation.role}</TableCell>
                    <TableCell>
                      <InvitationStatus invitation={invitation} />
                    </TableCell>
                    <TableCell className="numeric text-muted-foreground">
                      {formatRelative(invitation.createdAt)}
                    </TableCell>
                    <TableCell>
                      {invitation.status === 'pending' ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Revoke this invitation"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(invitation.id)}
                        >
                          <XCircleIcon />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          Access here is managed by an Admin of this {isProject ? 'project' : 'feedback database'}.
        </p>
      )}

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        scopeName={scope.name}
        isProject={isProject}
        pending={invite.isPending}
        onInvite={(role) => invite.mutate(role)}
      />

      <Dialog open={issued !== null} onOpenChange={() => setIssued(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send this link</DialogTitle>
            <DialogDescription>
              It grants {issued?.role} access to {scope.name}, works once, and expires in seven
              days. This is the only time it is shown.
            </DialogDescription>
          </DialogHeader>
          {issued ? <CopyField value={issued.url} label="Invitation link" /> : null}
          <DialogFooter>
            <Button onClick={() => setIssued(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={() => setRemoving(null)}
        title={
          isProject
            ? `Remove ${removing?.displayName ?? 'this person'}`
            : `Clear the assignment for ${removing?.displayName ?? 'this person'}`
        }
        confirmLabel={isProject ? 'Remove from project' : 'Clear assignment'}
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.userId)}
        description={
          isProject ? (
            <>
              <p>
                They lose access to every feedback database in {scope.name}, and any assignment
                they had inside it goes with them.
              </p>
              <p>Their account stays, so you can invite them again later.</p>
            </>
          ) : (
            <p>
              They keep whatever their project role gives them. This removes the override, not
              their access.
            </p>
          )
        }
      />
    </div>
  );
}

function RolePicker({
  value,
  disabled,
  onChange,
}: {
  value: Role;
  disabled: boolean;
  onChange: (role: Role) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as Role)}>
      <SelectTrigger aria-label="Role">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(['admin', 'creator', 'viewer'] as const).map((role) => (
          <SelectItem key={role} value={role}>
            {role}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function InvitationStatus({ invitation }: { invitation: Invitation }) {
  if (invitation.status === 'redeemed') {
    return (
      <span className="text-sm">
        <Badge variant="default">Accepted</Badge>
        {invitation.redeemedByEmail ? (
          <span className="ml-2 text-xs text-muted-foreground">
            {invitation.redeemedByEmail}
          </span>
        ) : null}
      </span>
    );
  }
  if (invitation.status === 'revoked') return <Badge variant="destructive">Revoked</Badge>;
  if (invitation.status === 'expired') return <Badge variant="outline">Expired</Badge>;
  return (
    <span className="text-sm">
      <Badge variant="primary">Waiting</Badge>
      <span className="ml-2 text-xs text-muted-foreground numeric">
        expires {formatDateTime(invitation.expiresAt)}
      </span>
    </span>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  scopeName,
  isProject,
  pending,
  onInvite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopeName: string;
  isProject: boolean;
  pending: boolean;
  onInvite: (role: Role) => void;
}) {
  const [role, setRole] = useState<Role>('viewer');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onInvite(role);
          }}
        >
          <DialogHeader>
            <DialogTitle>Invite someone to {scopeName}</DialogTitle>
            <DialogDescription>
              {isProject
                ? 'They will reach every feedback database in this project.'
                : 'They will reach this feedback database only.'}
            </DialogDescription>
          </DialogHeader>

          <div className="my-5 space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={(next) => setRole(next as Role)}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['admin', 'creator', 'viewer'] as const).map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{ROLE_HELP[role]}</p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating' : 'Create the link'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
