-- expand
-- Whose a forwarding account is, for the indexer. A deposit arrives before anyone
-- knows which tenant it belongs to, so the scan has no tenant to read these tables
-- under, and giving its login the tables would let it read every tenant's accounts.
-- This answers one exact address at a time instead. It cannot list anything, and the
-- address it takes is public on the chain, so it tells the caller nothing it could
-- not ask about a contract already.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create policy resolve_funding_address on ujira.funding_accounts for select to ujira_fn_instances
  using (true);
create policy resolve_funding_address on ujira.funding_account_sources for select to ujira_fn_instances
  using (true);

grant select on ujira.funding_accounts, ujira.funding_account_sources to ujira_fn_instances;

-- One row per mandate instance the account funds, or one row with no instance when
-- it funds none, or no row when the address is no account of ours. An instance on
-- another chain is left out, so it can never be swept to from here.
create function ujira.resolve_funding_address(target_network text, target_address text)
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

revoke execute on function ujira.resolve_funding_address(text, text) from public;
grant execute on function ujira.resolve_funding_address(text, text) to ujira_indexer;

grant create on schema ujira to ujira_fn_instances;
alter function ujira.resolve_funding_address(text, text) owner to ujira_fn_instances;
revoke create on schema ujira from ujira_fn_instances;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.resolve_funding_address(text, text);
revoke select on ujira.funding_accounts, ujira.funding_account_sources from ujira_fn_instances;
drop policy resolve_funding_address on ujira.funding_account_sources;
drop policy resolve_funding_address on ujira.funding_accounts;

reset role;
