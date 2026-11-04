-- expand
-- no-transaction
-- Checks existing rows against the wider state list, outside the transaction
-- that swapped it, so the scan does not hold that swap's lock.

-- Up Migration
alter table ujira.recipient_identities validate constraint recipient_identities_state;

-- Down Migration
-- A validated check cannot be marked unvalidated again, so it is put back as
-- the previous migration left it.
-- One statement, since this file runs outside a transaction.
alter table ujira.recipient_identities
  drop constraint recipient_identities_state,
  add constraint recipient_identities_state
    check (state in ('pending', 'verified', 'rejected', 'expired', 'revoked')) not valid;
