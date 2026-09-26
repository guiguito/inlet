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
--           AND local_day BETWEEN {from:Date} AND {to:Date} AND environment = 'production'
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
    environment         LowCardinality(String),
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
    is_replay           Bool
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
    environment         LowCardinality(String),
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
               app_version, app_build, locale, environment, country, attribution, experiment_keys,
               experiment_variants, install_age_days, install_age_weeks, install_age_months, count()
        GROUP BY database_key, event_name_id, local_day, category, installation_id, installation_kind,
                 user_id, platform, os_name, platform_version, runtime_name, runtime_version, app_id,
                 app_version, app_build, locale, environment, country, attribution, experiment_keys,
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
               app_build, locale, environment, country, attribution, experiment_keys,
               experiment_variants, install_age_days, install_age_weeks, install_age_months, count()
        GROUP BY database_key, local_day, installation_id, installation_kind, user_id, platform,
                 os_name, platform_version, runtime_name, runtime_version, app_id, app_version,
                 app_build, locale, environment, country, attribution, experiment_keys,
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
SELECT * EXCEPT (is_replay) FROM events_ingest WHERE NOT is_replay;

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
    install             AggregateFunction(minIf, Tuple(received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), day Date, platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String)), UInt8) CODEC(ZSTD(3)),
    -- The first non-empty attribution a qualifying event reported, received first.
    install_attribution AggregateFunction(minIf, Tuple(received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), attribution String), UInt8) CODEC(ZSTD(3)),
    -- Effective times: first qualifying event, last non-background event, last event of any platform.
    first_seen          SimpleAggregateFunction(min, Nullable(DateTime64(3, 'UTC'))),
    last_seen           SimpleAggregateFunction(max, Nullable(DateTime64(3, 'UTC'))),
    last_event          SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    -- The latest dimensions, attribution and experiments: the latest qualifying event.
    latest              AggregateFunction(maxIf, Tuple(time DateTime64(3, 'UTC'), received DateTime64(3, 'UTC'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String)), UInt8) CODEC(ZSTD(3)),
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
    minIfState(CAST(tuple(received_time, effective_time, local_day, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, environment, country, attribution, experiment_keys, experiment_variants),
                    'Tuple(received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), day Date, platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))'),
               qualifying) AS install,
    minIfState(CAST(tuple(received_time, effective_time, attribution), 'Tuple(received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), attribution String)'),
               toUInt8(qualifying AND attribution != '')) AS install_attribution,
    min(if(qualifying, effective_time, NULL)) AS first_seen,
    max(if(platform != 'server', effective_time, NULL)) AS last_seen,
    max(effective_time) AS last_event,
    maxIfState(CAST(tuple(effective_time, received_time, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, environment, country, attribution, experiment_keys, experiment_variants),
                    'Tuple(time DateTime64(3, \'UTC\'), received DateTime64(3, \'UTC\'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))'),
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
    first           SimpleAggregateFunction(min, Tuple(day Date, received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))) CODEC(ZSTD(3))
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
    min(CAST(tuple(local_day, received_time, effective_time, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, environment, country, attribution, experiment_keys, experiment_variants),
             'Tuple(day Date, received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))')) AS first
FROM events_ingest
GROUP BY database_key, event_name_id, installation_id;

CREATE TABLE IF NOT EXISTS user_first
(
    database_key  UInt32,
    event_name_id UInt32,
    user_id       String,
    first         SimpleAggregateFunction(min, Tuple(day Date, received DateTime64(3, 'UTC'), time DateTime64(3, 'UTC'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))) CODEC(ZSTD(3))
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
    min(CAST(tuple(local_day, received_time, effective_time, platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build, locale, environment, country, attribution, experiment_keys, experiment_variants),
             'Tuple(day Date, received DateTime64(3, \'UTC\'), time DateTime64(3, \'UTC\'), platform String, os_name String, platform_version String, runtime_name String, runtime_version String, app_id String, app_version String, app_build String, locale String, environment String, country String, attribution String, experiment_keys Array(String), experiment_variants Array(String))')) AS first
FROM events_ingest
WHERE user_id != ''
GROUP BY database_key, event_name_id, user_id;
