-- expand
-- What a payout's read needs that only the payout's own steps know: the caller's
-- task id, the mandate rule that blocked it or allowed it, and when it reached
-- each step of its timeline.
--
-- The rule columns are written by whatever moves the payout, in the same update,
-- and the repository refuses a move that leaves one out. Checks here hold only
-- their values: tying each to its statuses would refuse the code already deployed,
-- which does not write them yet, so that is a later contract migration. The step
-- times are set by a trigger from the status, so no caller can write a time that
-- disagrees with it, and the app has no grant to write them at all.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.payouts
  add column task_id text,
  add column blocked_by text,
  add column allowed_by text,
  add column approved_at timestamptz,
  add column settled_at timestamptz,
  add column delivered_at timestamptz;

-- Checked against rows already there by the next migration, so adding them here
-- takes no scan.
alter table ujira.payouts
  add constraint payouts_task_id_length
    check (char_length(task_id) between 1 and 255) not valid,
  add constraint payouts_blocked_by_format
    check (blocked_by ~ '^[A-Z][A-Z0-9_]{1,63}$') not valid,
  add constraint payouts_allowed_by_value
    check (
      allowed_by in (
        'allowlist_auto',
        'allowlist_approved',
        'attestation_auto',
        'attestation_approved',
        'allowlist_and_attestation_auto',
        'allowlist_and_attestation_approved'
      )
    ) not valid;

-- Every way into settling is from submitting or approved, so settled_at is the
-- moment the mandate executed it. A payout routed again has to be allowed again,
-- so going back to received or routed forgets the last approval.
create function ujira.payout_step_times() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if tg_op = 'INSERT' then
    new.approved_at := null;
    new.settled_at := null;
    new.delivered_at := null;
    return new;
  end if;
  if new.status is not distinct from old.status then
    new.approved_at := old.approved_at;
    new.settled_at := old.settled_at;
    new.delivered_at := old.delivered_at;
    return new;
  end if;
  case new.status
    when 'approved' then
      new.approved_at := now();
    when 'settling' then
      new.approved_at := coalesce(old.approved_at, now());
      new.settled_at := now();
    when 'paid' then
      new.delivered_at := now();
    when 'received', 'routed' then
      new.approved_at := null;
    else
      null;
  end case;
  return new;
end
$fn$;

create trigger payouts_step_times before insert or update on ujira.payouts
  for each row execute function ujira.payout_step_times();

grant update (blocked_by, allowed_by) on ujira.payouts to ujira_app;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop trigger payouts_step_times on ujira.payouts;
drop function ujira.payout_step_times();
alter table ujira.payouts
  drop column delivered_at,
  drop column settled_at,
  drop column approved_at,
  drop column allowed_by,
  drop column blocked_by,
  drop column task_id;

reset role;
