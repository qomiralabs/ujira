-- expand
-- Recipients and how they are paid. Personal data lives in one table only,
-- recipient_pii, as ciphertext, so every other table can be kept for the
-- financial record period without holding any. pii-columns.test.ts fails if a
-- column that reads like personal data appears anywhere else.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- A destination tag is an unsigned 64 bit integer on chain. Numeric rather than
-- bigint, because bigint stops at 2^63 - 1.
-- squawk-ignore-file ban-create-domain-with-constraint
create domain ujira.u64 as numeric
  constraint u64_range check (
    value between 0 and 18446744073709551615 and scale(value) = 0
  );

grant usage on domain ujira.u64 to ujira_app, ujira_reader;

-- recipient_ref is a salted hash the caller makes, so a recipient can be
-- recognized again without this table holding who they are. The country is kept
-- in plain text, because routing needs it, and is protected at rest by the
-- database's own encryption only.
create table ujira.recipients (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  recipient_ref ujira.hash32 not null,
  country text not null
    constraint recipients_country_format check (country ~ '^[A-Z]{2}$'),
  status text not null default 'active'
    constraint recipients_status check (status in ('active', 'suspended', 'erased')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recipients_ref_key unique (principal_id, project_id, recipient_ref),
  constraint recipients_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

-- The only home of personal data, and it holds ciphertext only. Erasure deletes
-- the row and shreds the key, so nothing else has to change.
create table ujira.recipient_pii (
  principal_id uuid not null,
  project_id uuid not null,
  recipient_id uuid not null,
  ciphertext bytea not null,
  nonce bytea not null
    constraint recipient_pii_nonce_length check (octet_length(nonce) = 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (principal_id, project_id, recipient_id),
  foreign key (principal_id, project_id, recipient_id)
    references ujira.recipients (principal_id, project_id, id)
);

-- Onboarding state per chain. The provider is the system of record: this is a
-- copy of what it last said, under its own opaque reference.
create table ujira.recipient_identities (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null,
  chain text not null references ujira.chains (code),
  provider text not null
    constraint recipient_identities_provider_length check (char_length(provider) between 1 and 64),
  provider_ref text not null
    constraint recipient_identities_ref_length check (char_length(provider_ref) between 1 and 128),
  state text not null
    constraint recipient_identities_state
      check (state in ('pending', 'verified', 'rejected', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recipient_identities_per_chain
    unique (principal_id, project_id, recipient_id, chain, provider),
  foreign key (principal_id, project_id, recipient_id)
    references ujira.recipients (principal_id, project_id, id)
);

-- Where a recipient is paid. A destination is an address and an optional tag;
-- has_tag says which, so a tag cannot appear or vanish without the flag saying
-- so. Details such as a bank account are encrypted, under the recipient's key.
create table ujira.payout_methods (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null,
  method text not null
    constraint payout_methods_method
      check (method in ('stellar_wallet', 'bank', 'mobile_money', 'cash_pickup')),
  rail text not null
    constraint payout_methods_rail check (rail in ('wallet', 'anchor')),
  chain text not null references ujira.chains (code),
  destination_address text not null
    constraint payout_methods_address_length check (char_length(destination_address) between 1 and 128),
  has_tag boolean not null default false,
  destination_tag ujira.u64,
  details_ciphertext bytea,
  details_nonce bytea
    constraint payout_methods_nonce_length check (octet_length(details_nonce) = 12),
  status text not null default 'active'
    constraint payout_methods_status check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_methods_tag_canonical check (has_tag = (destination_tag is not null)),
  -- A tag exists only on Stellar at launch.
  constraint payout_methods_tag_chain check (not has_tag or chain = 'stellar'),
  constraint payout_methods_details_whole
    check ((details_ciphertext is null) = (details_nonce is null)),
  constraint payout_methods_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, recipient_id)
    references ujira.recipients (principal_id, project_id, id)
);

create index payout_methods_by_recipient
  on ujira.payout_methods (principal_id, project_id, recipient_id);

create trigger recipients_touch before update on ujira.recipients
  for each row execute function ujira.touch();
create trigger recipient_pii_touch before update on ujira.recipient_pii
  for each row execute function ujira.touch();
create trigger recipient_identities_touch before update on ujira.recipient_identities
  for each row execute function ujira.touch();
create trigger payout_methods_touch before update on ujira.payout_methods
  for each row execute function ujira.touch();

select ujira.apply_tenant_policies('ujira.recipients');
select ujira.apply_tenant_policies('ujira.recipient_pii');
select ujira.apply_tenant_policies('ujira.recipient_identities');
select ujira.apply_tenant_policies('ujira.payout_methods');

grant select, insert, update on
  ujira.recipients,
  ujira.recipient_pii,
  ujira.recipient_identities,
  ujira.payout_methods
  to ujira_app;
-- The reader serves dashboards, which have no use for the ciphertext.
grant select on ujira.recipients, ujira.recipient_identities, ujira.payout_methods to ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop table ujira.payout_methods;
drop table ujira.recipient_identities;
drop table ujira.recipient_pii;
drop table ujira.recipients;
drop domain ujira.u64;
