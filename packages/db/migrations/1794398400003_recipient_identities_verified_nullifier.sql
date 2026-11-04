-- expand
-- no-transaction
-- One verified person per principal, across all of the principal's projects.
-- A rejected duplicate may keep the same value; it verifies nobody.

-- Up Migration
create unique index concurrently if not exists recipient_identities_verified_nullifier
  on ujira.recipient_identities (principal_id, nullifier_hmac)
  where state = 'verified' and nullifier_hmac is not null;

-- Down Migration
drop index concurrently if exists ujira.recipient_identities_verified_nullifier;
