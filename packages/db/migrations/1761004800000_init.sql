-- expand
-- The first migration. It creates nothing: the tenancy schema, the roles
-- bootstrap and the payout tables each arrive in their own migration. This
-- one exists so the tool has a migration to run up and down from the start,
-- and so the migrations table is created by a migration rather than by a
-- test.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select 1;
create table public.drift_probe (id bigint primary key);

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select 1;
