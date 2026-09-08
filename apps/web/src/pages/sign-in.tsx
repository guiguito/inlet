import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { api, ApiError } from '@/lib/api';
import { Wordmark } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * FR-001, FR-001A: email and password only, and no registration link, because an
 * account exists only through the deployment bootstrap or an invitation.
 */
export function SignInPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const signIn = useMutation({
    mutationFn: () => api.signIn(email.trim(), password),
    onSuccess: async (user) => {
      queryClient.setQueryData(['session'], user);
      const from = (location.state as { from?: string } | null)?.from;
      await navigate(from && from !== '/sign-in' ? from : '/', { replace: true });
    },
  });

  const message =
    signIn.error instanceof ApiError
      ? signIn.error.message
      : signIn.error
        ? 'Sign-in could not be completed. Try again.'
        : null;

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <Wordmark className="text-lg" />
          <p className="text-sm text-muted-foreground">The self-hosted feedback collector</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Use the account this deployment was configured with.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                signIn.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  autoFocus
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              {message ? (
                <p role="alert" className="text-sm text-destructive">
                  {message}
                </p>
              ) : null}

              <Button type="submit" className="w-full" disabled={signIn.isPending}>
                {signIn.isPending ? 'Signing in' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Accounts are created by the deployment, not by signing up.
        </p>
      </div>
    </div>
  );
}
