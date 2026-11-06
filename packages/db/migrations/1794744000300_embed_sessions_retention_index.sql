-- expand
-- no-transaction
-- How retention finds sessions past their window.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create index concurrently if not exists embed_sessions_retention
  on ujira.embed_sessions (expires_at);

-- Down Migration
drop index concurrently if exists ujira.embed_sessions_retention;
