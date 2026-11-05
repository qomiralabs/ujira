-- expand
-- no-transaction
-- One attempt never sends two legs to one destination. Nulls are not distinct, so an
-- untagged and a tagged leg on one address are two destinations, and two untagged legs
-- on it are one.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create unique index concurrently if not exists payout_legs_destination_identity
  on ujira.payout_legs (principal_id, project_id, attempt_id, destination_address, destination_tag)
  nulls not distinct;

-- Down Migration
drop index concurrently if exists ujira.payout_legs_destination_identity;
