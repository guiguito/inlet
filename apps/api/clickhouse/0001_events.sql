-- The analytics event store (UX Analytics sections 9.3 to 9.5, DECISIONS 31.2 and 33.1).
--
-- Applied by apps/api/src/db/clickhouse.ts at start, in the database INLET_CLICKHOUSE_DATABASE
-- names, and recorded in `inlet_migrations`. Every statement is idempotent, so a file cut
-- short by a crash is simply run again.
--
-- How the data flows. The API inserts into `events_ingest`, which stores nothing (Null
-- engine). Materialized views fan each inserted block out:
--
--   events_ingest ──(is_replay = 0)──> events               immutable, with two projections
--                 ──(every row)──────> installations        AggregatingMergeTree
--                                  ──> installation_users   AggregatingMergeTree
--                                  ──> installation_first   AggregatingMergeTree
--                                  ──> user_first           AggregatingMergeTree
--                                  ──> version_first        AggregatingMergeTree
--                                  ──> installation_index   AggregatingMergeTree
--                 ──(a session's app_started or session_crashed)──> session_rollup
--
-- A duplicate the API finds is inserted again with is_replay = 1 (DECISIONS 31.3): it never
-- reaches `events`, and it completes any installation state a failed view left behind.
-- Every installation-scoped column is an idempotent state (min, max, and their -If forms),
-- so an event stored twice, or replayed, changes nothing.
--
-- "The first" and "the latest" are `min` and `max` of a tuple that starts with the times
-- that order them and carries the values after them. A tuple compares element by element,
-- so the minimum is the event received first, then the earliest in time, and an exact tie
-- falls to the values themselves: the answer never depends on which part a read or a merge
-- meets first. An argMin keyed on the event ID would too, but stores a random 16-byte ID
-- per state (DECISIONS 33.1 measured 142 against 79 bytes an installation).
--
-- Conventions every reader follows:
--   * `user_id = ''` means no user ID; `session_id IS NULL` means no session.
--   * A background event is `platform = 'server'` (AN-047).
--   * A qualifying event is one that may create an installation record (AN-031):
--       platform != 'server' OR installation_kind = 'server'
--   * The "first" of anything is the first *received*: ordered by (received_time,
--     effective_time). The "latest" is the latest in time: (effective_time, received_time).
--   * Rows of an AggregatingMergeTree are merged in the background, never at once, so a
--     read always aggregates again with GROUP BY on the table's key; it never reads a
--     state column as if it were one row.
--
-- ─── Read expressions ───────────────────────────────────────────────────────────────
--
-- installations (AN-031), one database:
--
--   SELECT installation_id,
--          minIfMerge(install)                         AS install,             -- see below
--          minIfMerge(install_attribution).attribution AS install_attribution, -- '' when none
--          min(first_seen)                             AS first_seen,          -- Nullable
--          max(last_seen)                              AS last_seen,           -- Nullable: no non-background event
--          max(last_event)                             AS last_event,          -- any platform
--          maxIfMerge(latest)                          AS latest,              -- see below
--          max(installation_kind)                      AS installation_kind,   -- 'device' | 'server' | 'test'
--          max(ephemeral)                              AS ephemeral
--   FROM installations
--   WHERE database_key = {databaseKey:UInt32}
--   GROUP BY installation_id
--   HAVING max(has_qualifying) = 1         -- existence: see below
--
--   install.time is the install time (the effective time of the qualifying event received
--   first, which never moves) and install.day the install day; install.platform,
--   install.os_name, ... install.experiment_variants are the install dimensions of that
--   same event. latest.platform ... latest.experiment_variants are the latest dimensions,
--   attribution and experiments, from the latest qualifying event. install_attribution is
--   the attribution of the first qualifying event, received first, that reported one.
--   A background event naming an installation with no qualifying event does write a row
--   (it moves last_event), but has_qualifying stays 0 and every -If state stays empty, so
--   the HAVING clause is what makes it not exist. Every read of installations carries that
--   HAVING clause; a read of one installation adds `AND installation_id = {id:UUID}`.
--
-- The latest user ID of an installation (AN-031), derived at read time so an erasure of
-- its installation_users rows corrects it without a rewrite:
--
--   SELECT installation_id, argMax(user_id, (last_seen, user_id)) AS latest_user_id
--   FROM (SELECT installation_id, user_id, min(first_seen) AS first_seen, max(last_seen) AS last_seen
--         FROM installation_users WHERE database_key = {databaseKey:UInt32}
--         GROUP BY installation_id, user_id)
--   GROUP BY installation_id
--
-- First occurrences (AN-036), per installation or per user ID:
--
--   SELECT installation_id, min(first) AS first   -- first.day, first.platform, ...
--   FROM installation_first
--   WHERE database_key = {databaseKey:UInt32} AND event_name_id = {eventNameId:UInt32}
--   GROUP BY installation_id
--
--   and the same over user_first with user_id. first.day is the local day of the earliest
--   occurrence accepted; the dimensions are those of the occurrence received first on that
--   day, so a late event on an earlier day lowers the day and replaces them. event_name_id
--   0 is "any event of a device installation that is not a background event". A row for a
--   real event name exists for any occurrence, background ones included; a reader that
--   counts installations joins the existence rule of `installations` above.
--
-- Unique counts from the rollups (AN-035): see the projections on `events`. A query that
-- the optimizer should answer from a projection is written in two levels, the inner level
-- a count() grouped by the projection's keys, because an aggregate projection only answers
-- aggregates it stores (DECISIONS 33.1 has the EXPLAIN evidence):
--
--   SELECT local_day, count() AS installations
--   FROM (SELECT local_day, installation_id, count() AS events
--         FROM events
--         WHERE database_key = {databaseKey:UInt32} AND event_name_id = {eventNameId:UInt32}
--           AND local_day BETWEEN {from:Date} AND {to:Date}
--           AND installation_kind = 'device'
--         GROUP BY local_day, installation_id)
--   GROUP BY local_day
--
--   `installation_kind = 'device'` because server installations never count as installations
--   and the test installation counts in no unique figure (UX Analytics section 10, AN-025);
--   a count of user IDs keeps server installations and drops only the test one. Active
--   figures (DAU, "any event") add `platform != 'server'`. Every filter here is a key of the
--   projection, so the optimizer still answers from it.

CREATE TABLE IF NOT EXISTS events_ingest
(
    database_key        UInt32,
    local_day           Date,
    effective_time      DateTime64(3, 'UTC'),
    received_time       DateTime64(3, 'UTC'),
    event_id            UUID,
    event_name_id       UInt32,
    category            LowCardinality(String),
    installation_id     UUID,
    installation_kind   Enum8('device' = 1, 'server' = 2, 'test' = 3),
    ephemeral           Bool,
    user_id             String,
    session_id          Nullable(UUID),
    platform            LowCardinality(String),
    os_name             LowCardinality(String),
    platform_version    LowCardinality(String),
    runtime_name        LowCardinality(String),
    runtime_version     LowCardinality(String),
    app_id              LowCardinality(String),
    app_version         LowCardinality(String),
    app_build           LowCardinality(String),
    locale              LowCardinality(String),
    country             LowCardinality(String),
    attribution         LowCardinality(String),
    experiment_keys     Array(LowCardinality(String)),
    experiment_variants Array(LowCardinality(String)),
    params              Map(LowCardinality(String), String),
    install_age_days    Nullable(UInt16),
    install_age_weeks   Nullable(UInt16),
    install_age_months  Nullable(UInt16),
    clock_corrected     Bool,
    credential_id       LowCardinality(String),
    is_replay           Bool,
    -- The session marker `session_rollup` reads (below); `events` never stores it.
    session_event       Enum8('none' = 0, 'started' = 1, 'crashed' = 2) DEFAULT 'none'
)
ENGINE = Null;

-- AN-162: one partition per database and ISO week of the local day. AN-013: the sort key
-- is the whole identity of an event, known at ingest, so a duplicate is one primary-key
-- read. The two projections are the internal rollups of AN-035: written with each part, so
-- they can never disagree with the events, and dropped with its partition.
CREATE TABLE IF NOT EXISTS events
(
    database_key        UInt32,
    local_day           Date,
    effective_time      DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
    received_time       DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
    -- UUIDv7: its 74 random bits are the floor; ZSTD saves a byte of 16 (DECISIONS 33.1).
    event_id            UUID CODEC(ZSTD(1)),
    event_name_id       UInt32,
    category            LowCardinality(String),
    installation_id     UUID,
    installation_kind   Enum8('device' = 1, 'server' = 2, 'test' = 3),
    ephemeral           Bool,
    user_id             String CODEC(ZSTD(1)),
    session_id          Nullable(UUID) CODEC(ZSTD(1)),
    platform            LowCardinality(String),
    os_name             LowCardinality(String),
    platform_version    LowCardinality(String),
    runtime_name        LowCardinality(String),
    runtime_version     LowCardinality(String),
    app_id              LowCardinality(String),
    app_version         LowCardinality(String),
    app_build           LowCardinality(String),
    locale              LowCardinality(String),
    country             LowCardinality(String),
    attribution         LowCardinality(String),
    experiment_keys     Array(LowCardinality(String)),
    experiment_variants Array(LowCardinality(String)),
    params              Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    install_age_days    Nullable(UInt16),
    install_age_weeks   Nullable(UInt16),
    install_age_months  Nullable(UInt16),
    clock_corrected     Bool,
    credential_id       LowCardinality(String),

    -- Profiles, drill-downs and erasure previews look events up by an ID that does not lead
    -- the sort key (DECISIONS 31.4).
    INDEX installation_id_bloom installation_id TYPE bloom_filter GRANULARITY 4,
    INDEX user_id_bloom user_id TYPE bloom_filter GRANULARITY 4,

    -- Rollup 1: events per event name, category, local day, installation, user ID and
    -- dimensions. Answers one event's counts, unique installations and users, splits and
    -- dimension filters without reading every event.
    PROJECTION by_event_day
    (
        SELECT database_key, event_name_id, local_day, category, installation_id, installation_kind,
               user_id, platform, os_name, platform_version, runtime_name, runtime_version, app_id,
               app_version, app_build, locale, country, attribution, experiment_keys,
               experiment_variants, install_age_days, install_age_weeks, install_age_months, count()
        GROUP BY database_key, event_name_id, local_day, category, installation_id, installation_kind,
                 user_id, platform, os_name, platform_version, runtime_name, runtime_version, app_id,
                 app_version, app_build, locale, country, attribution, experiment_keys,
                 experiment_variants, install_age_days, install_age_weeks, install_age_months
    ),

    -- Rollup 2: events per local day, installation, user ID and dimensions, whatever the
    -- name. Answers active installations and users (DAU, WAU, MAU, AN-140) and "any event"
    -- (AN-060). A reader keeps `platform != 'server' AND installation_kind = 'device'`, so
    -- background events and server and test installations count in no active figure.
    PROJECTION by_day
    (
        SELECT database_key, local_day, installation_id, installation_kind, user_id, platform,
               os_name, platform_version, runtime_name, runtime_version, app_id, app_version,
               app_build, locale, country, attribution, experiment_keys,
               experiment_variants, install_age_days, install_age_weeks, install_age_months, count()
        GROUP BY database_key, local_day, installation_id, installation_kind, user_id, platform,
                 os_name, platform_version, runtime_name, runtime_version, app_id, app_version,
                 app_build, locale, country, attribution, experiment_keys,
                 experiment_variants, install_age_days, install_age_weeks, install_age_months
    )
)
ENGINE = MergeTree
PARTITION BY (database_key, toMonday(local_day))
ORDER BY (database_key, event_name_id, local_day, installation_id, effective_time, event_id)
-- A table with projections refuses lightweight deletes unless told what to do with them;
-- `rebuild` keeps the rollups equal to the events after an erasure (DECISIONS 31.5).
-- Nullable install ages are projection keys, which need nullable keys allowed.
SETTINGS lightweight_mutation_projection_mode = 'rebuild', allow_nullable_key = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS events_mv TO events AS
SELECT * EXCEPT (is_replay, session_event) FROM events_ingest WHERE NOT is_replay;

-- AN-031. Partitioned by database so that removing a database drops its partitions here as
-- in `events` (AN-004). The tuple states compress well with ZSTD: most of their bytes are
-- dimension strings that repeat from row to row.
CREATE TABLE IF NOT EXISTS installations
(
    database_key        UInt32,
    installation_id     UUID,
    -- 1 once a qualifying event has been stored: the existence rule.
    has_qualifying      SimpleAggregateFunction(max, UInt8),
    -- The install time, install day and install dimensions: the qualifying event received first.
    install             AggregateFunction(minIf, Tuple(received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), day Date, platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String)), UInt8) CODEC(ZSTD(3)),
    -- The first non-empty attribution a qualifying event reported, received first.
    install_attribution AggregateFunction(minIf, Tuple(received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), attribution String), UInt8) CODEC(ZSTD(3)),
    -- Effective times: first qualifying event, last non-background event, last event of any platform.
    first_seen          SimpleAggregateFunction(min, Nullable(DateTime64(3, 'UTC'))),
    last_seen           SimpleAggregateFunction(max, Nullable(DateTime64(3, 'UTC'))),
    last_event          SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    -- The latest dimensions, attribution and experiments: the latest qualifying event.
    latest              AggregateFunction(maxIf, Tuple(time DateTime64(3, 'UTC'), received DateTime64(3, 'UTC'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String)), UInt8) CODEC(ZSTD(3)),
    installation_kind   SimpleAggregateFunction(max, Enum8('device' = 1, 'server' = 2, 'test' = 3)),
    ephemeral           SimpleAggregateFunction(max, Bool)
)
ENGINE = AggregatingMergeTree
PARTITION BY database_key
ORDER BY (database_key, installation_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS installations_mv TO installations AS
SELECT
    database_key,
    installation_id,
    max(qualifying) AS has_qualifying,
    minIfState(CAST(tuple(received_time, effective_time, local_day, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, country, attribution, experiment_keys, experiment_variants),
                    'Tuple(received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), day Date, platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))'),
               qualifying) AS install,
    minIfState(CAST(tuple(received_time, effective_time, attribution), 'Tuple(received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), attribution String)'),
               toUInt8(qualifying AND attribution != '')) AS install_attribution,
    min(if(qualifying, effective_time, NULL)) AS first_seen,
    max(if(platform != 'server', effective_time, NULL)) AS last_seen,
    max(effective_time) AS last_event,
    maxIfState(CAST(tuple(effective_time, received_time, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, country, attribution, experiment_keys, experiment_variants),
                    'Tuple(time DateTime64(3, \'UTC\'), received DateTime64(3, \'UTC\'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))'),
               qualifying) AS latest,
    max(installation_kind) AS installation_kind,
    max(ephemeral) AS ephemeral
-- `qualifying` in a subquery: in the outer query `installation_kind` names the aggregate.
FROM (SELECT *, toUInt8(platform != 'server' OR installation_kind = 'server') AS qualifying FROM events_ingest)
GROUP BY database_key, installation_id;

-- AN-031 identity links: every user ID an installation has carried, with when.
CREATE TABLE IF NOT EXISTS installation_users
(
    database_key    UInt32,
    installation_id UUID,
    user_id         String,
    first_seen      SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    last_seen       SimpleAggregateFunction(max, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY database_key
ORDER BY (database_key, installation_id, user_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS installation_users_mv TO installation_users AS
SELECT database_key, installation_id, user_id,
       min(effective_time) AS first_seen, max(effective_time) AS last_seen
FROM events_ingest
WHERE user_id != ''
GROUP BY database_key, installation_id, user_id;

-- AN-036: first occurrences per installation, and per user ID, and event name. Event-name
-- ID 0 is "any event of a device installation that is not a background event", which
-- cohorts starting at the first event read. `first` starts with the local day, so its
-- minimum is the earliest day, then the occurrence received first on it.
CREATE TABLE IF NOT EXISTS installation_first
(
    database_key    UInt32,
    event_name_id   UInt32,
    installation_id UUID,
    first           SimpleAggregateFunction(min, Tuple(day Date, received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))) CODEC(ZSTD(3))
)
ENGINE = AggregatingMergeTree
PARTITION BY database_key
ORDER BY (database_key, event_name_id, installation_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS installation_first_mv TO installation_first AS
SELECT
    database_key,
    arrayJoin(if(installation_kind = 'device' AND platform != 'server',
                 [event_name_id, toUInt32(0)], [event_name_id])) AS event_name_id,
    installation_id,
    min(CAST(tuple(local_day, received_time, effective_time, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, country, attribution, experiment_keys, experiment_variants),
             'Tuple(day Date, received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))')) AS first
FROM events_ingest
GROUP BY database_key, event_name_id, installation_id;

CREATE TABLE IF NOT EXISTS user_first
(
    database_key  UInt32,
    event_name_id UInt32,
    user_id       String,
    first         SimpleAggregateFunction(min, Tuple(day Date, received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))) CODEC(ZSTD(3))
)
ENGINE = AggregatingMergeTree
PARTITION BY database_key
ORDER BY (database_key, event_name_id, user_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS user_first_mv TO user_first AS
SELECT
    database_key,
    arrayJoin(if(installation_kind = 'device' AND platform != 'server',
                 [event_name_id, toUInt32(0)], [event_name_id])) AS event_name_id,
    user_id,
    min(CAST(tuple(local_day, received_time, effective_time, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, country, attribution, experiment_keys, experiment_variants),
             'Tuple(day Date, received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))')) AS first
FROM events_ingest
WHERE user_id != ''
GROUP BY database_key, event_name_id, user_id;

-- The day each app version was first seen (UX Analytics AN-142, DECISIONS 33.5): the markers
-- on the Overview's chart of daily active units.
--
-- Answering it from the events would read every rollup row of the storage window, since no
-- sort key leads with the app version: about 400 million rows at the reference workload, for
-- one marker line. This table keeps one row per database, app, platform and app version, a few hundred per database, so the Overview reads it whole. Like the first
-- occurrences (AN-036), it outlives the events of its first day, so a version first seen
-- before the oldest week retention keeps still shows its true first day.
--
-- It counts what "any event" and the active figures count (AN-047, AN-060): events of device
-- installations that are not background events, so neither a server nor the test
-- installation, nor a backend's event, marks a version. `first` is the local day of the
-- earliest such event accepted; a late event on an earlier day lowers it, as it lowers a
-- first occurrence.
--
-- Read, one database:
--
--   SELECT app_version, min(first) AS first
--   FROM version_first
--   WHERE database_key = {databaseKey:UInt32} AND app_version != ''   -- plus filters on app_id and platform
--   GROUP BY app_version
--
-- Partitioned by database, as `installations` is, so removing a database drops its rows.

CREATE TABLE IF NOT EXISTS version_first
(
    database_key UInt32,
    app_id       LowCardinality(String),
    platform     LowCardinality(String),
    app_version  LowCardinality(String),
    first        SimpleAggregateFunction(min, Date)
)
ENGINE = AggregatingMergeTree
PARTITION BY database_key
ORDER BY (database_key, app_id, app_version, platform);

CREATE MATERIALIZED VIEW IF NOT EXISTS version_first_mv TO version_first AS
SELECT database_key, app_id, platform, app_version, min(local_day) AS first
FROM events_ingest
WHERE installation_kind = 'device' AND platform != 'server'
GROUP BY database_key, app_id, platform, app_version;

-- What each pending erasure deletes (Foundations FD-033, UX Analytics AN-183 to AN-185,
-- DECISIONS 33.10), held here so that no erased ID is ever written into a statement's text.
--
-- A lightweight DELETE's text is kept by the event store in `system.mutations` and in a
-- `mutation_N.txt` file beside the table's parts, until newer mutations of the table push it out
-- (`finished_mutations_to_keep`, 100), which may be never. Every delete, replay and file check
-- of the erasure worker therefore names its targets by erasure number only:
--
--   DELETE FROM events WHERE database_key = {key:UInt32}
--     AND (installation_id IN (SELECT arrayJoin(installations) FROM analytics_erasure_targets WHERE erasure = {n:UInt64})
--          OR user_id IN (SELECT erased_user FROM analytics_erasure_targets WHERE erasure = {n:UInt64} AND erased_user != ''))
--     AND received_time < (SELECT any(before) FROM analytics_erasure_targets WHERE erasure = {n:UInt64})
--
-- `erasure` is the pending erasure's ID in PostgreSQL (`analytics_pending_erasures.id`); its
-- partition is dropped with the pending erasure, once no file carries the rows, and any
-- partition PostgreSQL no longer knows (a database removed meanwhile) at the worker's next pass.
-- There is no database key here: the pending erasure knows its database.

CREATE TABLE IF NOT EXISTS analytics_erasure_targets
(
    erasure       UInt64,
    -- The installations erased: the installation, or a user's server installation and those it
    -- was the only user of.
    installations Array(UUID),
    -- The installations the erased user was seen on that are kept: their own state is derived
    -- again from the events that remain.
    shared        Array(UUID),
    -- The erased user ID; '' for an installation's erasure.
    erased_user   String,
    -- The erasure's time: rows received before it are erased, later ones kept (AN-184).
    before        DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY erasure
ORDER BY erasure;

-- ─── Internal rollups (UX Analytics AN-035, 9.5; DECISIONS 33.12c measured, 33.12d built) ────
--
-- AN-035 allows them on four conditions, which every reader and every deletion here keeps:
-- maintained from exactly the events stored (fed by materialized views from `events_ingest`,
-- replays included, with idempotent states, so a duplicate or a replay changes nothing); holding
-- nothing the events do not; dropped, erased and deleted with them; and never visible (no answer,
-- setting, export or Storage figure names them, and every answer equals what the events give).
--
-- Event names are catalog IDs that PostgreSQL assigns per database, so a view cannot know which ID
-- is `app_started`. Ingest, which knows each event's name, marks the two standard events that make
-- sessions in `session_event` (AN-043, AN-044, AN-152); the erasure's replay marks them from the
-- resolved IDs.

-- ─── session_rollup: sessions and crashed sessions for the Overview (AN-043, AN-140, AN-152) ──
--
-- One row per database, ISO week of the local day, event name, session and installation: for a
-- session's `app_started` of a device installation that is not a background event, the first one
-- accepted that week (received first, then earliest, as "first" above), with its local day, app,
-- platform, app version and `crashReporting`; for its `session_crashed` (any platform),
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
    first           SimpleAggregateFunction(min, Tuple(received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), day Date, app_id String, platform String, app_version String, crash_reporting Bool)) CODEC(ZSTD(3))
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
    min(CAST(tuple(received_time, effective_time, local_day, app_id, platform, app_version, params['crashReporting'] = 'true'),
             'Tuple(received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), day Date, app_id String, platform String, app_version String, crash_reporting Bool)')) AS first
-- AN-043, AN-047: a session is made by an app_started of a device installation that is not a
-- background event; AN-152: a session_crashed names a session from any platform.
FROM (SELECT *, assumeNotNull(session_id) AS sid FROM events_ingest
      WHERE session_id IS NOT NULL
        AND (session_event = 'crashed' OR (session_event = 'started' AND installation_kind = 'device' AND platform != 'server')))
GROUP BY database_key, week, event_name_id, sid, installation_id;

-- ─── installation_index: the installation records in plain columns (AN-031, AN-102, AN-120) ──
--
-- The same values as `installations`, from the same rows by the same rules, but stored as
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
    install           SimpleAggregateFunction(min, Tuple(received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), day Date, platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))) CODEC(ZSTD(3)),
    latest            SimpleAggregateFunction(max, Tuple(time DateTime64(3, 'UTC'), received DateTime64(3, 'UTC'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))) CODEC(ZSTD(3))
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
       minIf(CAST(tuple(received_time, effective_time, local_day, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, country, attribution, experiment_keys, experiment_variants),
                  'Tuple(received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), day Date, platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))'),
             qualifying),
       CAST(tuple(toDateTime64('2299-12-31 23:59:59.999', 3, 'UTC'), toDateTime64('2299-12-31 23:59:59.999', 3, 'UTC'), toDate('2149-06-06'), '', '', '', '', '', '', '', '', '', '', '', [], []),
            'Tuple(received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), day Date, platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))')) AS install,
    -- Without a qualifying event, maxIf gives the tuple's default (1970, empty strings), which any
    -- real event's tuple exceeds.
    maxIf(CAST(tuple(effective_time, received_time, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, country, attribution, experiment_keys, experiment_variants),
               'Tuple(time DateTime64(3, \'UTC\'), received DateTime64(3, \'UTC\'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))'),
          qualifying) AS latest
-- `qualifying` in a subquery, as in installations_mv: in the outer query `installation_kind` names the aggregate.
FROM (SELECT *, toUInt8(platform != 'server' OR installation_kind = 'server') AS qualifying FROM events_ingest)
GROUP BY database_key, installation_id;
