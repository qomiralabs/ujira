-- expand
-- no-transaction
-- The order a payout list is read in: newest first, the id breaking a tie, so a
-- page boundary always falls between two rows and never inside a timestamp.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create index concurrently if not exists payouts_newest_first
  on ujira.payouts (principal_id, project_id, created_at desc, id desc);

-- Down Migration
drop index concurrently if exists ujira.payouts_newest_first;
