-- expand
-- Fixture: takes an exclusive lock on a table that already has rows and holds
-- it long enough for the rehearsal to see reads queue behind it.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table public.things add column note text;
select pg_sleep(0.6);

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table public.things drop column note;
