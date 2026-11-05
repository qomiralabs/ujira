-- expand
-- Fixture for migrate.test.ts and rehearsal.test.ts: a table to fill.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create table public.things (id bigint primary key);
-- A concurrent build runs as the owner role, as it does on the real schema.
alter table public.things owner to ujira_owner;
grant create on schema public to ujira_owner;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
revoke create on schema public from ujira_owner;
drop table public.things;
