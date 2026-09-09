import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type InvitationPreview } from '@/lib/api';
import { Wordmark } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Redeeming an invitation (journey 7.4).
 *
 * Reachable without an account, because for most invitees this is the first Inlet page
 * they ever see. It shows what the link grants before asking for anything, which is
 * the point of the preview endpoint: nobody should have to accept to find out.
 */
export function InvitationPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.previewInvitation(token),
    retry: false,
  });

  const redeem = useMutation({
    mutationFn: () =>
      preview.data?.requiresAccount
        ? api.redeemInvitation(token, {
            email: email.trim(),
            password,
            ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          })
        : api.redeemInvitation(token),
    onSuccess: async (user) => {
      queryClient.setQueryData(['session'], user);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      await navigate('/', { replace: true });
    },
  });

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <Wordmark className="text-lg" />
          <p className="text-sm text-muted-foreground">The self-hosted feedback collector</p>
        </div>

        {preview.isLoading ? (
          <Skeleton className="h-64" />
        ) : preview.error ? (
          <Card>
            <CardHeader>
              <CardTitle>This link does not work</CardTitle>
              <CardDescription>
                {preview.error instanceof ApiError
                  ? preview.error.message
                  : 'The link could not be checked. Try again in a moment.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Ask whoever invited you for a fresh link. Each one works once and expires after
                seven days.
              </p>
            </CardContent>
          </Card>
        ) : preview.data ? (
          <RedeemCard
            preview={preview.data}
            email={email}
            password={password}
            displayName={displayName}
            onEmail={setEmail}
            onPassword={setPassword}
            onDisplayName={setDisplayName}
            pending={redeem.isPending}
            error={
              redeem.error instanceof ApiError
                ? redeem.error.message
                : redeem.error
                  ? 'That did not go through. Try again.'
                  : null
            }
            onSubmit={() => redeem.mutate()}
          />
        ) : null}
      </div>
    </div>
  );
}

function RedeemCard({
  preview,
  email,
  password,
  displayName,
  onEmail,
  onPassword,
  onDisplayName,
  pending,
  error,
  onSubmit,
}: {
  preview: InvitationPreview;
  email: string;
  password: string;
  displayName: string;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onDisplayName: (value: string) => void;
  pending: boolean;
  error: string | null;
  onSubmit: () => void;
}) {
  const scope = preview.scope === 'project' ? 'project' : 'feedback database';

  return (
    <Card>
      <CardHeader>
        <CardTitle>You have been invited</CardTitle>
        <CardDescription>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Badge variant="primary">{preview.role}</Badge>
            <span>
              on the {scope} <strong className="font-medium text-foreground">{preview.scopeName}</strong>
            </span>
            {preview.scope === 'feedback_database' &&
            preview.projectName !== preview.scopeName ? (
              <span>in {preview.projectName}</span>
            ) : null}
          </span>
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {preview.requiresAccount ? (
            <>
              <p className="text-sm text-muted-foreground">
                Choose an email address and a password. That creates your account.
              </p>

              <div className="space-y-1.5">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  autoComplete="username"
                  required
                  autoFocus
                  value={email}
                  onChange={(event) => onEmail(event.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="invite-password">Password</Label>
                <Input
                  id="invite-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  value={password}
                  onChange={(event) => onPassword(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  At least 12 characters. There is no password reset, so store it somewhere safe.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="invite-name">Name</Label>
                <Input
                  id="invite-name"
                  autoComplete="name"
                  placeholder="Optional"
                  value={displayName}
                  onChange={(event) => onDisplayName(event.target.value)}
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              You are already signed in, so accepting adds this access to the account you are
              using.
            </p>
          )}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            disabled={
              pending ||
              (preview.requiresAccount && (email.trim() === '' || password.length < 12))
            }
            data-testid="accept-invitation"
          >
            {pending ? 'Accepting' : 'Accept the invitation'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
