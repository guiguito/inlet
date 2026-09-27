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
