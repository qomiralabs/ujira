-- expand
-- no-transaction
-- A transfer to a forwarding account cannot say which mandate it is for, so an account
-- funds one mandate instance. The app checks that when it attaches, and this makes it
-- true of anything else that writes here, since deposits are attributed relying on it.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create unique index concurrently if not exists funding_account_sources_one_per_account
  on ujira.funding_account_sources (funding_account_id);

-- Down Migration
drop index concurrently if exists ujira.funding_account_sources_one_per_account;
