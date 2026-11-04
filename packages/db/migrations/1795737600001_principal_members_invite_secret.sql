-- expand
-- no-transaction
-- A secret names one invitation, whichever tenant it belongs to, because the person
-- holding it has not chosen a tenant yet.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create unique index concurrently if not exists principal_members_invite_secret
  on ujira.principal_members (invite_secret_hash)
  where invite_secret_hash is not null;

-- Down Migration
drop index concurrently if exists ujira.principal_members_invite_secret;
