import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { profileHref, type UsageProfileLink } from '@/lib/analytics-profiles';

/**
 * AN-154, FR-066: the "Usage profile" link of a crash report or a submission. Asked separately,
 * after the view has loaded, so the view never waits on the event store; the API answers an
 * empty list when no readable analytics database holds the installation or the store does not
 * answer, and so does a failed request here: the link is simply left out. When several readable
 * databases hold the installation, each gets a link named after its database, the most recently
 * seen first.
 */
export function UsageProfileLinks({ queryKey, load }: { queryKey: readonly unknown[]; load: () => Promise<{ profiles: UsageProfileLink[] }> }) {
  const links = useQuery({ queryKey: ['usage-profile', ...queryKey], queryFn: load, retry: false, staleTime: 60_000 });
  const profiles = links.data?.profiles ?? [];
  if (profiles.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-3" data-testid="usage-profile-links">
      {profiles.map((profile) => (
        <Link key={profile.analyticsDatabaseId} className="underline underline-offset-4" to={profileHref(profile.analyticsDatabaseId, { kind: 'installation', id: profile.installationId })}>
          {profiles.length > 1 ? `Usage profile in ${profile.analyticsDatabaseName}` : 'Usage profile'}
        </Link>
      ))}
    </span>
  );
}
