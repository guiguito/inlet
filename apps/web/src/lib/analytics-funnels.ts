import type { AnalyticsFunnelDefinition, AnalyticsFunnelRun } from '@inlet/shared';
import { ApiError, request } from '@/lib/api';

/** Funnels (UX Analytics 6.7, AN-080 to AN-089, Appendix E "Funnel"), as the API answers them. */

export type SavedFunnel = { id: string; analyticsDatabaseId: string; name: string; definition: AnalyticsFunnelDefinition; createdAt: string; updatedAt: string };

export type FunnelStep = {
  index: number;
  event: string;
  label: string | null;
  entered: number | null;
  continued: number | null;
  reached: number;
  shareOfEntered: number | null;
  shareOfPrevious: number | null;
  dropped: number | null;
  medianSeconds: number | null;
  meanSeconds: number | null;
};

export type FunnelResult = { entered: number; steps: FunnelStep[]; conversion: number | null; medianSeconds: number | null };
export type FunnelGroup = { start: string; label: string; entered: number; conversion: number | null; stepShares: (number | null)[]; incomplete: boolean };
type SplitGroup = { label: string; value: string | null; group: 'value' | 'other' | 'none' };

type AnswerBase = {
  funnel: { id: string; name: string } | null;
  mode: 'closed' | 'open';
  window: AnalyticsFunnelDefinition['window'];
  unit: 'installation' | 'user';
  range: { from: string; to: string };
  timezone: string;
  keptFrom: string | null;
  covered: { from: string; to: string } | null;
  notice: 'range_outside_retention' | null;
  warnings: { code: 'event_deleted'; step: number; event: string }[];
  split: { field: string; key: string | null; descriptive: boolean; note: string | null } | null;
};

export type FunnelStepsAnswer = AnswerBase & FunnelResult & { view: 'steps'; splits: (SplitGroup & FunnelResult)[] | null };
export type FunnelTrendAnswer = AnswerBase & {
  view: 'trend';
  interval: 'day' | 'week' | 'month';
  steps: { index: number; event: string; label: string | null }[];
  groups: FunnelGroup[];
  splits: (SplitGroup & { groups: FunnelGroup[] })[] | null;
};
export type FunnelAnswer = FunnelStepsAnswer | FunnelTrendAnswer;

export type FunnelUnit = {
  unit: string;
  installationId: string;
  userId: string | null;
  platform: string | null;
  appVersion: string | null;
  lastSeen: string | null;
  crashReports: boolean;
  feedback: boolean;
};
export type FunnelUnits = { step: number; kind: 'dropped' | 'reached'; runAt: string; units: FunnelUnit[]; nextCursor: string | null };

const base = (databaseId: string) => `/v1/analytics-databases/${databaseId}`;

export const funnelsApi = {
  list: (databaseId: string) => request<{ funnels: SavedFunnel[] }>(`${base(databaseId)}/funnels`),
  get: (databaseId: string, funnelId: string) => request<SavedFunnel>(`${base(databaseId)}/funnels/${funnelId}`),
  create: (databaseId: string, name: string, definition: AnalyticsFunnelDefinition) => request<SavedFunnel>(`${base(databaseId)}/funnels`, { method: 'POST', body: { name, definition } }),
  update: (databaseId: string, funnelId: string, body: { name?: string; definition?: AnalyticsFunnelDefinition }) =>
    request<SavedFunnel>(`${base(databaseId)}/funnels/${funnelId}`, { method: 'PATCH', body }),
  remove: (databaseId: string, funnelId: string) => request<{ deleted: true }>(`${base(databaseId)}/funnels/${funnelId}`, { method: 'DELETE' }),
  run: (databaseId: string, run: AnalyticsFunnelRun, signal?: AbortSignal) => request<FunnelAnswer>(`${base(databaseId)}/queries/funnel`, { method: 'POST', body: run, ...(signal ? { signal } : {}) }),
  units: (databaseId: string, body: AnalyticsFunnelRun & { step: number; kind: 'dropped' | 'reached'; cursor?: string }) =>
    request<FunnelUnits>(`${base(databaseId)}/queries/funnel/units`, { method: 'POST', body }),
  /** AN-211: the export is a POST (the run does not fit an address), so it is fetched and saved as a file. */
  download: async (databaseId: string, run: AnalyticsFunnelRun, format: 'csv' | 'json') => {
    const response = await fetch(`${base(databaseId)}/queries/funnel?format=${format}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(response.status, body?.error?.code ?? 'internal_error', body?.error?.message ?? 'The export failed.');
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `funnel.${format}`;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
