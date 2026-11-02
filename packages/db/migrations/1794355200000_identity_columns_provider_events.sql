-- expand
-- What identity providers tell us, kept as references, statuses and digests
-- only, and the country policy the attester checks. Nothing here holds a
-- document, a proof or a personal value; a provider's result is matched to one
-- row by the indexes in the migrations that follow this one.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- An identity from a provider that is not per chain has no chain, and an erased
-- one keeps no reference. Both are wider than before, so no old writer breaks.
-- squawk-ignore ban-drop-not-null
alter table ujira.recipient_identities alter column chain drop not null;
-- squawk-ignore ban-drop-not-null
alter table ujira.recipient_identities alter column provider_ref drop not null;

alter table ujira.recipient_identities
  add column provider_account text
    constraint recipient_identities_account_length
      check (char_length(provider_account) between 1 and 128),
  add column provider_subject text
    constraint recipient_identities_subject_length
      check (char_length(provider_subject) between 1 and 128),
  add column provider_status text
    constraint recipient_identities_status_length
      check (char_length(provider_status) between 1 and 64),
  add column assurance text not null default 'none'
    constraint recipient_identities_assurance
      check (assurance in ('anchor_kyc', 'document_zk', 'principal_kyc', 'none')),
  add column flow_ref text
    constraint recipient_identities_flow_length check (char_length(flow_ref) between 1 and 200),
  add column nullifier_hmac ujira.hash32,
  add column pending_session_id text
    constraint recipient_identities_session_length
      check (char_length(pending_session_id) between 1 and 128),
  -- The session is handed back until it lapses, so its page and its expiry are
  -- kept with its id. The page carries no personal data.
  add column pending_session_url text
    constraint recipient_identities_session_url_length
      check (char_length(pending_session_url) between 1 and 2048),
  add column pending_session_expires_at timestamptz,
  add column failure_reason text
    constraint recipient_identities_failure_length
      check (char_length(failure_reason) between 1 and 64),
  add column raw_sha256 ujira.hash32,
  add column last_checked_at timestamptz,
  -- When the verification lapses, which eligibility and the attester read.
  add column expires_at timestamptz;

-- Validated by the next migration, on its own, so the swap holds no long lock.
alter table ujira.recipient_identities drop constraint recipient_identities_state;
alter table ujira.recipient_identities
  add constraint recipient_identities_state
    check (state in ('pending', 'verified', 'rejected', 'expired', 'revoked')) not valid;

-- The principal's country list, which the chain only ever sees as a hash. An
-- empty allow list allows nobody, so a mandate that never set one fails closed.
alter table ujira.mandates
  add column country_policy_mode text not null default 'allow'
    constraint mandates_country_policy_mode check (country_policy_mode in ('allow', 'deny')),
  add column country_policy_list text[] not null default '{}'
    constraint mandates_country_policy_list check (
      cardinality(country_policy_list) <= 250
      and array_position(country_policy_list, null) is null
      and array_to_string(country_policy_list, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'
    );

-- The attester's key as the mandate holds it: 32 bytes of ed25519, per the
-- contract spec's ATTESTER_KEY_BYTES. Empty in allowlist mode.
alter table ujira.mandate_instances
  add column attester_public_key bytea
    constraint mandate_instances_attester_key_length check (octet_length(attester_public_key) = 32),
  add column country_policy_hash ujira.hash32;

-- A replayed webhook must change nothing, and it arrives before anyone can know
-- whose it is, so these rows belong to no tenant. They hold the provider's own
-- event key and a digest of the body, which the formats keep to opaque tokens.
create table ops.identity_provider_events (
  provider text not null
    constraint identity_provider_events_provider_format check (provider ~ '^[a-z0-9_]{1,32}$'),
  provider_account text not null
    constraint identity_provider_events_account_format
      check (provider_account ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  event_key text not null
    constraint identity_provider_events_key_format check (event_key ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  raw_sha256 bytea not null
    constraint identity_provider_events_digest_length check (octet_length(raw_sha256) = 32),
  received_at timestamptz not null default now(),
  primary key (provider, provider_account, event_key)
);

create trigger identity_provider_events_append_only
  before update or delete on ops.identity_provider_events
  for each row execute function ujira.forbid_mutation();
create trigger identity_provider_events_no_truncate
  before truncate on ops.identity_provider_events
  for each statement execute function ujira.forbid_mutation();

grant select, insert on ops.identity_provider_events to ujira_ops;

-- True when this delivery is the first with its key.
create function ops.record_identity_provider_event(
  p_provider text,
  p_provider_account text,
  p_event_key text,
  p_raw_sha256 bytea
)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  stored boolean;
begin
  insert into ops.identity_provider_events (provider, provider_account, event_key, raw_sha256)
    values (p_provider, p_provider_account, p_event_key, p_raw_sha256)
    on conflict (provider, provider_account, event_key) do nothing
    returning true into stored;
  return coalesce(stored, false);
end
$fn$;

create function ops.identity_provider_event_seen(
  p_provider text,
  p_provider_account text,
  p_event_key text
)
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select exists (
    select from ops.identity_provider_events as e
     where e.provider = p_provider
       and e.provider_account = p_provider_account
       and e.event_key = p_event_key
  )
$fn$;

grant execute on function
  ops.record_identity_provider_event(text, text, text, bytea),
  ops.identity_provider_event_seen(text, text, text)
  to ujira_app;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ops to ujira_ops;
alter function ops.record_identity_provider_event(text, text, text, bytea) owner to ujira_ops;
alter function ops.identity_provider_event_seen(text, text, text) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ops.identity_provider_event_seen(text, text, text);
drop function ops.record_identity_provider_event(text, text, text, bytea);
drop table ops.identity_provider_events;

alter table ujira.mandate_instances
  drop column country_policy_hash,
  drop column attester_public_key;

alter table ujira.mandates
  drop column country_policy_list,
  drop column country_policy_mode;

alter table ujira.recipient_identities drop constraint recipient_identities_state;
alter table ujira.recipient_identities
  add constraint recipient_identities_state
    check (state in ('pending', 'verified', 'rejected', 'expired'));

alter table ujira.recipient_identities
  drop column expires_at,
  drop column last_checked_at,
  drop column raw_sha256,
  drop column failure_reason,
  drop column pending_session_expires_at,
  drop column pending_session_url,
  drop column pending_session_id,
  drop column nullifier_hmac,
  drop column flow_ref,
  drop column assurance,
  drop column provider_status,
  drop column provider_subject,
  drop column provider_account;

alter table ujira.recipient_identities alter column provider_ref set not null;
alter table ujira.recipient_identities alter column chain set not null;

reset role;
