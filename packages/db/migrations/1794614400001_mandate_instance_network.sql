-- expand
-- An address looks the same on every network, so nothing about a testnet account
-- shown for a pubnet mandate looks wrong, and an exchange would send real money to
-- it. A funding account records its network and an instance recorded only its
-- chain, so the two could not be compared. Instances now say which network they
-- are on, and a funding account on one network cannot fund an instance on another.
--
-- This is the expand half. The new schema goes out before the new code, and the code
-- already running makes instances with no network and attaches accounts to them, so
-- an instance with none has to stay allowed here. The repository requires a network
-- and refuses to fund an instance without one. Refusing both in the table is a
-- contract that follows, once the code running always names it.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.mandate_instances
  add column network ujira.network_id;

-- On purpose never backfilled: the chain does not say which network an existing
-- instance is on, and a guess is the mistake this column prevents. An old row stays
-- null, which the repository reads as unknown, until a person fills it in as the
-- owner.
alter table ujira.mandate_instances
  add constraint mandate_instances_network_on_chain
    check (network is null or split_part(network, ':', 1) = chain) not valid;

-- A foreign key could say this only with a unique index on mandate_instances, a
-- live table, and an instance's network never changes once it has one, so this
-- check cannot go stale. After the row, so a row the keys refuse reports that.
create function ujira.check_funding_account_source() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if exists (
    select 1
      from ujira.funding_accounts as a
      join ujira.mandate_instances as i on i.id = new.mandate_instance_id
     where a.id = new.funding_account_id
       and a.network <> i.network
  ) then
    raise exception using
      errcode = '23514',
      message = 'a funding account funds a mandate instance on its own network only';
  end if;
  if not exists (
    select 1
      from ujira.funding_sources as s
     where s.id = new.funding_source_id
       and s.mandate_instance_id = new.mandate_instance_id
       and s.kind = 'stellar_funding_account'
  ) then
    raise exception using
      errcode = '23514',
      message = 'a funding account uses a funding source of its kind on the same instance';
  end if;
  return null;
end
$fn$;

create trigger funding_account_sources_check_new after insert on ujira.funding_account_sources
  for each row execute function ujira.check_funding_account_source();

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop trigger funding_account_sources_check_new on ujira.funding_account_sources;
drop function ujira.check_funding_account_source();
alter table ujira.mandate_instances drop constraint mandate_instances_network_on_chain;
alter table ujira.mandate_instances drop column network;

reset role;
