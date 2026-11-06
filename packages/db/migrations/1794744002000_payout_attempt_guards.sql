-- expand
-- Two rules that protect money, held here so that no code path can skip them. An
-- attempt is what moves money, so none may start on a payout that has finished, and
-- none may commit without legs, because it would hold the payout's one live slot
-- with nothing to pay.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- The share lock is what makes this a rule and not a hope. A move to a terminal
-- status that has not committed yet makes this wait, and then read what it became.
-- Without the lock it would read the old status and let the attempt through.
create function ujira.payout_attempt_needs_open_payout() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
declare
  payout_status text;
begin
  select p.status into payout_status
    from ujira.payouts as p
   where p.principal_id = new.principal_id
     and p.project_id = new.project_id
     and p.id = new.payout_id
   for share;
  if payout_status in ('paid', 'blocked', 'rejected', 'cancelled', 'failed') then
    raise exception using
      errcode = 'UJ017',
      message = format('a %s payout cannot take a new attempt', payout_status);
  end if;
  return new;
end
$fn$;

create trigger payout_attempts_open_payout before insert on ujira.payout_attempts
  for each row execute function ujira.payout_attempt_needs_open_payout();

-- legs_match_attempt finds no legs, so their sum of zero is not the total.
create constraint trigger payout_attempts_have_legs after insert on ujira.payout_attempts
  deferrable initially deferred
  for each row execute function ujira.legs_match_attempt('id');

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop trigger payout_attempts_have_legs on ujira.payout_attempts;
drop trigger payout_attempts_open_payout on ujira.payout_attempts;
drop function ujira.payout_attempt_needs_open_payout();

reset role;
