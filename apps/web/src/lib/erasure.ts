import { request } from '@/lib/api';

/** The project's erasure (Foundations FD-033, UX Analytics AN-183 to AN-185, Remote Config RC-100) and the event export (AN-210), as the API answers them. */

export type ErasureKind = 'installation' | 'user';
export type ErasureDatabaseType = 'crash' | 'feedback' | 'analytics' | 'config';

export type ErasurePreview = {
  kind: ErasureKind;
  id: string;
  databases: {
    type: ErasureDatabaseType;
    id: string;
    name: string;
    status: 'counted' | 'unreachable';
    counts: Record<string, number> | null;
  }[];
  notice: string;
  limits: string;
};

export type ErasureResult = {
  erasureId: number;
  kind: ErasureKind;
  databases: {
    type: ErasureDatabaseType;
    id: string;
    name: string;
    status: 'erased' | 'deferred';
    deleted: Record<string, number> | null;
  }[];
  limits: string;
};

export const erasureApi = {
  preview: (projectId: string, kind: ErasureKind, id: string) =>
    request<ErasurePreview>(`/v1/projects/${projectId}/erasures/preview`, { method: 'POST', body: { kind, id } }),
  erase: (projectId: string, body: { kind: ErasureKind; id: string; confirm: string; databases: string[] }) =>
    request<ErasureResult>(`/v1/projects/${projectId}/erasures`, { method: 'POST', body }),
  /** AN-210, AN-212: every stored event of an analytics database, as newline-delimited JSON. */
  exportEventsHref: (analyticsDatabaseId: string) => `/v1/analytics-databases/${analyticsDatabaseId}/exports/events`,
};
