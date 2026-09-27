import { request } from '@/lib/api';

/** Settings → Storage and data health (UX Analytics AN-160 to AN-169, Appendix E), as the API answers them. */

export type StorageSettings = { maxAgeDays: number; maxEvents: number; latenessDays: number };
type Bound = { min: number; max: number; default: number };

export type AnalyticsStorage = {
  settings: StorageSettings;
  bounds: Record<keyof StorageSettings, Bound>;
  usage: {
    eventsPerDay: { average: number; days: { day: string; events: number }[] };
    events: number;
    oldestWeek: string | null;
    keptFrom: string | null;
    bytes: { database: number; eventStore: number; postgres: number };
  };
  binding: 'maxAge' | 'maxEvents';
  keptDays: { min: number; max: number } | null;
  recommendations: string[];
  notes: string[];
  removes?: { events: number; before: string | null; statement: string };
  notice?: string;
};

export type IncidentKind = 'storage_cap_reached' | 'storage_cap_exceeded' | 'rate_limited' | 'event_name_limit' | 'event_name_rate' | 'invalid_events';

export type AnalyticsDataHealth = {
  refused: { last24h: Record<string, number>; last7d: Record<string, number> };
  warned: { last24h: Record<string, number>; last7d: Record<string, number> };
  removedByCap: { last24h: number; last7d: number };
  duplicates: { last24h: number; last7d: number };
  accepted: { last24h: number; last7d: number };
  incidents: { id: number; kind: IncidentKind; openedAt: string; resolvedAt: string | null; figures: Record<string, unknown>; summary: string }[];
};

export const storageApi = {
  get: (databaseId: string) => request<AnalyticsStorage>(`/v1/analytics-databases/${databaseId}/storage`),
  update: (databaseId: string, body: Partial<StorageSettings> & { preview?: boolean; confirm?: string }) =>
    request<AnalyticsStorage>(`/v1/analytics-databases/${databaseId}/storage`, { method: 'PATCH', body }),
  dataHealth: (databaseId: string) => request<AnalyticsDataHealth>(`/v1/analytics-databases/${databaseId}/data-health`),
};

/** The incidents' kinds in plain words, for the data-health list. */
export const INCIDENT_LABELS: Record<IncidentKind, string> = {
  storage_cap_reached: 'Storage cap reached',
  storage_cap_exceeded: 'Storage cap exceeded',
  rate_limited: 'Rate limited',
  event_name_limit: 'Event-name limit reached',
  event_name_rate: 'Too many new event names in an hour',
  invalid_events: 'Invalid events',
};
