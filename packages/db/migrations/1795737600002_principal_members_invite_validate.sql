-- expand
-- no-transaction
-- Checks existing members against the invitation rule, outside the transaction that
-- added it, so the scan takes only a lock that lets traffic through. It runs after
-- the concurrent build, since a run waiting on the migration lock holds a snapshot
-- that a concurrent build waits for.
--
-- One block because a no-transaction migration sends one statement, and the role
-- and timeouts have to be set inside it.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.principal_members validate constraint principal_members_invite_whole;
end
$validate$;

-- Down Migration
-- A validated check cannot be marked unvalidated again, so it is put back as the
-- first of these migrations left it.
do $unvalidate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.principal_members drop constraint principal_members_invite_whole;
  alter table ujira.principal_members
    add constraint principal_members_invite_whole check (
      (status = 'invited'
        and invite_secret_hash is not null and invite_expires_at is not null and invited_by is not null)
      or (status <> 'invited'
        and invite_secret_hash is null and invite_expires_at is null and invited_by is null)
    ) not valid;
end
$unvalidate$;
