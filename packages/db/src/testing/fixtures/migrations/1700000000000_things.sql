-- expand
-- Fixture for migrate.test.ts and rehearsal.test.ts: a table to fill.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create table public.things (id bigint primary key);

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
drop table public.things;
