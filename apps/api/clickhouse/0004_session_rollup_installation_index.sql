-- Two internal rollups the load test of Release 8 showed the budgets need (UX Analytics AN-035,
-- 9.5; DECISIONS 33.12c measured, 33.12d built and re-measured). AN-035 allows them on four
-- conditions, which every reader and every deletion here keeps: maintained from exactly the events
-- stored (fed by materialized views from `events_ingest`, replays included, with idempotent states,
-- so a duplicate or a replay changes nothing); holding nothing the events do not; dropped, erased
-- and deleted with them; and never visible (no answer, setting, export or Storage figure names
-- them, and every answer equals what the events give).
--
--   events_ingest ──(a session's app_started or session_crashed)──> session_rollup
--                 ──(every row)──────────────────────────────────> installation_index
--
-- Release 8 had not shipped when this was added, so no event store holds events from before it: a
-- development store seeded earlier is recreated, as the PostgreSQL baseline was (DECISIONS 30.3).
--
-- ─── The session marker ──────────────────────────────────────────────────────────────────────
--
-- Event names are catalog IDs that PostgreSQL assigns per database, so a view cannot know which ID
-- is `app_started`. Ingest, which knows each event's name, marks the two standard events that make
-- sessions (AN-043, AN-044, AN-152); the erasure's replay marks them from the resolved IDs. The
-- column is last, after `is_replay`, and `events_mv` keeps the columns it was created with, so
-- `events` never stores it.

ALTER TABLE events_ingest ADD COLUMN IF NOT EXISTS session_event Enum8('none' = 0, 'started' = 1, 'crashed' = 2) DEFAULT 'none';

-- ─── session_rollup: sessions and crashed sessions for the Overview (AN-043, AN-140, AN-152) ──
--
-- One row per database, ISO week of the local day, event name, session and installation: for a
-- session's `app_started` of a device installation that is not a background event, the first one
-- accepted that week (received first, then earliest, as 0001's "first"), with its local day, app,
-- platform, environment, app version and `crashReporting`; for its `session_crashed` (any platform),
-- only that one exists. A session's first `app_started` over the weeks read is the minimum of its
-- rows, which is exactly the minimum over those weeks' events; so the Overview's events statement
-- reads the same whole weeks (services/analytics-overview.ts), and the two give the same answer.
--
-- Partitioned as `events` is, by database and ISO week of the local day, with the same partition
-- IDs, so retention drops a week of both (AN-164), database removal drops every partition of the key
-- (AN-004), an erasure deletes the sessions of the installations it re-derives and the replay
-- rebuilds them, and an event name's deletion deletes its rows (AN-056). The sort key leads with the
-- event name, then the session, so a read of one name aggregates the sessions in order.
--
-- Read, one database (the event-name IDs of `app_started` and `session_crashed`):
--
--   SELECT session_id, min(first) AS f FROM session_rollup
--   WHERE database_key = {databaseKey:UInt32} AND event_name_id = {started:UInt32}
--     AND week BETWEEN {firstWeek:Date} AND {lastWeek:Date}
--   GROUP BY session_id                    -- with optimize_aggregation_in_order = 1
--
--   and the crashed sessions: SELECT session_id FROM session_rollup WHERE database_key = …
--   AND event_name_id = {crashed:UInt32} AND week >= {firstWeek:Date}.

CREATE TABLE IF NOT EXISTS session_rollup
(
    database_key    UInt32,
    week            Date,
    event_name_id   UInt32,
    session_id      UUID,
    installation_id UUID,
    first           SimpleAggregateFunction(min, Tuple(received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), day Date, app_id String, platform String, environment String, app_version String, crash_reporting Bool)) CODEC(ZSTD(3))
)
ENGINE = AggregatingMergeTree
PARTITION BY (database_key, week)
ORDER BY (database_key, event_name_id, session_id, installation_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS session_rollup_mv TO session_rollup AS
SELECT
    database_key,
    toMonday(local_day) AS week,
    event_name_id,
    sid AS session_id,
    installation_id,
    min(CAST(tuple(received_time, effective_time, local_day, app_id, platform, environment, app_version, params['crashReporting'] = 'true'),
             'Tuple(received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), day Date, app_id String, platform String, environment String, app_version String, crash_reporting Bool)')) AS first
-- AN-043, AN-047: a session is made by an app_started of a device installation that is not a
-- background event; AN-152: a session_crashed names a session from any platform.
FROM (SELECT *, assumeNotNull(session_id) AS sid FROM events_ingest
      WHERE session_id IS NOT NULL
        AND (session_event = 'crashed' OR (session_event = 'started' AND installation_kind = 'device' AND platform != 'server')))
GROUP BY database_key, week, event_name_id, sid, installation_id;

-- ─── installation_index: the installation records in plain columns (AN-031, AN-102, AN-120) ──
--
-- The same values as `installations` (0001), from the same rows by the same rules, but stored as
-- plain `min`/`max` columns rather than aggregate-function states: a state is serialised row by row
-- and must be deserialised to be merged, which is what made every read of all a database's
-- installations cost about half a second per million (DECISIONS 33.12c). Cohorts' install start and
-- the Overview's new installations read `install`, the Overview's shares `latest`, and the list of
-- recent installations `last_seen`, `last_event` and `latest`; each read aggregates in the table's
-- order, one installation at a time.
--
-- `install` and `latest` are the very tuples of `installations`, element for element, so a tie falls
-- the same way. An installation with no qualifying event (AN-031) holds the largest `install` and
-- the smallest `latest` a real event cannot reach, and `has_qualifying` 0, which every read tests
-- first, as for `installations`.
--
-- Read, one database:
--
--   SELECT installation_id, min(install) AS install, max(latest) AS latest, max(last_seen) AS last_seen,
--          max(last_event) AS last_event, max(installation_kind) AS installation_kind, max(ephemeral) AS ephemeral
--   FROM installation_index WHERE database_key = {databaseKey:UInt32}
--   GROUP BY installation_id HAVING max(has_qualifying) = 1
--
-- Partitioned by database as `installations` is; pruned, erased and removed with it.

CREATE TABLE IF NOT EXISTS installation_index
(
    database_key      UInt32,
    installation_id   UUID,
    has_qualifying    SimpleAggregateFunction(max, UInt8),
    installation_kind SimpleAggregateFunction(max, Enum8('device' = 1, 'server' = 2, 'test' = 3)),
    ephemeral         SimpleAggregateFunction(max, Bool),
    last_seen         SimpleAggregateFunction(max, Nullable(DateTime64(3, 'UTC'))),
    last_event        SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    install           SimpleAggregateFunction(min, Tuple(received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), day Date, platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))) CODEC(ZSTD(3)),
    latest            SimpleAggregateFunction(max, Tuple(time DateTime64(3, 'UTC'), received DateTime64(3, 'UTC'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))) CODEC(ZSTD(3))
)
ENGINE = AggregatingMergeTree
PARTITION BY database_key
ORDER BY (database_key, installation_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS installation_index_mv TO installation_index AS
SELECT
    database_key,
    installation_id,
    max(qualifying) AS has_qualifying,
    max(installation_kind) AS installation_kind,
    max(ephemeral) AS ephemeral,
    max(if(platform != 'server', effective_time, NULL)) AS last_seen,
    max(effective_time) AS last_event,
    -- Without a qualifying event, the latest instant a DateTime64(3) holds, so the minimum over
    -- the installation's rows is a real event's as soon as one exists.
    if(max(qualifying) = 1,
       minIf(CAST(tuple(received_time, effective_time, local_day, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, environment, country, attribution, experiment_keys, experiment_variants),
                  'Tuple(received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), day Date, platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))'),
             qualifying),
       CAST(tuple(toDateTime64('2299-12-31 23:59:59.999', 3, 'UTC'), toDateTime64('2299-12-31 23:59:59.999', 3, 'UTC'), toDate('2149-06-06'), '', '', '', '', '', '', '', '', '', '', '', '', [], []),
            'Tuple(received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), day Date, platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))')) AS install,
    -- Without a qualifying event, maxIf gives the tuple's default (1970, empty strings), which any
    -- real event's tuple exceeds.
    maxIf(CAST(tuple(effective_time, received_time, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, environment, country, attribution, experiment_keys, experiment_variants),
               'Tuple(time DateTime64(3, \'UTC\'), received DateTime64(3, \'UTC\'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))'),
          qualifying) AS latest
-- `qualifying` in a subquery, as in installations_mv: in the outer query `installation_kind` names the aggregate.
FROM (SELECT *, toUInt8(platform != 'server' OR installation_kind = 'server') AS qualifying FROM events_ingest)
GROUP BY database_key, installation_id;
