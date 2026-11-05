-- expand
-- Why a mandate was flagged, raised with the flag so neither can exist without the
-- other. A flagged mandate's events stop being read, so without this operations has
-- no way to know why its mirror went quiet while the principal's funds are still
-- there to withdraw on chain. Rows name a public contract and a reason, and a mandate
-- may have no tenant at all, so this lives in ops with the registry.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ops.mandate_alerts (
  id bigint generated always as identity primary key,
  network text not null,
  contract_id text not null,
  reason text not null
    constraint mandate_alerts_reason check (reason in ('tenant_tag_mismatch', 'public_test_attester')),
  raised_at timestamptz not null default now(),
  -- Reading an event again raises nothing new, and a second reason is still told.
  constraint mandate_alerts_once unique (network, contract_id, reason),
  foreign key (network, contract_id) references ops.mandate_registry (network, contract_id)
);

grant select, insert on ops.mandate_alerts to ujira_ops;

create function ops.flag_mandate(target_network text, contract text, flag_reason text)
  returns boolean
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
  if flagged = 0 then
    return false;
  end if;
  insert into ops.mandate_alerts (network, contract_id, reason)
  values (target_network, contract, flag_reason)
  on conflict on constraint mandate_alerts_once do nothing;
  return true;
end
$fn$;

-- The release before this one still calls the two argument form, and it only ever
-- flagged a tag that differs. It keeps working and can no longer flag without an alert.
create or replace function ops.flag_mandate(target_network text, contract text)
  returns boolean
  language sql
  security definer
  set search_path = pg_catalog
as $fn$
  select ops.flag_mandate(target_network, contract, 'tenant_tag_mismatch')
$fn$;

-- What whatever delivers these reads, oldest first from where it stopped.
create function ops.mandate_alerts_after(after_id bigint, max_rows integer)
  returns table (id bigint, network text, contract_id text, reason text, raised_at timestamptz)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select a.id, a.network, a.contract_id, a.reason, a.raised_at
    from ops.mandate_alerts as a
   where a.id > after_id
   order by a.id
   limit max_rows
$fn$;

revoke execute on function
  ops.flag_mandate(text, text, text),
  ops.mandate_alerts_after(bigint, integer)
  from public;

grant execute on function
  ops.flag_mandate(text, text, text),
  ops.mandate_alerts_after(bigint, integer)
  to ujira_indexer;

grant create on schema ops to ujira_ops;
alter function ops.flag_mandate(text, text, text) owner to ujira_ops;
alter function ops.mandate_alerts_after(bigint, integer) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create or replace function ops.flag_mandate(target_network text, contract text)
  returns boolean
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

reset role;

drop function ops.mandate_alerts_after(bigint, integer);
drop function ops.flag_mandate(text, text, text);
drop table ops.mandate_alerts;
