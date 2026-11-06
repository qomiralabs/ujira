-- expand
-- Whose an address is depends on the network as well as the chain. An address reads
-- the same on every Stellar network, so a lookup by chain can answer a scan of one
-- network with a record from another, and a testnet deposit could be credited to a
-- mainnet mandate or the other way. Instances record their network now, so both
-- lookups compare it.
--
-- resolve_mandate_instance takes a chain, and the release still running calls it with
-- one, so it stays as it is, and the network form gets its own name. A contract
-- migration drops the chain form once nothing calls it. resolve_funding_address took
-- the network already and only joined its instances by chain, so it changes in place,
-- with the same arguments.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create function ujira.resolve_mandate_address(target_network text, target_address text)
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
   where i.network = target_network
     and i.contract_address = target_address
$fn$;

revoke execute on function ujira.resolve_mandate_address(text, text) from public;
grant execute on function ujira.resolve_mandate_address(text, text) to ujira_indexer;

grant create on schema ujira to ujira_fn_instances;
alter function ujira.resolve_mandate_address(text, text) owner to ujira_fn_instances;
revoke create on schema ujira from ujira_fn_instances;

-- The link table refuses an account on one network funding an instance on another.
-- This does not rest on that: the answer decides where a deposit is swept.
create or replace function ujira.resolve_funding_address(target_network text, target_address text)
  returns table (
    principal_id uuid,
    project_id uuid,
    funding_account_id uuid,
    account_status text,
    funding_source_id uuid,
    mandate_instance_id uuid,
    contract_address text,
    asset text
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select a.principal_id, a.project_id, a.id, a.status,
         attached.funding_source_id, attached.mandate_instance_id,
         attached.contract_address, attached.asset
    from ujira.funding_accounts as a
    left join lateral (
      select s.funding_source_id, s.mandate_instance_id, i.contract_address, i.asset
        from ujira.funding_account_sources as s
        join ujira.mandate_instances as i
          on i.principal_id = s.principal_id
         and i.project_id = s.project_id
         and i.id = s.mandate_instance_id
       where s.principal_id = a.principal_id
         and s.project_id = a.project_id
         and s.funding_account_id = a.id
         and i.network = a.network
    ) as attached on true
   where a.network = target_network
     and a.address = target_address
   order by attached.mandate_instance_id
$fn$;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create or replace function ujira.resolve_funding_address(target_network text, target_address text)
  returns table (
    principal_id uuid,
    project_id uuid,
    funding_account_id uuid,
    account_status text,
    funding_source_id uuid,
    mandate_instance_id uuid,
    contract_address text,
    asset text
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select a.principal_id, a.project_id, a.id, a.status,
         attached.funding_source_id, attached.mandate_instance_id,
         attached.contract_address, attached.asset
    from ujira.funding_accounts as a
    left join lateral (
      select s.funding_source_id, s.mandate_instance_id, i.contract_address, i.asset
        from ujira.funding_account_sources as s
        join ujira.mandate_instances as i
          on i.principal_id = s.principal_id
         and i.project_id = s.project_id
         and i.id = s.mandate_instance_id
       where s.principal_id = a.principal_id
         and s.project_id = a.project_id
         and s.funding_account_id = a.id
         and i.chain = split_part(a.network, ':', 1)
    ) as attached on true
   where a.network = target_network
     and a.address = target_address
   order by attached.mandate_instance_id
$fn$;

drop function ujira.resolve_mandate_address(text, text);

reset role;
