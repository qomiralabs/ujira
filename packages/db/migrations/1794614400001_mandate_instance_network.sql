-- expand
-- An address looks the same on every network, so nothing about a testnet account
-- shown for a pubnet mandate looks wrong, and an exchange would send real money to
-- it. A funding account records its network and an instance recorded only its
-- chain, so the two could not be compared. Instances now say which network they
-- are on, and a funding account can fund an instance only on its own.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.mandate_instances
  add column network ujira.network_id;

-- Not valid, and on purpose never backfilled: the chain does not say which network
-- an existing instance is on, and a guess is the mistake this column prevents. New
-- rows must name it. An old row stays null, which reads as unknown and can be
-- funded by nothing until a person fills it in as the owner, after which this can
-- be validated.
alter table ujira.mandate_instances
  add constraint mandate_instances_network_on_chain
    check (network is not null and split_part(network, ':', 1) = chain) not valid;

-- A foreign key could say this only with a unique index on mandate_instances, a
-- live table, and an instance's network never changes once it has one, so this
-- check cannot go stale. After the row, so a row the keys refuse reports that.
create function ujira.check_funding_account_source() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if not exists (
    select 1
      from ujira.funding_accounts as a
      join ujira.mandate_instances as i on i.id = new.mandate_instance_id
     where a.id = new.funding_account_id
       and a.network = i.network
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
