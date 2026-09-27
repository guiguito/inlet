import type { Harness } from './harness.js';

/**
 * Volume for the storage tests (piece 9): events generated inside the event store with
 * `numbers()` and inserted into `events_ingest`, the table ingest writes, so every
 * materialized view (events, installations, links, first occurrences, version_first) fills
 * as it would from ingest, at a volume no batch loop would reach quickly. Every value is a
 * query parameter.
 */
export type Volume = {
  databaseKey: number;
  /** YYYY-MM-DD, local day of the first event. */
  day: string;
  events: number;
  /** Consecutive days the events are spread over, round robin (default 1). */
  days?: number;
  /** Installations the events are spread over (default 20), from `installationBase`. */
  installations?: number;
  installationBase?: number;
  eventNameId?: number;
  userId?: string;
  appVersion?: string;
};

export async function insertVolume(h: Harness, volume: Volume): Promise<void> {
  await h.ctx.eventStore!.command(
    `INSERT INTO events_ingest (database_key, local_day, effective_time, received_time, event_id, event_name_id, category, installation_id,
       installation_kind, ephemeral, user_id, session_id, platform, os_name, platform_version, runtime_name, runtime_version, app_id,
       app_version, app_build, locale, environment, country, attribution, experiment_keys, experiment_variants, params,
       install_age_days, install_age_weeks, install_age_months, clock_corrected, credential_id, is_replay)
     SELECT {key:UInt32}, d, toDateTime64(d, 3, 'UTC') + toIntervalHour(12), toDateTime64(d, 3, 'UTC') + toIntervalHour(12), generateUUIDv4(number),
       {name:UInt32}, '', toUUID(concat('0192f5a0-0000-7000-8000-', leftPad(toString({base:UInt32} + number % {installations:UInt32}), 12, '0'))),
       'device', false, {userId:String}, NULL, 'ios', '', '', '', '', '', {appVersion:String}, '', '', 'production', '', '', [], [], map(),
       NULL, NULL, NULL, false, 'cred_volume', false
     FROM (SELECT number, addDays({day:Date}, number % {days:UInt32}) AS d FROM numbers({n:UInt64}))`,
    {
      key: volume.databaseKey,
      day: volume.day,
      days: volume.days ?? 1,
      n: volume.events,
      name: volume.eventNameId ?? 1,
      base: volume.installationBase ?? 0,
      installations: volume.installations ?? 20,
      userId: volume.userId ?? '',
      appVersion: volume.appVersion ?? '1.0.0',
    },
  );
}

/** The installation ID `insertVolume` gives installation number `n`. */
export function volumeInstallation(n: number): string {
  return `0192f5a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
}
