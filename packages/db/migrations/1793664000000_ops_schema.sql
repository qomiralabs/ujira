-- expand
-- The operations schema: indexer cursors, executor accounts and routing
-- configuration versions. These hold no tenant data, so they are the one
-- explicit exception to tenant columns on every row, and they live apart
-- from ujira with their own role. ops-no-customer-data.test.ts holds the
-- exception to its word: no tenant columns, no reference to a tenant table,
-- no personal data by name or by value.
--
-- The app role cannot read these tables. It reaches them only through the
-- narrow functions at the end of this file, which run as ujira_ops.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is
-- never dropped by the down section. Its password is set outside migrations.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_ops') then
    create role ujira_ops login noinherit nobypassrls;
  end if;
  alter role ujira_ops nobypassrls;
end
$roles$;

-- The owner hands the functions to this role, which needs the owner to be
-- able to act as it.
grant ujira_ops to ujira_owner;

set local role ujira_owner;

-- Creating a schema needs CREATE on the database, which the owner role does not
-- hold, so it is created for the owner rather than by it.
reset role;
create schema ops authorization ujira_owner;
set local role ujira_owner;

revoke all on schema ops from public;
grant usage on schema ops to ujira_ops, ujira_app;

-- Where the indexer has read up to on each network.
create table ops.chain_cursors (
  network text primary key
    constraint chain_cursors_network_format check (network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'),
  cursor text not null,
  updated_at timestamptz not null default now()
);

-- The accounts that submit transactions, one lease holder at a time. A lease
-- is a holder and an expiry together, so an expired lease is free again
-- without anyone having to clean it up. lease_id fencing arrives with #71.
create table ops.executor_accounts (
  network text not null
    constraint executor_accounts_network_format check (network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'),
  -- A reference to the chain account, never a key.
  account_ref text not null,
  lease_holder text,
  lease_expires_at timestamptz,
  next_sequence bigint not null default 0
    constraint executor_accounts_sequence_positive check (next_sequence >= 0),
  primary key (network, account_ref),
  constraint executor_accounts_lease_whole
    check ((lease_holder is null) = (lease_expires_at is null))
);

-- Immutable versions of the routing configuration, so what routed a payout
-- can always be read back. created_by names a service or a runbook; the
-- format refuses an email, because this schema holds no personal data.
create table ops.routing_config_versions (
  version bigint generated always as identity primary key,
  document jsonb not null,
  created_by text not null
    constraint routing_config_created_by_format check (created_by ~ '^[a-z0-9_.:-]{1,64}$'),
  created_at timestamptz not null default now()
);

create trigger routing_config_versions_append_only
  before update or delete on ops.routing_config_versions
  for each row execute function ujira.forbid_mutation();

-- Which version is live. One row at most, so there is never a question of
-- which pointer counts.
create table ops.routing_config_active (
  only_row boolean primary key default true
    constraint routing_config_active_one_row check (only_row),
  version bigint not null references ops.routing_config_versions (version),
  updated_at timestamptz not null default now()
);

create trigger chain_cursors_touch before update on ops.chain_cursors
  for each row execute function ujira.touch();
create trigger routing_config_active_touch before update on ops.routing_config_active
  for each row execute function ujira.touch();

grant select, insert, update on ops.chain_cursors to ujira_ops;
grant select, insert, update on ops.executor_accounts to ujira_ops;
grant select, insert on ops.routing_config_versions to ujira_ops;
grant select, insert, update on ops.routing_config_active to ujira_ops;

-- Takes a free account on the network for this holder, or returns no row.
-- SKIP LOCKED makes concurrent callers take different accounts instead of
-- queueing on the same one and then both believing they won it.
create function ops.lease_executor(target_network text, holder text, lease_seconds integer)
  returns table (account_ref text, next_sequence bigint, lease_expires_at timestamptz)
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
begin
  if lease_seconds is null or lease_seconds < 1 or lease_seconds > 3600 then
    raise exception using
      errcode = '22023',
      message = 'a lease lasts from 1 to 3600 seconds';
  end if;
  return query
    update ops.executor_accounts as e
       set lease_holder = holder,
           lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds)
     where (e.network, e.account_ref) = (
       select c.network, c.account_ref
         from ops.executor_accounts as c
        where c.network = target_network
          and (c.lease_expires_at is null or c.lease_expires_at < clock_timestamp())
        order by c.account_ref
        limit 1
        for update skip locked
     )
    returning e.account_ref, e.next_sequence, e.lease_expires_at;
end
$fn$;

-- Gives the account back and records how far its sequence got. Only the
-- current holder can, and the sequence never moves backwards. True when the
-- holder still held it.
create function ops.release_executor(
  target_network text,
  account text,
  holder text,
  sequence_reached bigint
) returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  released integer;
begin
  update ops.executor_accounts as e
     set lease_holder = null,
         lease_expires_at = null,
         next_sequence = greatest(e.next_sequence, sequence_reached)
   where e.network = target_network
     and e.account_ref = account
     and e.lease_holder = holder;
  get diagnostics released = row_count;
  return released > 0;
end
$fn$;

-- The live routing configuration, or no row before one is activated.
create function ops.active_routing_config()
  returns table (version bigint, document jsonb)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select v.version, v.document
    from ops.routing_config_active as a
    join ops.routing_config_versions as v on v.version = a.version
$fn$;

grant execute on function
  ops.lease_executor(text, text, integer),
  ops.release_executor(text, text, text, bigint),
  ops.active_routing_config()
  to ujira_app;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ops to ujira_ops;
alter function ops.lease_executor(text, text, integer) owner to ujira_ops;
alter function ops.release_executor(text, text, text, bigint) owner to ujira_ops;
alter function ops.active_routing_config() owner to ujira_ops;
revoke create on schema ops from ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function ops.active_routing_config();
drop function ops.release_executor(text, text, text, bigint);
drop function ops.lease_executor(text, text, integer);
drop table ops.routing_config_active;
drop table ops.routing_config_versions;
drop table ops.executor_accounts;
drop table ops.chain_cursors;
drop schema ops;
revoke ujira_ops from ujira_owner;
