-- contract
-- no-transaction
-- Checks the rows already in ujira.payouts against the checks the expand half
-- added, in a transaction of its own, so the scan takes only a lock that lets
-- traffic through.
--
-- One block because a no-transaction migration sends one statement, and the role
-- and timeouts have to be set inside it.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.payouts validate constraint payouts_task_id_length;
  alter table ujira.payouts validate constraint payouts_blocked_by_format;
  alter table ujira.payouts validate constraint payouts_blocked_by_when;
  alter table ujira.payouts validate constraint payouts_allowed_by_value;
  alter table ujira.payouts validate constraint payouts_allowed_by_when;
end
$validate$;

-- Down Migration
do $unvalidate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.payouts drop constraint payouts_allowed_by_when;
  alter table ujira.payouts drop constraint payouts_allowed_by_value;
  alter table ujira.payouts drop constraint payouts_blocked_by_when;
  alter table ujira.payouts drop constraint payouts_blocked_by_format;
  alter table ujira.payouts drop constraint payouts_task_id_length;
  alter table ujira.payouts
    add constraint payouts_task_id_length
      check (char_length(task_id) between 1 and 255) not valid,
    add constraint payouts_blocked_by_format
      check (blocked_by ~ '^[A-Z][A-Z0-9_]{1,63}$') not valid,
    add constraint payouts_blocked_by_when
      check ((blocked_by is not null) = (status = 'blocked')) not valid,
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
      ) not valid,
    add constraint payouts_allowed_by_when
      check (
        (allowed_by is not null) = (
          status in ('approved', 'settling', 'delivering', 'partly_paid', 'paid', 'needs_attention')
        )
      ) not valid;
end
$unvalidate$;
