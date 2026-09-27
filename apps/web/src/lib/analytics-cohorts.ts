import type { AnalyticsCohortDefinition, AnalyticsCohortRun } from '@inlet/shared';
import { ApiError, request } from '@/lib/api';

/** Cohorts (UX Analytics 6.8, AN-100 to AN-109, Appendix E "Cohort"), as the API answers them. */

export type SavedCohort = { id: string; analyticsDatabaseId: string; name: string; definition: AnalyticsCohortDefinition; standard: boolean; createdAt: string; updatedAt: string };

export type CohortCell = { period: number; returned: number; share: number; incomplete: boolean; covered: boolean };
export type CohortRow = { start: string; label: string; size: number; cells: CohortCell[] };
export type CohortSummaryCell = { period: number; members: number; returned: number; share: number | null; incomplete: boolean };

export type CohortAnswer = {
  cohort: { id: string; name: string; standard: boolean } | null;
  definition: AnalyticsCohortDefinition;
  granularity: AnalyticsCohortDefinition['granularity'];
  unit: 'installation' | 'user';
  range: { from: string; to: string };
  timezone: string;
  keptFrom: string | null;
  covered: { from: string; to: string } | null;
  notice: 'range_outside_retention' | null;
  firstInWindow: boolean;
  truncated: boolean;
  warnings: { code: 'event_deleted'; in: 'start' | 'return'; event: string }[];
  size: number;
  periods: number;
  summary: CohortSummaryCell[];
  rows: CohortRow[];
};

const base = (databaseId: string) => `/v1/analytics-databases/${databaseId}`;

export const cohortsApi = {
  list: (databaseId: string) => request<{ cohorts: SavedCohort[] }>(`${base(databaseId)}/cohorts`),
  get: (databaseId: string, cohortId: string) => request<SavedCohort>(`${base(databaseId)}/cohorts/${cohortId}`),
  create: (databaseId: string, name: string, definition: AnalyticsCohortDefinition) => request<SavedCohort>(`${base(databaseId)}/cohorts`, { method: 'POST', body: { name, definition } }),
  update: (databaseId: string, cohortId: string, body: { name?: string; definition?: AnalyticsCohortDefinition }) =>
    request<SavedCohort>(`${base(databaseId)}/cohorts/${cohortId}`, { method: 'PATCH', body }),
  remove: (databaseId: string, cohortId: string) => request<{ deleted: true }>(`${base(databaseId)}/cohorts/${cohortId}`, { method: 'DELETE' }),
  run: (databaseId: string, run: AnalyticsCohortRun, signal?: AbortSignal) => request<CohortAnswer>(`${base(databaseId)}/queries/cohort`, { method: 'POST', body: run, ...(signal ? { signal } : {}) }),
  /** AN-109: the export is a POST (the run does not fit an address), so it is fetched and saved as a file. */
  download: async (databaseId: string, run: AnalyticsCohortRun, format: 'csv' | 'json') => {
    const response = await fetch(`${base(databaseId)}/queries/cohort?format=${format}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(response.status, body?.error?.code ?? 'internal_error', body?.error?.message ?? 'The export failed.');
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `cohort.${format}`;
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
