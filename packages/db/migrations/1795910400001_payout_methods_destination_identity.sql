-- expand
-- no-transaction
-- At most one active method per destination within a principal. Nulls are not
-- distinct: otherwise two untagged methods could share one address, since plain
-- uniqueness treats every missing tag as different.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create unique index concurrently if not exists payout_methods_destination_identity
  on ujira.payout_methods (principal_id, chain, destination_address, destination_tag)
  nulls not distinct
  where status = 'active';

-- Down Migration
drop index concurrently if exists ujira.payout_methods_destination_identity;
