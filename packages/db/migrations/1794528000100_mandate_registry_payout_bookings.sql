-- expand
-- Which contracts are mandates, and one booking per payout of each.
--
-- A contract cannot prove which factory deployed it, so this registry is the only
-- proof there is. Event intake writes it from a trusted factory's mandate_created,
-- which is public chain data about a contract and holds nothing about a tenant.
-- It lives in ops because a principal can create a mandate no tenant here has
-- claimed yet, so a row may have no tenant to carry. The tag cannot link two
-- mandates of one tenant, since it is derived for each contract separately.
--
-- The indexer's login reaches the registry only through the functions below, as
-- the app's does, so neither can write a row by any other route.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ops.mandate_registry (
  network text not null
    constraint mandate_registry_network_format check (network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'),
  contract_id text not null
    constraint mandate_registry_contract_length check (char_length(contract_id) between 1 and 128),
  -- The source the ledger recorded for the event, never a value inside it.
  factory_id text not null
    constraint mandate_registry_factory_length check (char_length(factory_id) between 1 and 128),
  tenant_tag bytea not null
    constraint mandate_registry_tag_length check (octet_length(tenant_tag) = 32),
  tx_hash bytea not null
    constraint mandate_registry_tx_length check (octet_length(tx_hash) = 32),
  event_index bigint not null
    constraint mandate_registry_index_positive check (event_index >= 0),
  ledger bigint not null
    constraint mandate_registry_ledger_positive check (ledger >= 0),
  -- Set when the tag differs from the tag of the tenant that claims the contract.
  flagged_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (network, contract_id)
);

grant select, insert, update on ops.mandate_registry to ujira_ops;
grant usage on schema ops to ujira_indexer;

-- Adds a contract, or changes nothing when it is already there. True when added.
create function ops.register_mandate(
  target_network text,
  contract text,
  factory text,
  tag bytea,
  tx bytea,
  event_at bigint,
  at_ledger bigint
) returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  added integer;
begin
  insert into ops.mandate_registry
    (network, contract_id, factory_id, tenant_tag, tx_hash, event_index, ledger)
  values (target_network, contract, factory, tag, tx, event_at, at_ledger)
  on conflict (network, contract_id) do nothing;
  get diagnostics added = row_count;
  return added > 0;
end
$fn$;

-- A flag stays: its first time is kept, and nothing here can lift it.
create function ops.flag_mandate(target_network text, contract text) returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  flagged integer;
begin
  update ops.mandate_registry as r
     set flagged_at = coalesce(r.flagged_at, clock_timestamp())
   where r.network = target_network
     and r.contract_id = contract;
  get diagnostics flagged = row_count;
  return flagged > 0;
end
$fn$;

create function ops.registered_mandate(target_network text, contract text)
  returns table (factory_id text, tenant_tag bytea, flagged boolean)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select r.factory_id, r.tenant_tag, r.flagged_at is not null
    from ops.mandate_registry as r
   where r.network = target_network
     and r.contract_id = contract
$fn$;

-- The app reads, to decide whether a contract is a mandate. Only the indexer,
-- which reads the chain, can add one.
grant execute on function ops.registered_mandate(text, text) to ujira_app, ujira_indexer;
grant execute on function
  ops.register_mandate(text, text, text, bytea, bytea, bigint, bigint),
  ops.flag_mandate(text, text)
  to ujira_indexer;

revoke execute on function
  ops.register_mandate(text, text, text, bytea, bytea, bigint, bigint),
  ops.flag_mandate(text, text),
  ops.registered_mandate(text, text)
  from public;

grant create on schema ops to ujira_ops;
alter function ops.register_mandate(text, text, text, bytea, bytea, bigint, bigint)
  owner to ujira_ops;
alter function ops.flag_mandate(text, text) owner to ujira_ops;
alter function ops.registered_mandate(text, text) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

-- One row per payout of one contract. The key holds the contract, so two mandates
-- with an equal payout ID can never be booked as one payment. A contract belongs
-- to one chain and one tenant, so this key is global.
create table ujira.payout_bookings (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_instance_id uuid not null,
  chain text not null,
  contract_address text not null,
  payout_id ujira.hash32 not null,
  last_event_id uuid not null,
  last_event_type text not null
    constraint payout_bookings_type_length check (char_length(last_event_type) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_bookings_once unique (chain, contract_address, payout_id),
  constraint payout_bookings_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id, chain)
    references ujira.mandate_instances (principal_id, project_id, id, chain),
  foreign key (principal_id, project_id, last_event_id)
    references ujira.chain_events (principal_id, project_id, id)
);

create index payout_bookings_by_instance
  on ujira.payout_bookings (principal_id, project_id, mandate_instance_id, id);

-- A booking names its instance's own contract. A foreign key would need a new
-- unique index on mandate_instances, a live table, and that index could only be
-- built concurrently, outside a transaction and so outside the owner's rights.
-- An instance's address never changes, since nobody may update the table, so a
-- check when the row is written cannot go stale. It runs as the role that may read
-- every instance, and only answers about the one the row names, in its own tenant.
create function ujira.check_payout_booking() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
begin
  if not exists (
    select 1
      from ujira.mandate_instances as i
     where i.id = new.mandate_instance_id
       and i.principal_id = new.principal_id
       and i.project_id = new.project_id
       and i.chain = new.chain
       and i.contract_address = new.contract_address
  ) then
    raise exception using
      errcode = '23503',
      message = 'a payout booking names its mandate instance''s own contract';
  end if;
  return null;
end
$fn$;

-- What a booking is about never changes, only the last event that moved it.
create function ujira.keep_payout_booking() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if new.principal_id <> old.principal_id or new.project_id <> old.project_id
     or new.mandate_instance_id <> old.mandate_instance_id or new.chain <> old.chain
     or new.contract_address <> old.contract_address or new.payout_id <> old.payout_id then
    raise exception using
      errcode = 'UJ006',
      message = 'a payout booking keeps its tenant, contract and payout';
  end if;
  return new;
end
$fn$;

grant create on schema ujira to ujira_fn_instances;
alter function ujira.check_payout_booking() owner to ujira_fn_instances;
revoke create on schema ujira from ujira_fn_instances;
revoke execute on function ujira.check_payout_booking(), ujira.keep_payout_booking() from public;

create trigger payout_bookings_check_new after insert on ujira.payout_bookings
  for each row execute function ujira.check_payout_booking();
create trigger payout_bookings_keep before update on ujira.payout_bookings
  for each row execute function ujira.keep_payout_booking();
create trigger payout_bookings_touch before update on ujira.payout_bookings
  for each row execute function ujira.touch();

select ujira.apply_tenant_policies('ujira.payout_bookings');

create policy indexer_read on ujira.payout_bookings for select to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_insert on ujira.payout_bookings for insert to ujira_indexer
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_update on ujira.payout_bookings for update to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id())
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());

grant select on ujira.payout_bookings to ujira_app, ujira_reader;
grant select, insert, update on ujira.payout_bookings to ujira_indexer;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop table ujira.payout_bookings;
drop function ujira.keep_payout_booking();
drop function ujira.check_payout_booking();
drop function ops.registered_mandate(text, text);
drop function ops.flag_mandate(text, text);
drop function ops.register_mandate(text, text, text, bytea, bytea, bigint, bigint);
drop table ops.mandate_registry;
revoke usage on schema ops from ujira_indexer;
