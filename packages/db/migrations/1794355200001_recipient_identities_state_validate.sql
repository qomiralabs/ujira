-- expand
-- no-transaction
-- Checks existing rows against the wider state list, outside the transaction
-- that swapped it, so the scan does not hold that swap's lock.

-- Up Migration
alter table ujira.recipient_identities validate constraint recipient_identities_state;

-- Down Migration
alter table ujira.recipient_identities validate constraint recipient_identities_state;
