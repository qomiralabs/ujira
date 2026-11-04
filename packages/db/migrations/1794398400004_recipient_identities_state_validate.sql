-- expand
-- no-transaction
-- Checks existing rows against the wider state list, outside the transaction
-- that swapped it, so the scan does not hold that swap's lock.
--
-- One block because a no-transaction migration sends one statement, and the
-- role and timeouts have to be set inside it.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.recipient_identities validate constraint recipient_identities_state;
end
$validate$;

-- Down Migration
-- A validated check cannot be marked unvalidated again, so it is put back as
-- the first of these migrations left it.
do $unvalidate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.recipient_identities drop constraint recipient_identities_state;
  alter table ujira.recipient_identities
    add constraint recipient_identities_state
      check (state in ('pending', 'verified', 'rejected', 'expired', 'revoked')) not valid;
end
$unvalidate$;
