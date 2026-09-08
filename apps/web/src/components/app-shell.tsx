import { Link, useLocation } from 'react-router';
import { BookOpenIcon, LogOutIcon } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CurrentUser } from '@/lib/api';
import { Wordmark } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type Crumb = { label: string; to?: string };

export function AppShell({
  user,
  crumbs = [],
  actions,
  children,
}: {
  user: CurrentUser;
  crumbs?: Crumb[];
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const queryClient = useQueryClient();

  const signOut = useMutation({
    mutationFn: () => api.signOut(),
    onSuccess: () => {
      queryClient.clear();
      window.location.assign('/sign-in');
    },
  });

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="shrink-0" aria-label="Inlet home">
            <Wordmark />
          </Link>

          <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              {crumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
                  <span aria-hidden="true" className="text-border">
                    /
                  </span>
                  {crumb.to && index < crumbs.length - 1 ? (
                    <Link className="truncate hover:text-foreground" to={crumb.to}>
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="truncate text-foreground">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>

          <div className="flex shrink-0 items-center gap-1">
            {actions}
            <Button variant="ghost" size="icon-sm" asChild title="API documentation">
              <a href="/docs" target="_blank" rel="noreferrer" aria-label="API documentation">
                <BookOpenIcon />
              </a>
            </Button>
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Account">
                  <span className="grid size-6 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                    {user.displayName.slice(0, 1).toUpperCase()}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => signOut.mutate()}
                  data-testid="sign-out"
                >
                  <LogOutIcon />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main key={location.pathname} className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {children}
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
