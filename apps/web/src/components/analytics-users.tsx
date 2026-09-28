import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, DownloadIcon, EraserIcon, SearchIcon } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  profileHref,
  profilesApi,
  type InstallationProfile,
  type InstallationSummary,
  type ProfileDimensions,
  type ProfileEvent,
  type ProfileLinks,
  type ProfileSubject,
  type UserProfile,
} from '@/lib/analytics-profiles';
import { queryErrorSentence } from '@/components/analytics-events';
import { CountryAttribution } from '@/components/country-attribution';
import { EmptyState } from '@/components/empty-state';
import { ERASE_PURPOSE, ErasePanel } from '@/components/erase-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { bySession } from '@/lib/analytics-format';
import { formatDateTime, pluralize } from '@/lib/format';

/**
 * Users (UX Analytics PRD 8.1, AN-120 to AN-126): a search box for an installation ID, a user
 * ID or a prefix of either; the recently seen installations with their filters and paging; and
 * a profile — header, context, identity history, counts and the calendar of active days, the
 * event feed grouped by session, the linked crash groups and submissions, and Export. The
 * profile's subject is in the address (`installation` or `user`), so a link from a crash report
 * or a submission opens it. Every user-authored string (user IDs, params, attribution, answers)
 * is rendered as text.
 */

const FILTERS = [
  ['platform', 'Platform'],
  ['appVersion', 'App version'],
  ['country', 'Country'],
] as const;

function when(value: string | null): string {
  return value ? formatDateTime(value) : '—';
}

/** `eraseIn`: the project, when the caller is a database or project Admin, who may erase a profile (AN-183). */
export function UsersPanel({ databaseId, unreachable, eraseIn }: { databaseId: string; unreachable: string; eraseIn?: string | undefined }) {
  const [params] = useSearchParams();
  const installation = params.get('installation');
  const user = params.get('user');
  if (installation) return <ProfileView databaseId={databaseId} subject={{ kind: 'installation', id: installation }} unreachable={unreachable} eraseIn={eraseIn} />;
  if (user) return <ProfileView databaseId={databaseId} subject={{ kind: 'user', id: user }} unreachable={unreachable} eraseIn={eraseIn} />;
  return <ProfileSearch databaseId={databaseId} unreachable={unreachable} />;
}

// --- Search and the recent installations -----------------------------------------------------------

function ProfileSearch({ databaseId, unreachable }: { databaseId: string; unreachable: string }) {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const filters = Object.fromEntries(FILTERS.map(([key]) => [key, params.get(key) ?? ''])) as Record<(typeof FILTERS)[number][0], string>;
  // Previous pages' cursors, so Back returns to them; the first page has none.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);

  const update = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    setCursors([]);
    setParams(merged);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update({ q: draft.trim() });
  };

  const list = useQuery({
    queryKey: ['analytics-profiles', databaseId, q, filters, cursor],
    queryFn: () => profilesApi.find(databaseId, { ...(q ? { q } : filters), ...(cursor ? { cursor } : {}) }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="mt-4 space-y-4" data-testid="users-panel">
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit} role="search">
        <div className="min-w-72 flex-1 space-y-1.5">
          <Label htmlFor="profile-search">Installation ID or user ID</Label>
          <Input id="profile-search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Paste an ID, or type at least six characters of one" />
        </div>
        <Button type="submit">
          <SearchIcon /> Search
        </Button>
        {q ? (
          <Button type="button" variant="ghost" onClick={() => (setDraft(''), update({ q: '' }))}>
            Clear
          </Button>
        ) : null}
      </form>

      {q ? null : (
        <div className="flex flex-wrap gap-2" aria-label="Filter the recent installations by their latest values">
          {FILTERS.map(([key, label]) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`profile-filter-${key}`} className="text-xs text-muted-foreground">
                {label}
              </Label>
              <Input id={`profile-filter-${key}`} className="h-8 w-36" defaultValue={filters[key]} onBlur={(event) => update({ [key]: event.target.value.trim() })} onKeyDown={(event) => event.key === 'Enter' && update({ [key]: event.currentTarget.value.trim() })} />
            </div>
          ))}
        </div>
      )}

      {list.isLoading ? (
        <Skeleton className="h-40" />
      ) : list.error ? (
        <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
          {queryErrorSentence(list.error, unreachable)}
        </p>
      ) : list.data ? (
        <>
          {list.data.notice === 'prefix_too_short' ? (
            <p className="text-sm text-muted-foreground" data-testid="prefix-notice">
              Only exact IDs were matched: type at least six characters to search by the start of an ID.
            </p>
          ) : null}
          {list.data.users.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>User IDs</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="space-y-1 text-sm">
                  {list.data.users.map((user) => (
                    <li key={user.userId}>
                      <Link className="font-mono text-xs underline underline-offset-4" to={profileHref(databaseId, { kind: 'user', id: user.userId })}>
                        {user.userId}
                      </Link>{' '}
                      <span className="text-muted-foreground">
                        · {pluralize(user.installations, 'installation')} · last seen {when(user.lastSeen)}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
          {list.data.installations.length === 0 && list.data.users.length === 0 ? (
            <EmptyState title={q ? 'No profile matches' : 'No installation yet'} description={q ? 'Check the ID, or search by at least six of its first characters.' : 'Installations appear here once they send events.'} />
          ) : list.data.installations.length > 0 ? (
            <InstallationTable databaseId={databaseId} rows={list.data.installations} caption={q ? 'Matching installations' : 'Recently seen installations, newest first'} />
          ) : null}
          {list.data.truncated ? <p className="text-xs text-muted-foreground">More profiles match; type more of the ID.</p> : null}
          {q ? null : (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>
                Previous page
              </Button>
              <Button variant="outline" size="sm" disabled={!list.data.nextCursor} onClick={() => list.data.nextCursor && setCursors([...cursors, list.data.nextCursor])}>
                Next page
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function Flags({ server, ephemeral }: { server: boolean; ephemeral: boolean }) {
  return (
    <>
      {server ? <Badge variant="outline">server</Badge> : null}
      {ephemeral ? <Badge variant="outline">ephemeral</Badge> : null}
    </>
  );
}

function InstallationTable({ databaseId, rows, caption, userColumn = true }: { databaseId: string; rows: (InstallationSummary & { userLastSeen?: string })[]; caption: string; userColumn?: boolean }) {
  return (
    <Table data-testid="installation-table">
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>Installation</TableHead>
          {userColumn ? <TableHead>User ID</TableHead> : null}
          <TableHead>Platform</TableHead>
          <TableHead>App version</TableHead>
          <TableHead>Country</TableHead>
          <TableHead>Last seen</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.installationId}>
            <TableCell>
              <Link className="font-mono text-xs underline underline-offset-4" to={profileHref(databaseId, { kind: 'installation', id: row.installationId })}>
                {row.installationId}
              </Link>{' '}
              <Flags server={row.server} ephemeral={row.ephemeral} />
            </TableCell>
            {userColumn ? <TableCell className="font-mono text-xs">{row.userId ?? '—'}</TableCell> : null}
            <TableCell>{[row.platform, row.platformVersion].filter(Boolean).join(' ') || '—'}</TableCell>
            <TableCell>{row.appVersion ?? '—'}</TableCell>
            <TableCell>{row.country ?? '—'}</TableCell>
            <TableCell className="numeric">{when(row.lastSeen ?? row.lastEvent)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// --- A profile ---------------------------------------------------------------------------------------

function ProfileView({ databaseId, subject, unreachable, eraseIn }: { databaseId: string; subject: ProfileSubject; unreachable: string; eraseIn?: string | undefined }) {
  const [params, setParams] = useSearchParams();
  const back = () => {
    const next = new URLSearchParams(params);
    next.delete('installation');
    next.delete('user');
    setParams(next);
  };
  const profile = useQuery<InstallationProfile | UserProfile>({
    queryKey: ['analytics-profile', databaseId, subject.kind, subject.id],
    queryFn: () => (subject.kind === 'installation' ? profilesApi.installation(databaseId, subject.id) : profilesApi.user(databaseId, subject.id)),
    retry: false,
  });

  return (
    <div className="mt-4 space-y-4" data-testid="profile-view">
      <Button variant="ghost" size="sm" onClick={back}>
        <ArrowLeftIcon /> Users
      </Button>
      {profile.isLoading ? (
        <Skeleton className="h-64" />
      ) : profile.error ? (
        profile.error instanceof ApiError && profile.error.code === 'profile_not_found' ? (
          <EmptyState title="No such profile" description={`This database holds no ${subject.kind === 'installation' ? 'installation' : 'user'} of that ID, or it has been erased or aged out of the storage window.`} />
        ) : (
          <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
            {queryErrorSentence(profile.error, unreachable)}
          </p>
        )
      ) : profile.data ? (
        <>
          <ProfileHeader databaseId={databaseId} subject={subject} profile={profile.data} eraseIn={eraseIn} />
          <div className="grid gap-4 lg:grid-cols-2">
            {profile.data.kind === 'installation' ? <ContextCard profile={profile.data} /> : <UserInstallations databaseId={databaseId} profile={profile.data} />}
            <CountsCard profile={profile.data} />
          </div>
          {profile.data.kind === 'installation' ? <IdentityHistory profile={profile.data} databaseId={databaseId} /> : null}
          <LinksCards links={profile.data.links} />
          <EventFeed databaseId={databaseId} subject={subject} unreachable={unreachable} />
        </>
      ) : null}
    </div>
  );
}

function ProfileHeader({ databaseId, subject, profile, eraseIn }: { databaseId: string; subject: ProfileSubject; profile: InstallationProfile | UserProfile; eraseIn?: string | undefined }) {
  const queryClient = useQueryClient();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold tracking-tight">{profile.kind === 'installation' ? 'Installation' : 'User'}</h2>
        {profile.kind === 'installation' ? (
          <>
            <p className="break-all font-mono text-sm" data-testid="profile-installation-id">
              {profile.installation.installationId} <Flags server={profile.installation.server} ephemeral={profile.installation.ephemeral} />
            </p>
            {profile.installation.userId ? (
              <p className="text-sm">
                User ID{' '}
                <Link className="font-mono text-xs underline underline-offset-4" to={profileHref(databaseId, { kind: 'user', id: profile.installation.userId })}>
                  {profile.installation.userId}
                </Link>
              </p>
            ) : null}
            <p className="text-[13px] text-muted-foreground">
              Installed {when(profile.installation.installTime)} · first seen {when(profile.installation.firstSeen)} · last seen {when(profile.installation.lastSeen)} · last event {when(profile.installation.lastEvent)}
            </p>
          </>
        ) : (
          <>
            <p className="break-all font-mono text-sm" data-testid="profile-user-id">
              {profile.user.userId}
            </p>
            <p className="text-[13px] text-muted-foreground">
              First seen {when(profile.user.firstSeen)} · last seen {when(profile.user.lastSeen)} · {pluralize(profile.user.installations, 'installation')}
            </p>
          </>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" asChild>
          {/* AN-125: the whole profile as JSON, for a request for access. */}
          <a href={profilesApi.exportHref(databaseId, subject)} download>
            <DownloadIcon /> Export
          </a>
        </Button>
        {/* AN-183, 5.8, 8.1: an Admin's Erase opens the project's erasure in place, the ID filled in,
            this database selected and the preview read, which asks for the ID to be typed. In place
            rather than on the project's settings, which a database Admin who is no member of the
            project cannot open. Closing it reads the profile again, gone once erased here. */}
        {eraseIn ? (
          <Dialog onOpenChange={(open) => (open ? undefined : void queryClient.invalidateQueries({ queryKey: ['analytics-profile', databaseId] }))}>
            <DialogTrigger asChild>
              <Button variant="destructive" size="sm">
                <EraserIcon /> Erase
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Erase this {subject.kind === 'installation' ? 'installation ID' : 'user ID'}</DialogTitle>
                <DialogDescription>{ERASE_PURPOSE}</DialogDescription>
              </DialogHeader>
              <ErasePanel projectId={eraseIn} initial={{ kind: subject.kind, id: subject.id, databaseId }} framed={false} />
            </DialogContent>
          </Dialog>
        ) : null}
      </div>
    </div>
  );
}

function Pairs({ entries }: { entries: [string, ReactNode][] }) {
  const shown = entries.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (shown.length === 0) return <p className="text-sm text-muted-foreground">Nothing recorded.</p>;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {shown.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function dimensionEntries(dims: ProfileDimensions): [string, ReactNode][] {
  return [
    ['Platform', dims.platform],
    ['Platform version', [dims.osName, dims.platformVersion].filter(Boolean).join(' ')],
    ['Runtime', [dims.runtime, dims.runtimeVersion].filter(Boolean).join(' ')],
    ['App', dims.app],
    ['App version', [dims.appVersion, dims.appBuild && `build ${dims.appBuild}`].filter(Boolean).join(' · ')],
    ['Locale', dims.locale],
    ['Country', dims.country],
    ['Attribution', dims.attribution],
    ['Experiments', Object.entries(dims.experiments).map(([key, variant]) => `${key}: ${variant}`).join(', ')],
  ];
}

function ContextCard({ profile }: { profile: InstallationProfile }) {
  return (
    <Card data-testid="profile-context">
      <CardHeader>
        <CardTitle>Context</CardTitle>
        <CardDescription>From its latest event; the install attribution is the first one it reported.</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Pairs entries={[...dimensionEntries(profile.installation.latest), ['Install attribution', profile.installation.installAttribution]]} />
        {profile.installation.latest.country ? <CountryAttribution className="mt-3" /> : null}
      </CardContent>
    </Card>
  );
}

function UserInstallations({ databaseId, profile }: { databaseId: string; profile: UserProfile }) {
  return (
    <Card data-testid="profile-installations">
      <CardHeader>
        <CardTitle>Installations</CardTitle>
        <CardDescription>Every installation this user ID was seen on, most recent first.</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <InstallationTable databaseId={databaseId} rows={profile.identity} caption="Installations of this user ID" userColumn={false} />
      </CardContent>
    </Card>
  );
}

function IdentityHistory({ profile, databaseId }: { profile: InstallationProfile; databaseId: string }) {
  return (
    <Card data-testid="profile-identity">
      <CardHeader>
        <CardTitle>Identity history</CardTitle>
        <CardDescription>The user IDs this installation carried, the current one first.</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {profile.identity.length === 0 ? (
          <p className="text-sm text-muted-foreground">No user ID was ever set on it.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {profile.identity.map((link) => (
              <li key={link.userId}>
                <Link className="font-mono text-xs underline underline-offset-4" to={profileHref(databaseId, { kind: 'user', id: link.userId })}>
                  {link.userId}
                </Link>{' '}
                {link.current ? <Badge variant="primary">current</Badge> : <Badge variant="muted">previous</Badge>}{' '}
                <span className="text-muted-foreground">
                  first seen {when(link.firstSeen)} · last seen {when(link.lastSeen)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const DAY_MS = 86_400_000;
/** ponytail: the calendar draws at most the last 53 weeks; the list below it names every active day. */
const CALENDAR_DAYS = 371;

function CountsCard({ profile }: { profile: InstallationProfile | UserProfile }) {
  const active = new Map(profile.activeDays.map((day) => [day.day, day.events]));
  const end = Date.parse(`${profile.window.to}T00:00:00Z`);
  const earliest = profile.window.from ?? profile.activeDays[0]?.day ?? profile.window.to;
  const start = Math.max(Date.parse(`${earliest}T00:00:00Z`), end - (CALENDAR_DAYS - 1) * DAY_MS);
  // Weeks start on Monday, as the reporting periods do.
  const first = start - ((new Date(start).getUTCDay() + 6) % 7) * DAY_MS;
  const days: { day: string; events: number; inWindow: boolean }[] = [];
  for (let ms = first; ms <= end; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    days.push({ day, events: active.get(day) ?? 0, inWindow: ms >= start });
  }
  const max = Math.max(1, ...profile.activeDays.map((day) => day.events));
  return (
    <Card data-testid="profile-counts">
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Counted from its events over the storage window{profile.window.from ? `, kept from ${profile.window.from}` : ''}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <dl className="grid grid-cols-3 gap-2">
          {(
            [
              ['Events', profile.counts.events],
              ['Sessions', profile.counts.sessions],
              ['Active days', profile.counts.activeDays],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-md border px-3 py-2">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="numeric text-lg font-semibold">{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
        {/* The drawing is for sight; the list after it gives every active day as text. */}
        <div aria-hidden="true" className="grid grid-flow-col grid-rows-7 gap-[3px] overflow-x-auto" data-testid="activity-calendar">
          {days.map((day) => (
            <span
              key={day.day}
              title={day.inWindow ? `${day.day}: ${pluralize(day.events, 'event')}` : undefined}
              className="size-2.5 rounded-[2px]"
              style={{
                background: !day.inWindow ? 'transparent' : day.events === 0 ? 'var(--muted)' : `color-mix(in oklab, var(--primary) ${Math.round(30 + (70 * day.events) / max)}%, transparent)`,
              }}
            />
          ))}
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Active days as a list</summary>
          <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto" data-testid="active-days">
            {profile.activeDays.map((day) => (
              <li key={day.day}>
                {day.day}: {pluralize(day.events, 'event')}
              </li>
            ))}
            {profile.activeDays.length === 0 ? <li className="text-muted-foreground">No active day in the storage window.</li> : null}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}

function LinksCards({ links }: { links: ProfileLinks }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card data-testid="profile-crash-links">
        <CardHeader>
          <CardTitle>Crash groups</CardTitle>
          <CardDescription>Groups whose reports carry these IDs, in the crash databases you can read.</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {links.crashGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {links.crashGroups.map((group) => (
                <li key={group.groupId}>
                  <Link className="font-medium underline underline-offset-4" to={`/crash-databases/${group.crashDatabaseId}/groups/${group.groupId}`}>
                    {group.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {group.crashDatabaseName} · {pluralize(group.reports, 'report')} · last {when(group.lastReceivedAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {links.truncated.crashGroups ? <p className="mt-2 text-xs text-muted-foreground">The 100 most recent are listed.</p> : null}
        </CardContent>
      </Card>
      <Card data-testid="profile-feedback-links">
        <CardHeader>
          <CardTitle>Feedback</CardTitle>
          <CardDescription>Submissions carrying these IDs, in the feedback databases you can read.</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {links.submissions.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {links.submissions.map((submission) => (
                <li key={submission.submissionId}>
                  <Link className="font-medium underline underline-offset-4" to={`/databases/${submission.feedbackDatabaseId}/submissions/${submission.submissionId}`}>
                    {submission.feedbackDatabaseName} · {when(submission.receivedAt)}
                  </Link>
                  {submission.firstTextAnswer ? <p className="line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">{submission.firstTextAnswer}</p> : null}
                </li>
              ))}
            </ul>
          )}
          {links.truncated.submissions ? <p className="mt-2 text-xs text-muted-foreground">The 100 most recent are listed.</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

// --- The event feed (AN-123) -----------------------------------------------------------------------------

function EventFeed({ databaseId, subject, unreachable }: { databaseId: string; subject: ProfileSubject; unreachable: string }) {
  const [filters, setFilters] = useState<{ name: string; from: string; to: string }>({ name: '', from: '', to: '' });
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const feed = useQuery({
    queryKey: ['analytics-profile-events', databaseId, subject.kind, subject.id, filters, cursor],
    queryFn: () => profilesApi.events(databaseId, subject, { ...filters, ...(cursor ? { cursor } : {}) }),
    placeholderData: keepPreviousData,
  });
  const set = (key: 'name' | 'from' | 'to', value: string) => {
    setCursors([]);
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <Card data-testid="profile-events">
      <CardHeader>
        <CardTitle>Events</CardTitle>
        <CardDescription>Newest first, grouped by session. Open an event for its params and context.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="flex flex-wrap gap-2">
          <div className="space-y-1">
            <Label htmlFor="feed-name" className="text-xs text-muted-foreground">
              Event name
            </Label>
            <Input id="feed-name" className="h-8 w-44" defaultValue={filters.name} onBlur={(event) => set('name', event.target.value.trim())} onKeyDown={(event) => event.key === 'Enter' && set('name', event.currentTarget.value.trim())} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="feed-from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input id="feed-from" type="date" className="h-8 w-40" value={filters.from} onChange={(event) => set('from', event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="feed-to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input id="feed-to" type="date" className="h-8 w-40" value={filters.to} onChange={(event) => set('to', event.target.value)} />
          </div>
        </div>
        {feed.isLoading ? (
          <Skeleton className="h-32" />
        ) : feed.error ? (
          <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
            {queryErrorSentence(feed.error, unreachable)}
          </p>
        ) : feed.data && feed.data.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events.</p>
        ) : feed.data ? (
          <ol className="space-y-3">
            {bySession(feed.data.events).map((group) => (
              <li key={`${group.sessionId ?? 'none'}-${group.events[0]!.eventId}`} data-testid="session-group" className="rounded-md border">
                <p className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                  {group.sessionId ? (
                    <>
                      Session <span className="font-mono">{group.sessionId}</span>
                    </>
                  ) : (
                    'No session'
                  )}{' '}
                  · {pluralize(group.events.length, 'event')}
                </p>
                <ul>
                  {group.events.map((event) => (
                    <FeedEvent key={event.eventId} event={event} />
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>
            Newer
          </Button>
          <Button variant="outline" size="sm" disabled={!feed.data?.nextCursor} onClick={() => feed.data?.nextCursor && setCursors([...cursors, feed.data.nextCursor])}>
            Older
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function FeedEvent({ event }: { event: ProfileEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b last:border-b-0" data-testid="feed-event">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/40" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
        <span className="font-mono text-xs">{event.name}</span>
        {event.category ? <Badge variant="muted">{event.category}</Badge> : null}
        <span className="numeric ml-auto text-xs text-muted-foreground">{formatDateTime(event.time)}</span>
      </button>
      {open ? (
        <div className="grid gap-3 px-9 pb-3 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Params</p>
            <Pairs entries={Object.entries(event.params)} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Context</p>
            <Pairs entries={[...dimensionEntries(event.context), ['Installation', event.installationId], ['User ID', event.userId], ['Received', formatDateTime(event.receivedTime)]]} />
          </div>
        </div>
      ) : null}
    </li>
  );
}
