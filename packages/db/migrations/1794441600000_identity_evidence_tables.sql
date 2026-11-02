-- expand
-- Permanent evidence for every destination and every attestation, so any binding
-- can be traced back to what proved it. Challenges are single use, verifications
-- are append only, and an attestation only ever moves once, from pending to
-- signed or failed. Also the mail quota counter, which holds counts only.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- A short lived grant for the widget, for one recipient. Only the hash of its
-- token is kept. It comes first because a wallet session verification names one.
create table ujira.embed_sessions (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  token_hash ujira.hash32 not null,
  token_prefix text not null
    constraint embed_sessions_prefix_format check (token_prefix ~ '^ujes_(live|test)_[A-Za-z0-9]{8}$'),
  recipient_id uuid not null,
  purpose text not null
    constraint embed_sessions_purpose check (purpose in ('onboarding', 'method_change', 'identity')),
  allowed_origins text[] not null
    constraint embed_sessions_origins_count check (cardinality(allowed_origins) between 1 and 10),
  -- Null for an invite link, which no API token made.
  created_by_token uuid,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint embed_sessions_token_key unique (token_hash),
  constraint embed_sessions_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, recipient_id)
    references ujira.recipients (principal_id, project_id, id),
  foreign key (principal_id, project_id, created_by_token)
    references ujira.api_tokens (principal_id, project_id, id)
);

-- One challenge a wallet is asked to sign. The nonce and the text are kept as
-- hashes only, so the table cannot be read to answer an open challenge. Rows are
-- kept for 30 days after they expire.
create table ujira.wallet_proof_challenges (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  -- Null for a challenge that is not about a payout method, such as a member's
  -- own wallet.
  method_id uuid,
  purpose text not null
    constraint wallet_proof_challenges_purpose
      check (purpose in ('payout_destination', 'member_wallet', 'agent_link')),
  network text not null
    constraint wallet_proof_challenges_network_format check (network ~ '^[a-z0-9]{1,16}:[-a-z0-9_]{1,32}$'),
  address text not null
    constraint wallet_proof_challenges_address_length check (char_length(address) between 1 and 128),
  has_tag boolean not null default false,
  tag ujira.u64,
  recipient_ref ujira.hash32 not null,
  request_id uuid not null,
  nonce_hash ujira.hash32 not null,
  message_hash ujira.hash32 not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint wallet_proof_challenges_tag_canonical check (has_tag = (tag is not null)),
  constraint wallet_proof_challenges_expiry_after_issue check (expires_at > issued_at),
  constraint wallet_proof_challenges_nonce_key unique (nonce_hash),
  constraint wallet_proof_challenges_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, method_id)
    references ujira.payout_methods (principal_id, project_id, id)
);

-- Append only: the latest row for a method is its current evidence.
create table ujira.destination_verifications (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  method_id uuid not null,
  level text not null
    constraint destination_verifications_level check (
      level in (
        'wallet_signature',
        'wallet_session',
        'partner_confirmed',
        'forwarder_derived',
        'principal_asserted'
      )
    ),
  chain text not null references ujira.chains (code),
  destination_address text not null
    constraint destination_verifications_address_length
      check (char_length(destination_address) between 1 and 128),
  has_tag boolean not null default false,
  destination_tag ujira.u64,
  -- Only the scheme built at launch can be stored.
  scheme text
    constraint destination_verifications_scheme check (scheme = 'sep53'),
  challenge_id uuid,
  signature text
    constraint destination_verifications_signature_length check (octet_length(signature) <= 2048),
  signer_key text
    constraint destination_verifications_signer_format check (signer_key ~ '^G[A-Z2-7]{55}$'),
  partner_ref text
    constraint destination_verifications_partner_length check (char_length(partner_ref) between 1 and 128),
  embed_session_id uuid,
  -- The wallet verification a forwarder was built on.
  derived_from uuid,
  -- The clock rather than the transaction time, so two rows written in one
  -- transaction still have an order.
  recorded_at timestamptz not null default clock_timestamp(),
  constraint destination_verifications_tag_canonical check (has_tag = (destination_tag is not null)),
  constraint destination_verifications_signer_is_sep53
    check ((scheme is not distinct from 'sep53') = (signer_key is not null)),
  constraint destination_verifications_partner_needs_ref
    check (level <> 'partner_confirmed' or partner_ref is not null),
  constraint destination_verifications_session_is_wallet_session
    check ((level = 'wallet_session') = (embed_session_id is not null)),
  constraint destination_verifications_derived_is_forwarder
    check (derived_from is null or level = 'forwarder_derived'),
  constraint destination_verifications_one_per_challenge unique (challenge_id),
  constraint destination_verifications_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, method_id)
    references ujira.payout_methods (principal_id, project_id, id),
  foreign key (principal_id, project_id, challenge_id)
    references ujira.wallet_proof_challenges (principal_id, project_id, id),
  foreign key (principal_id, project_id, embed_session_id)
    references ujira.embed_sessions (principal_id, project_id, id),
  foreign key (principal_id, project_id, derived_from)
    references ujira.destination_verifications (principal_id, project_id, id)
);

create index destination_verifications_latest
  on ujira.destination_verifications (principal_id, project_id, method_id, recorded_at desc);

-- A wallet session can vouch for a method only once.
create unique index destination_verifications_one_session
  on ujira.destination_verifications (principal_id, project_id, method_id)
  where level = 'wallet_session';

create trigger destination_verifications_append_only
  before update or delete on ujira.destination_verifications
  for each row execute function ujira.forbid_mutation();
create trigger destination_verifications_no_truncate
  before truncate on ujira.destination_verifications
  for each statement execute function ujira.forbid_mutation();

-- Everything the attester signed or was about to. The row is committed as
-- pending before the signer is asked, and the signer refuses a digest that is
-- not pending here, so both sides must agree before a signature exists.
create table ujira.attestations (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_instance_id uuid not null,
  -- The payout tables do not exist yet. Their foreign keys come with them.
  attempt_id uuid not null,
  leg_index smallint not null
    constraint attestations_leg_index_range check (leg_index between 0 and 255),
  recipient_id uuid not null,
  method_id uuid not null,
  destination_address text not null
    constraint attestations_address_length check (char_length(destination_address) between 1 and 128),
  has_tag boolean not null default false,
  destination_tag ujira.u64,
  country_policy_hash ujira.hash32 not null,
  policy_epoch ujira.u64 not null,
  valid_until timestamptz not null,
  attester_key_id text not null
    constraint attestations_key_id_length check (char_length(attester_key_id) between 1 and 128),
  digest ujira.hash32 not null,
  status text not null default 'pending'
    constraint attestations_status check (status in ('pending', 'signed', 'failed')),
  signature bytea
    constraint attestations_signature_length check (octet_length(signature) = 64),
  -- An error code, never a message.
  failure_code text
    constraint attestations_failure_format check (failure_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz not null default now(),
  constraint attestations_tag_canonical check (has_tag = (destination_tag is not null)),
  constraint attestations_signed_has_signature check ((status = 'signed') = (signature is not null)),
  constraint attestations_failed_has_code check ((status = 'failed') = (failure_code is not null)),
  -- Global, because the signer asks by digest alone, and the digest covers the
  -- mandate, so two tenants cannot honestly share one.
  constraint attestations_digest_key unique (digest, attester_key_id),
  constraint attestations_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id)
    references ujira.mandate_instances (principal_id, project_id, id),
  foreign key (principal_id, project_id, recipient_id)
    references ujira.recipients (principal_id, project_id, id),
  foreign key (principal_id, project_id, method_id)
    references ujira.payout_methods (principal_id, project_id, id)
);

create index attestations_by_attempt
  on ujira.attestations (principal_id, project_id, attempt_id, leg_index);

create function ujira.attestation_status_only() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if old.status <> 'pending' or new.status not in ('signed', 'failed') then
    raise exception using
      errcode = 'UJ020',
      message = 'an attestation only moves from pending to signed or failed';
  end if;
  if to_jsonb(new) - 'status' - 'signature' - 'failure_code'
       is distinct from to_jsonb(old) - 'status' - 'signature' - 'failure_code' then
    raise exception using
      errcode = 'UJ020',
      message = 'only the status of an attestation can change';
  end if;
  return new;
end
$fn$;

create trigger attestation_status_only before update on ujira.attestations
  for each row execute function ujira.attestation_status_only();
create trigger attestations_no_delete before delete on ujira.attestations
  for each row execute function ujira.forbid_mutation();
create trigger attestations_no_truncate before truncate on ujira.attestations
  for each statement execute function ujira.forbid_mutation();

-- A wallet's link to an agent identity in an on chain registry.
create table ujira.agent_identity_links (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  network text not null
    constraint agent_identity_links_network_format check (network ~ '^[a-z0-9]{1,16}:[-a-z0-9_]{1,32}$'),
  address text not null
    constraint agent_identity_links_address_length check (char_length(address) between 1 and 128),
  registry text not null
    constraint agent_identity_links_registry_length check (char_length(registry) between 1 and 128),
  -- Numeric, because a token id runs to 2^256 - 1.
  token_id numeric not null
    constraint agent_identity_links_token_range check (
      token_id between 0
        and 115792089237316195423570985008687907853269984665640564039457584007913129639935
      and scale(token_id) = 0
    ),
  status text not null default 'pending'
    constraint agent_identity_links_status check (status in ('pending', 'active', 'revoked')),
  human_backed_until timestamptz,
  display_name text
    constraint agent_identity_links_display_length check (char_length(display_name) between 1 and 200),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_identity_links_per_wallet unique (principal_id, project_id, network, address, registry),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

create trigger agent_identity_links_touch before update on ujira.agent_identity_links
  for each row execute function ujira.touch();

select ujira.apply_tenant_policies('ujira.embed_sessions');
select ujira.apply_tenant_policies('ujira.wallet_proof_challenges');
select ujira.apply_tenant_policies('ujira.destination_verifications');
select ujira.apply_tenant_policies('ujira.attestations');
select ujira.apply_tenant_policies('ujira.agent_identity_links');

grant select, insert, update on
  ujira.embed_sessions,
  ujira.wallet_proof_challenges,
  ujira.attestations,
  ujira.agent_identity_links
  to ujira_app;
grant select, insert on ujira.destination_verifications to ujira_app;
-- The reader serves dashboards, which have no use for hashes of live tokens.
grant select on
  ujira.destination_verifications,
  ujira.attestations,
  ujira.agent_identity_links
  to ujira_reader;

-- The signer's question now reads the real log. It runs as its own narrow role,
-- which sees only what the answer needs.
grant select (principal_id, project_id, id, digest, status) on ujira.attestations
  to ujira_signer_read;
create policy signer_pending on ujira.attestations for select to ujira_signer_read
  using (true);

create or replace function ujira.attestation_pending(p_digest bytea)
  returns table (principal_id uuid, project_id uuid, attestation_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select a.principal_id, a.project_id, a.id
    from ujira.attestations as a
   where a.digest = p_digest
     and a.status = 'pending'
$fn$;

-- How much mail an account has sent today, by kind. Counts only: no address and
-- no tenant, so this is safe to keep beside the other operations tables.
create table ops.email_quota_usage (
  provider_account text not null
    constraint email_quota_usage_account_format check (provider_account ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  day date not null,
  kind text not null
    constraint email_quota_usage_kind check (kind in ('code', 'other')),
  sent integer not null default 0
    constraint email_quota_usage_sent_range check (sent >= 0),
  refused integer not null default 0
    constraint email_quota_usage_refused_range check (refused >= 0),
  exhausted boolean not null default false,
  primary key (provider_account, day, kind)
);

grant select, insert, update on ops.email_quota_usage to ujira_ops;

-- Takes one send from today's quota, or refuses and counts the refusal. Login
-- codes may use the whole cap; other mail stops at the cap minus the reserve, so
-- a newsletter can never lock anyone out. One lock per account and UTC day makes
-- the count exact however many callers arrive together.
create function ops.email_quota_take(
  p_provider_account text,
  p_kind text,
  p_cap integer,
  p_code_reserve integer
)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  today constant date := (clock_timestamp() at time zone 'UTC')::date;
  used integer;
  allowed integer;
  taken boolean;
begin
  if p_cap is null or p_cap < 0 or p_code_reserve is null
     or p_code_reserve < 0 or p_code_reserve > p_cap then
    raise exception using
      errcode = '22023',
      message = 'a cap and a reserve must be counts, and the reserve fit inside the cap';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_provider_account || '/' || today::text, 0));
  select coalesce(sum(u.sent), 0)::integer into used
    from ops.email_quota_usage as u
   where u.provider_account = p_provider_account and u.day = today;
  allowed := case when p_kind = 'code' then p_cap else p_cap - p_code_reserve end;
  taken := used < allowed;
  insert into ops.email_quota_usage as u (provider_account, day, kind, sent, refused, exhausted)
    values (
      p_provider_account,
      today,
      p_kind,
      case when taken then 1 else 0 end,
      case when taken then 0 else 1 end,
      not taken
    )
    on conflict (provider_account, day, kind) do update
      set sent = u.sent + excluded.sent,
          refused = u.refused + excluded.refused,
          exhausted = u.exhausted or excluded.exhausted;
  return taken;
end
$fn$;

grant execute on function ops.email_quota_take(text, text, integer, integer) to ujira_app;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ops to ujira_ops;
alter function ops.email_quota_take(text, text, integer, integer) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ops.email_quota_take(text, text, integer, integer);
drop table ops.email_quota_usage;

create or replace function ujira.attestation_pending(p_digest bytea)
  returns table (principal_id uuid, project_id uuid, attestation_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select null::uuid, null::uuid, null::uuid where false and p_digest is not null
$fn$;

drop table ujira.agent_identity_links;
drop table ujira.attestations;
drop function ujira.attestation_status_only();
drop table ujira.destination_verifications;
drop table ujira.wallet_proof_challenges;
drop table ujira.embed_sessions;

reset role;
