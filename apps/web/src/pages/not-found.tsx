import { Link } from 'react-router';
import { AppShell } from '@/components/app-shell';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import type { CurrentUser } from '@/lib/api';

export function NotFoundPage({ user }: { user: CurrentUser }) {
  return (
    <AppShell user={user} crumbs={[{ label: 'Not found' }]}>
      <EmptyState
        title="That page does not exist"
        description="The link may be out of date, or the resource may have been deleted."
        action={
          <Button asChild variant="outline">
            <Link to="/">Back to projects</Link>
          </Button>
        }
      />
    </AppShell>
  );
}
