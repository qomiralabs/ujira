-- expand
-- no-transaction
-- Fixture: a concurrent index build, which Postgres refuses inside a
-- transaction block.

-- Up Migration
create index concurrently if not exists things_note on public.things (note);

-- Down Migration
drop index concurrently if exists public.things_note;
