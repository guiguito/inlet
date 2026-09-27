import { request } from '@/lib/api';

/** Profiles and the Usage profile link (UX Analytics 6.9, AN-120 to AN-126, AN-154), as the API answers them. */

export type ProfileDimensions = {
  platform: string | null;
  osName: string | null;
  platformVersion: string | null;
  runtime: string | null;
  runtimeVersion: string | null;
  app: string | null;
  appVersion: string | null;
  appBuild: string | null;
  locale: string | null;
  environment: string | null;
  country: string | null;
  attribution: string | null;
  experiments: Record<string, string>;
};

export type InstallationSummary = {
  installationId: string;
  userId: string | null;
  installationKind: 'device' | 'server';
  server: boolean;
  ephemeral: boolean;
  platform: string | null;
  platformVersion: string | null;
  appVersion: string | null;
  country: string | null;
  environment: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  lastEvent: string;
};

export type ProfileList = {
  installations: InstallationSummary[];
  users: { userId: string; installations: number; lastSeen: string }[];
  nextCursor: string | null;
  truncated: boolean;
  notice: 'prefix_too_short' | null;
};

export type ProfileLinks = {
  crashGroups: { crashDatabaseId: string; crashDatabaseName: string; groupId: string; title: string; reports: number; lastReceivedAt: string }[];
  submissions: { feedbackDatabaseId: string; feedbackDatabaseName: string; submissionId: string; receivedAt: string; firstTextAnswer: string | null }[];
  truncated: { crashGroups: boolean; submissions: boolean };
};

type ProfileCommon = {
  counts: { events: number; sessions: number; activeDays: number };
  activeDays: { day: string; events: number }[];
  window: { from: string | null; to: string };
  links: ProfileLinks;
};

export type InstallationProfile = ProfileCommon & {
  kind: 'installation';
  installation: {
    installationId: string;
    installationKind: 'device' | 'server' | 'test';
    server: boolean;
    ephemeral: boolean;
    installTime: string;
    installDay: string;
    firstSeen: string | null;
    lastSeen: string | null;
    lastEvent: string;
    installAttribution: string | null;
    install: ProfileDimensions;
    latest: ProfileDimensions;
    userId: string | null;
  };
  identity: { userId: string; firstSeen: string; lastSeen: string; current: boolean }[];
};

export type UserProfile = ProfileCommon & {
  kind: 'user';
  user: { userId: string; firstSeen: string; lastSeen: string; installations: number };
  identity: (InstallationSummary & { userFirstSeen: string; userLastSeen: string })[];
};

export type ProfileEvent = {
  eventId: string;
  name: string;
  category: string | null;
  time: string;
  receivedTime: string;
  sessionId: string | null;
  installationId: string;
  userId: string | null;
  params: Record<string, string>;
  context: ProfileDimensions;
};

export type ProfileSubject = { kind: 'installation'; id: string } | { kind: 'user'; id: string };

export type UsageProfileLink = { analyticsDatabaseId: string; analyticsDatabaseName: string; installationId: string; lastSeen: string };

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function profilePath(databaseId: string, subject: ProfileSubject): string {
  return `/v1/analytics-databases/${databaseId}/profiles/${subject.kind === 'installation' ? 'installations' : 'users'}/${encodeURIComponent(subject.id)}`;
}

/** Where the Users tab shows a profile: the database page with the subject in its address. */
export function profileHref(databaseId: string, subject: ProfileSubject): string {
  return `/analytics-databases/${databaseId}?tab=users&${subject.kind}=${encodeURIComponent(subject.id)}`;
}

export const profilesApi = {
  find: (databaseId: string, params: { q?: string; platform?: string; appVersion?: string; country?: string; environment?: string; cursor?: string }) =>
    request<ProfileList>(`/v1/analytics-databases/${databaseId}/profiles${query(params)}`),
  installation: (databaseId: string, installationId: string) => request<InstallationProfile>(profilePath(databaseId, { kind: 'installation', id: installationId })),
  user: (databaseId: string, userId: string) => request<UserProfile>(profilePath(databaseId, { kind: 'user', id: userId })),
  events: (databaseId: string, subject: ProfileSubject, params: { name?: string; from?: string; to?: string; cursor?: string }) =>
    request<{ events: ProfileEvent[]; nextCursor: string | null }>(`${profilePath(databaseId, subject)}/events${query(params)}`),
  exportHref: (databaseId: string, subject: ProfileSubject) => `${profilePath(databaseId, subject)}/export`,
  crashReportLink: (crashDatabaseId: string, reportId: string) =>
    request<{ profiles: UsageProfileLink[] }>(`/v1/crash-databases/${crashDatabaseId}/reports/${reportId}/usage-profile`),
  submissionLink: (feedbackDatabaseId: string, submissionId: string) =>
    request<{ profiles: UsageProfileLink[] }>(`/v1/feedback-databases/${feedbackDatabaseId}/submissions/${submissionId}/usage-profile`),
};
