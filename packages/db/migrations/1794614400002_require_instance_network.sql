-- contract
-- An instance now has to say which network it is on, so nothing can be written that
-- a funding account or a payout cannot be compared with. The expand half let the code
-- then running make instances with none. That code has gone.
--
-- No environment has been deployed, so there are no older instances to fill in and
-- nothing for this to scan. If that ever stops being true the deploy stops here,
-- rather than guessing what network a row is on.
--
-- An attempt or a hold names a network and an instance, and money on one network
-- cannot reach a mandate on another: an attempt would never land, and a hold would
-- wait for a deposit that can never release it. The tables now refuse a mismatch,
-- whoever writes it. A trigger, because a foreign key would need a unique index on
-- mandate_instances, a live table, and an instance's network does not change. After
-- the row, so a row the keys and checks refuse reports that first.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- squawk-ignore adding-not-nullable-field
alter table ujira.mandate_instances alter column network set not null;

create function ujira.payout_network_matches() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if not exists (
    select 1
      from ujira.mandate_instances as i
     where i.id = new.mandate_instance_id
       and i.network = new.network
  ) then
    raise exception using
      errcode = 'UJ014',
      message = 'the mandate instance is not on the network this names';
  end if;
  return null;
end
$fn$;

create trigger payout_attempts_network after insert or update of network, mandate_instance_id
  on ujira.payout_attempts
  for each row execute function ujira.payout_network_matches();
create trigger payout_funding_holds_network after insert or update of network, mandate_instance_id
  on ujira.payout_funding_holds
  for each row execute function ujira.payout_network_matches();

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop trigger payout_funding_holds_network on ujira.payout_funding_holds;
drop trigger payout_attempts_network on ujira.payout_attempts;
drop function ujira.payout_network_matches();
alter table ujira.mandate_instances alter column network drop not null;

reset role;
