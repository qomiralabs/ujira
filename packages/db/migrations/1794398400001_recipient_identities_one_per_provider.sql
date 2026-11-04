-- expand
-- no-transaction
-- One row per provider and provider account for a recipient. Nulls are not
-- distinct: a provider with no per account rows still gets only one.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create unique index concurrently if not exists recipient_identities_one_per_provider
  on ujira.recipient_identities (principal_id, project_id, recipient_id, provider, provider_account)
  nulls not distinct;

-- Down Migration
drop index concurrently if exists ujira.recipient_identities_one_per_provider;
