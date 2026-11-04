-- expand
-- no-transaction
-- A provider's reference names exactly one row, whichever tenant holds it, or a
-- result could be applied to the wrong recipient. This one key has to be global:
-- the reference comes from the provider, before any tenant is known.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create unique index concurrently if not exists recipient_identities_provider_ref
  on ujira.recipient_identities (provider, provider_account, provider_ref)
  nulls not distinct
  where provider_ref is not null;

-- Down Migration
drop index concurrently if exists ujira.recipient_identities_provider_ref;
