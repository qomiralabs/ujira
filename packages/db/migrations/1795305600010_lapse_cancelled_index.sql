-- expand
-- no-transaction
-- Few attempts ever lapse and each is cleared soon after, so the sweep's scan should cost
-- what is left to clear rather than every attempt there has been.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds no lock
-- that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create index concurrently if not exists payout_attempts_lapse_uncancelled
  on ujira.payout_attempts (mandate_instance_id)
  where status = 'dead' and lapse_cancelled_at is null and dead_proof ->> 'kind' = 'payout_lapsed';

-- Down Migration
drop index concurrently if exists ujira.payout_attempts_lapse_uncancelled;
