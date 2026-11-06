-- expand
-- The last comparison of each mandate instance's ledger mirror with the contract's
-- state(): when they last agreed and, while they disagree, since when. The contract is
-- the authority, and nothing here corrects money: a disagreement is marked and raised
-- for a person to look at. The indexer's login records each comparison under the
-- instance's own tenant, and finds the instances to compare through one function that
-- names where each lives and nothing more.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ujira.instance_reconciliations (
  principal_id uuid not null,
  project_id uuid not null,
  mandate_instance_id uuid not null,
  -- The ledger the latest comparison read state() at.
  ledger bigint not null
    constraint instance_reconciliations_ledger_positive check (ledger >= 0),
  matches boolean not null,
  checked_at timestamptz not null default now(),
  last_reconciled_at timestamptz,
  diverged_since timestamptz,
  -- A disagreement always has a time it began, and an agreement never does.
  constraint instance_reconciliations_divergence check ((diverged_since is null) = matches),
  primary key (principal_id, project_id, mandate_instance_id),
  foreign key (principal_id, project_id, mandate_instance_id)
    references ujira.mandate_instances (principal_id, project_id, id)
);

select ujira.apply_tenant_policies('ujira.instance_reconciliations');

create policy indexer_read on ujira.instance_reconciliations for select to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_insert on ujira.instance_reconciliations for insert to ujira_indexer
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_update on ujira.instance_reconciliations for update to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id())
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());

grant select on ujira.instance_reconciliations to ujira_app, ujira_reader;
grant select, insert, update on ujira.instance_reconciliations to ujira_indexer;

-- Every instance with a contract to compare, a page at a time in id order. It names
-- the tenant, so each comparison then runs under that tenant's own context. Only
-- active and paused instances: one still deploying has nothing on chain yet.
create function ujira.reconcile_targets(after_id uuid, max_rows integer)
  returns table (
    principal_id uuid,
    project_id uuid,
    mandate_instance_id uuid,
    network text,
    contract_address text
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select i.principal_id, i.project_id, i.id, i.network, i.contract_address
    from ujira.mandate_instances as i
   where i.status in ('active', 'paused')
     and (after_id is null or i.id > after_id)
   order by i.id
   limit least(greatest(max_rows, 1), 1000)
$fn$;

revoke execute on function ujira.reconcile_targets(uuid, integer) from public;
grant execute on function ujira.reconcile_targets(uuid, integer) to ujira_indexer;

grant create on schema ujira to ujira_fn_instances;
alter function ujira.reconcile_targets(uuid, integer) owner to ujira_fn_instances;
revoke create on schema ujira from ujira_fn_instances;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.reconcile_targets(uuid, integer);
drop table ujira.instance_reconciliations;

reset role;
