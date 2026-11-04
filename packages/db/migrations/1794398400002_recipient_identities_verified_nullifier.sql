-- expand
-- no-transaction
-- One verified person per principal, across all of the principal's projects.
-- A rejected duplicate may keep the same value; it verifies nobody.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create unique index concurrently if not exists recipient_identities_verified_nullifier
  on ujira.recipient_identities (principal_id, nullifier_hmac)
  where state = 'verified' and nullifier_hmac is not null;

-- Down Migration
drop index concurrently if exists ujira.recipient_identities_verified_nullifier;
