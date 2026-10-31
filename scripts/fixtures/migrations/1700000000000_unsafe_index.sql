-- expand
-- A fixture, never run. It indexes a table that already holds rows without
-- CONCURRENTLY, which blocks every write to that table for the whole build.
-- CI runs squawk on this file and fails if squawk lets it through.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create index payouts_created_at on ujira.payouts (created_at);

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
drop index ujira.payouts_created_at;
