-- expand
-- A leg must use exactly its method's destination, because money sent to the right
-- address with the wrong tag is lost as surely as money sent to the wrong address.
-- And a tag is a Stellar idea at launch, which payout_methods already holds to.
--
-- The checks are added not valid, so they bind new rows at once without scanning the
-- table. A later migration validates them.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create function ujira.legs_match_method() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if not exists (
    select 1
      from ujira.payout_methods as m
     where m.principal_id = new.principal_id
       and m.project_id = new.project_id
       and m.id = new.payout_method_id
       and m.destination_address = new.destination_address
       and m.destination_tag is not distinct from new.destination_tag
  ) then
    raise exception using
      errcode = 'UJ010',
      message = 'a leg must use exactly the destination of its payout method';
  end if;
  return new;
end
$fn$;

-- Named to run after payout_legs_stamp, so a method that is not the recipient's at all
-- is reported as that rather than as a destination that does not match.
create trigger payout_legs_to_method
  before insert or update of payout_method_id, destination_address, destination_tag
  on ujira.payout_legs
  for each row execute function ujira.legs_match_method();

alter table ujira.payout_legs
  add constraint payout_legs_tag_chain check (destination_tag is null or chain = 'stellar') not valid;
alter table ujira.receipt_legs
  add constraint receipt_legs_tag_chain check (destination_tag is null or chain = 'stellar') not valid;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.receipt_legs drop constraint receipt_legs_tag_chain;
alter table ujira.payout_legs drop constraint payout_legs_tag_chain;
drop trigger payout_legs_to_method on ujira.payout_legs;
drop function ujira.legs_match_method();

reset role;
