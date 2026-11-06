-- expand
-- no-transaction
-- Removing a session checks that no verification names it, which would otherwise scan
-- a table that only ever grows.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create index concurrently if not exists destination_verifications_embed_session
  on ujira.destination_verifications (principal_id, project_id, embed_session_id)
  where embed_session_id is not null;

-- Down Migration
drop index concurrently if exists ujira.destination_verifications_embed_session;
