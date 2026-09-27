-- The day each app version was first seen (UX Analytics AN-142, DECISIONS 33.5): the markers
-- on the Overview's chart of daily active units.
--
-- Answering it from the events would read every rollup row of the storage window, since no
-- sort key leads with the app version: about 400 million rows at the reference workload, for
-- one marker line. This table keeps one row per database, app, platform, environment and app
-- version, a few hundred per database, so the Overview reads it whole. Like the first
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
--   WHERE database_key = {databaseKey:UInt32} AND app_version != ''   -- plus filters on app_id, platform, environment
--   GROUP BY app_version
--
-- Partitioned by database, as `installations` is, so removing a database drops its rows.

CREATE TABLE IF NOT EXISTS version_first
(
    database_key UInt32,
    app_id       LowCardinality(String),
    platform     LowCardinality(String),
    environment  LowCardinality(String),
    app_version  LowCardinality(String),
    first        SimpleAggregateFunction(min, Date)
)
ENGINE = AggregatingMergeTree
PARTITION BY database_key
ORDER BY (database_key, app_id, app_version, platform, environment);

CREATE MATERIALIZED VIEW IF NOT EXISTS version_first_mv TO version_first AS
SELECT database_key, app_id, platform, environment, app_version, min(local_day) AS first
FROM events_ingest
WHERE installation_kind = 'device' AND platform != 'server'
GROUP BY database_key, app_id, platform, environment, app_version;
