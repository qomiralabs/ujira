-- expand
-- Mandates, their deployed instances, funding sources, finalized chain events
-- and deposits. The database mirrors each logical mandate and its contract on
-- each chain, and records every finalized event exactly once, so balances,
-- receipts and the dashboard can be rebuilt from the chains.
--
-- The indexer writes the mirror. It learns the tenant of a contract from
-- resolve_mandate_instance, then writes under that tenant's context like any
-- other service role, so the policies hold for it too.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is
-- never dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_fn_instances') then
    create role ujira_fn_instances nologin noinherit nobypassrls;
  end if;
  alter role ujira_fn_instances nobypassrls;
end
$roles$;

grant ujira_fn_instances to ujira_owner;

set local role ujira_owner;

-- How a project behaves when no network can fund a payout. The hold rows
-- themselves reference payouts, so they arrive with that table.
alter table ujira.projects
  add column chain_fallback text not null default 'off'
    constraint projects_chain_fallback check (chain_fallback in ('off', 'verified_methods')),
  add column funding_hold_max_seconds bigint not null default 1209600
    constraint projects_funding_hold_range
      check (funding_hold_max_seconds between 3600 and 2592000);

create table ujira.mandates (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint mandates_name_length check (char_length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mandates_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

-- One deployed contract per chain and asset. The foreign key to the
-- settlement tokens is what refuses an asset the chain does not settle, or
-- one at the wrong scale.
create table ujira.mandate_instances (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_id uuid not null,
  chain text not null,
  contract_address text not null
    constraint mandate_instances_address_length check (char_length(contract_address) between 1 and 128),
  spec_version text not null
    constraint mandate_instances_spec_length check (char_length(spec_version) between 1 and 32),
  asset text not null,
  scale ujira.scale not null,
  created_at timestamptz not null default now(),
  constraint mandate_instances_address_key unique (chain, contract_address),
  -- Scoped to the tenant, as every key that does not have to be global is: a
  -- global one would tell a caller naming another tenant's mandate that it
  -- already has an instance.
  constraint mandate_instances_per_asset
    unique (principal_id, project_id, mandate_id, chain, asset),
  constraint mandate_instances_tenant_key unique (principal_id, project_id, id),
  -- What a chain event points at, so an event cannot claim one chain while
  -- naming an instance on another.
  constraint mandate_instances_chain_key unique (principal_id, project_id, id, chain),
  -- What a deposit points at, so money recorded against an instance is always
  -- in that instance's asset, on its chain, at its scale.
  constraint mandate_instances_unit_key unique (principal_id, project_id, id, chain, asset, scale),
  foreign key (principal_id, project_id, mandate_id)
    references ujira.mandates (principal_id, project_id, id),
  foreign key (asset, chain, scale)
    references ujira.settlement_tokens (asset, chain, token_scale)
);

create table ujira.funding_sources (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_instance_id uuid not null,
  -- Stablecoin deposits only at launch. Other kinds are added by a migration.
  kind text not null
    constraint funding_sources_kind check (kind in ('stablecoin_deposit')),
  created_at timestamptz not null default now(),
  constraint funding_sources_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id)
    references ujira.mandate_instances (principal_id, project_id, id)
);

-- Every finalized event, once. The unique key is the idempotency of
-- ingestion: a chain reorganization or a restarted indexer can present the
-- same event any number of times and only the first is stored.
create table ujira.chain_events (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_instance_id uuid not null,
  chain text not null,
  tx_hash ujira.hash32 not null,
  event_index bigint not null
    constraint chain_events_index_positive check (event_index >= 0),
  ledger bigint not null
    constraint chain_events_ledger_positive check (ledger >= 0),
  event_type text not null
    constraint chain_events_type_length check (char_length(event_type) between 1 and 64),
  payload jsonb not null,
  finalized_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint chain_events_once unique (chain, tx_hash, event_index),
  constraint chain_events_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id, chain)
    references ujira.mandate_instances (principal_id, project_id, id, chain)
);

create index chain_events_by_instance
  on ujira.chain_events (principal_id, project_id, mandate_instance_id, ledger, event_index);

-- The mirror of the contract's role events: who holds which role now, and
-- the events that granted and revoked it.
create table ujira.mandate_instance_roles (
  principal_id uuid not null,
  project_id uuid not null,
  mandate_instance_id uuid not null,
  role text not null
    constraint mandate_instance_roles_role
      check (role in ('agent', 'approver', 'guardian', 'executor', 'recovery')),
  address text not null
    constraint mandate_instance_roles_address_length check (char_length(address) between 1 and 128),
  granted_event_id uuid not null,
  revoked_event_id uuid,
  updated_at timestamptz not null default now(),
  primary key (principal_id, project_id, mandate_instance_id, role, address),
  foreign key (principal_id, project_id, mandate_instance_id)
    references ujira.mandate_instances (principal_id, project_id, id),
  foreign key (principal_id, project_id, granted_event_id)
    references ujira.chain_events (principal_id, project_id, id),
  foreign key (principal_id, project_id, revoked_event_id)
    references ujira.chain_events (principal_id, project_id, id)
);

-- A deposit is money that arrived, so it is permanent, and one finalized
-- event is at most one deposit.
create table ujira.deposits (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_instance_id uuid not null,
  funding_source_id uuid,
  chain_event_id uuid not null,
  amount ujira.amount not null
    constraint deposits_amount_positive check (amount > 0),
  asset text not null,
  chain text not null,
  scale ujira.scale not null,
  from_address text not null
    constraint deposits_from_length check (char_length(from_address) between 1 and 128),
  created_at timestamptz not null default now(),
  constraint deposits_per_event unique (principal_id, project_id, chain_event_id),
  constraint deposits_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id, chain, asset, scale)
    references ujira.mandate_instances (principal_id, project_id, id, chain, asset, scale),
  foreign key (principal_id, project_id, funding_source_id)
    references ujira.funding_sources (principal_id, project_id, id),
  foreign key (principal_id, project_id, chain_event_id)
    references ujira.chain_events (principal_id, project_id, id),
  foreign key (asset, chain, scale)
    references ujira.settlement_tokens (asset, chain, token_scale)
);

create index deposits_by_instance
  on ujira.deposits (principal_id, project_id, mandate_instance_id, created_at);

-- Truncate is a statement level event, so a row trigger alone would not see
-- it, and it is the one way the owner could otherwise empty the table.
create trigger chain_events_append_only before update or delete on ujira.chain_events
  for each row execute function ujira.forbid_mutation();
create trigger chain_events_no_truncate before truncate on ujira.chain_events
  for each statement execute function ujira.forbid_mutation();
create trigger deposits_append_only before update or delete on ujira.deposits
  for each row execute function ujira.forbid_mutation();
create trigger deposits_no_truncate before truncate on ujira.deposits
  for each statement execute function ujira.forbid_mutation();
create trigger mandates_touch before update on ujira.mandates
  for each row execute function ujira.touch();
create trigger mandate_instance_roles_touch before update on ujira.mandate_instance_roles
  for each row execute function ujira.touch();

select ujira.apply_tenant_policies('ujira.mandates');
select ujira.apply_tenant_policies('ujira.mandate_instances');
select ujira.apply_tenant_policies('ujira.funding_sources');
select ujira.apply_tenant_policies('ujira.chain_events');
select ujira.apply_tenant_policies('ujira.mandate_instance_roles');
select ujira.apply_tenant_policies('ujira.deposits');

-- The indexer works under a tenant context like the app, on the tables it
-- mirrors.
create policy indexer_read on ujira.chain_events for select to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_insert on ujira.chain_events for insert to ujira_indexer
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_read on ujira.mandate_instance_roles for select to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_insert on ujira.mandate_instance_roles for insert to ujira_indexer
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_update on ujira.mandate_instance_roles for update to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id())
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_read on ujira.deposits for select to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_insert on ujira.deposits for insert to ujira_indexer
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());

create policy resolve_instance on ujira.mandate_instances for select to ujira_fn_instances
  using (true);

grant select, insert, update on ujira.mandates to ujira_app;
grant select, insert on ujira.mandate_instances to ujira_app;
grant select, insert on ujira.funding_sources to ujira_app;
grant select on ujira.chain_events, ujira.mandate_instance_roles, ujira.deposits to ujira_app;
grant select on
  ujira.mandates,
  ujira.mandate_instances,
  ujira.funding_sources,
  ujira.chain_events,
  ujira.mandate_instance_roles,
  ujira.deposits
  to ujira_reader;
grant select, insert on ujira.chain_events, ujira.deposits to ujira_indexer;
grant select, insert, update on ujira.mandate_instance_roles to ujira_indexer;

grant usage on schema ujira to ujira_fn_instances;
grant select on ujira.mandate_instances to ujira_fn_instances;

-- The tenant and asset of a deployed contract, or no row when the contract
-- is not one of ours. This is how the indexer finds which context to write a
-- chain event under.
create function ujira.resolve_mandate_instance(target_chain text, target_address text)
  returns table (
    principal_id uuid,
    project_id uuid,
    mandate_instance_id uuid,
    asset text,
    scale smallint
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select i.principal_id, i.project_id, i.id, i.asset, i.scale::smallint
    from ujira.mandate_instances as i
   where i.chain = target_chain
     and i.contract_address = target_address
$fn$;

grant execute on function ujira.resolve_mandate_instance(text, text) to ujira_indexer;

grant create on schema ujira to ujira_fn_instances;
alter function ujira.resolve_mandate_instance(text, text) owner to ujira_fn_instances;
revoke create on schema ujira from ujira_fn_instances;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function ujira.resolve_mandate_instance(text, text);
drop table ujira.deposits;
drop table ujira.mandate_instance_roles;
drop table ujira.chain_events;
drop table ujira.funding_sources;
drop table ujira.mandate_instances;
drop table ujira.mandates;
alter table ujira.projects drop column funding_hold_max_seconds;
alter table ujira.projects drop column chain_fallback;
revoke usage on schema ujira from ujira_fn_instances;
revoke ujira_fn_instances from ujira_owner;
