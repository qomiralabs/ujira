-- expand
-- A payout's legs can change once, before anything is requested: when a rail goes down
-- under a split, the same attempt goes to the recipient's main method instead. Legs are
-- never deleted, so the old ones are cancelled and the new one follows them. A cancelled
-- leg pays nothing, so it no longer counts towards the attempt's total or the four legs
-- it may have, and the row numbers can run past what the chain can carry. What the chain
-- sees is the live legs, in order, numbered from zero.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create or replace function ujira.legs_match_attempt() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
declare
  target uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
  expected numeric;
  actual numeric;
  live bigint;
begin
  select a.total_amount into expected
    from ujira.payout_attempts as a
   where a.principal_id = new.principal_id
     and a.project_id = new.project_id
     and a.id = target;
  select coalesce(sum(l.amount), 0), count(*) into actual, live
    from ujira.payout_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.attempt_id = target
     and l.status <> 'cancelled';
  if live > 4 then
    raise exception using
      errcode = '23514',
      message = 'an attempt has at most four live legs';
  end if;
  if actual is distinct from expected then
    raise exception using
      errcode = 'UJ005',
      message = format('the legs of an attempt sum to %s and its total is %s', actual, expected);
  end if;
  return null;
end
$fn$;

-- A wider check takes the place of the one dropped, in the same statement, so there is no
-- moment with neither.
alter table ujira.payout_legs
  -- squawk-ignore ban-drop-constraint
  drop constraint payout_legs_index_range,
  add constraint payout_legs_index_range check (leg_index between 0 and 7) not valid;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.payout_legs
  drop constraint payout_legs_index_range,
  add constraint payout_legs_index_range check (leg_index between 0 and 3);

create or replace function ujira.legs_match_attempt() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
declare
  target uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
  expected numeric;
  actual numeric;
begin
  select a.total_amount into expected
    from ujira.payout_attempts as a
   where a.principal_id = new.principal_id
     and a.project_id = new.project_id
     and a.id = target;
  select coalesce(sum(l.amount), 0) into actual
    from ujira.payout_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.attempt_id = target;
  if actual is distinct from expected then
    raise exception using
      errcode = 'UJ005',
      message = format('the legs of an attempt sum to %s and its total is %s', actual, expected);
  end if;
  return null;
end
$fn$;

reset role;
