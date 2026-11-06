-- expand
-- no-transaction
-- Erasing a recipient consumes their open sessions, which has to stay fast however
-- many sessions the table holds.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create index concurrently if not exists embed_sessions_open
  on ujira.embed_sessions (principal_id, project_id, recipient_id)
  where consumed_at is null;

-- Down Migration
drop index concurrently if exists ujira.embed_sessions_open;
