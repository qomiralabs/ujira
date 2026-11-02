-- expand
-- The database never holds key material, only references and addresses.
--
-- ujira.managed_signers is the agent keys UJIRA holds for principals who opted
-- in, which is tenant data, with the member who consented named on each row.
-- ops.signing_keys is the infrastructure keys: the source of truth a signer
-- service checks each key it serves against at startup. It holds nothing about
-- a tenant, so it lives under the ops exception, and the app reaches it only
-- through a narrow function.
--
-- Both are kept for the financial record period, because receipts reference
-- signing addresses. Nothing here grants a delete, and a retired key stays.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

insert into ujira.status_transitions (machine, from_status, to_status) values
  ('managed_signer', 'active', 'retiring'),
  ('managed_signer', 'retiring', 'retired'),
  -- A key thought to be exposed is retired at once.
  ('managed_signer', 'active', 'retired');

create table ujira.managed_signers (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  network text not null
    constraint managed_signers_network_format check (network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'),
  agent_id uuid not null,
  -- The key manager's name for the key, never the key. Shaped like a name, so a
  -- URL or a Stellar secret seed pasted here by mistake is refused.
  key_ref text not null
    constraint managed_signers_key_ref_format check (
      key_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$'
      and key_ref !~ '//'
      and key_ref !~ '^S[A-Z2-7]{55}$'
    ),
  -- The account the key controls.
  address text not null
    constraint managed_signers_address_format check (address ~ '^[A-Za-z0-9]{1,128}$'),
  status text not null default 'active'
    constraint managed_signers_status check (status in ('active', 'retiring', 'retired')),
  -- The member who agreed to UJIRA holding this key.
  consented_by_member_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint managed_signers_tenant_key unique (principal_id, project_id, id),
  -- An account belongs to one key, whichever tenant holds it.
  constraint managed_signers_address_key unique (network, address),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id),
  foreign key (principal_id, consented_by_member_id)
    references ujira.principal_members (principal_id, user_id)
);

-- One active key per agent and network. A retiring key may sit beside its
-- replacement while work signed with it finishes.
create unique index managed_signers_one_active
  on ujira.managed_signers (principal_id, project_id, agent_id, network)
  where status = 'active';

-- What a row names never changes, only how far along its life it is. A new key
-- is a new row, so a receipt's signing address always reads back as it was.
create function ujira.keep_managed_signer() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if new.principal_id <> old.principal_id or new.project_id <> old.project_id
     or new.network <> old.network or new.agent_id <> old.agent_id
     or new.key_ref <> old.key_ref or new.address <> old.address
     or new.consented_by_member_id <> old.consented_by_member_id then
    raise exception using
      errcode = 'UJ006',
      message = 'a managed signer keeps its tenant, agent, key, address and consent';
  end if;
  return new;
end
$fn$;

create trigger managed_signers_keep before update on ujira.managed_signers
  for each row execute function ujira.keep_managed_signer();
create trigger managed_signers_transition before update on ujira.managed_signers
  for each row execute function ujira.check_transition('managed_signer');
create trigger managed_signers_touch before update on ujira.managed_signers
  for each row execute function ujira.touch();

select ujira.apply_tenant_policies('ujira.managed_signers');
grant select, insert, update on ujira.managed_signers to ujira_app;
grant select on ujira.managed_signers to ujira_reader;

create table ops.signing_keys (
  id bigint generated always as identity primary key,
  purpose text not null
    constraint signing_keys_purpose check (
      purpose in ('executor', 'fee_sponsor', 'sep10', 'attester', 'pii_kek')
    ),
  -- Null only for the key encryption key, which belongs to no network.
  network text
    constraint signing_keys_network_format check (network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'),
  anchor_id text
    constraint signing_keys_anchor_format check (anchor_id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  provider text not null
    constraint signing_keys_provider check (provider in ('aws_kms', 'gcp_kms', 'local')),
  -- The key manager's name for the key, never the key. Shaped like a name, so a
  -- URL or a Stellar secret seed pasted here by mistake is refused.
  key_ref text not null
    constraint signing_keys_key_ref_format check (
      key_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$'
      and key_ref !~ '//'
      and key_ref !~ '^S[A-Z2-7]{55}$'
    ),
  -- The account a signing key controls: a public chain account, about no one.
  -- Null only for the key encryption key, which controls no account.
  account text
    constraint signing_keys_account_format check (account ~ '^[A-Za-z0-9]{1,128}$'),
  public_key bytea
    constraint signing_keys_public_key_size check (octet_length(public_key) = 32),
  status text not null default 'active'
    constraint signing_keys_status check (status in ('active', 'retiring', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A SEP-10 key logs in to one anchor, and no other key names one.
  constraint signing_keys_anchor_only_sep10 check ((purpose = 'sep10') = (anchor_id is not null)),
  -- The key encryption key has no network, account or public key. Everything
  -- else has all three.
  constraint signing_keys_chain_fields check (
    case
      when purpose = 'pii_kek' then
        network is null and account is null and public_key is null
      else
        network is not null and account is not null and public_key is not null
    end
  )
);

-- One active row per purpose, network, anchor and key. coalesce, because a
-- unique index treats two nulls as different.
create unique index signing_keys_one_active
  on ops.signing_keys (purpose, coalesce(network, ''), coalesce(anchor_id, ''), key_ref)
  where status = 'active';

-- As with managed signers, what a row names never changes. The status check is
-- written out here rather than read from ujira.status_transitions, so nothing
-- in this schema depends on a table in the other.
create function ops.keep_signing_key() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if new.purpose <> old.purpose or new.network is distinct from old.network
     or new.anchor_id is distinct from old.anchor_id or new.provider <> old.provider
     or new.key_ref <> old.key_ref or new.account is distinct from old.account
     or new.public_key is distinct from old.public_key then
    raise exception using
      errcode = 'UJ006',
      message = 'a signing key keeps its purpose, network, anchor, reference and account';
  end if;
  if new.status <> old.status and not (
    (old.status = 'active' and new.status in ('retiring', 'retired'))
    or (old.status = 'retiring' and new.status = 'retired')
  ) then
    raise exception using
      errcode = 'UJ004',
      message = format('signing_key cannot move from %s to %s', old.status, new.status);
  end if;
  return new;
end
$fn$;

create trigger signing_keys_keep before update on ops.signing_keys
  for each row execute function ops.keep_signing_key();
create trigger signing_keys_touch before update on ops.signing_keys
  for each row execute function ujira.touch();

grant select, insert, update on ops.signing_keys to ujira_ops;

-- The active keys for these purposes, for a service to check at startup.
create function ops.active_signing_keys(purposes text[])
  returns table (
    purpose text,
    network text,
    anchor_id text,
    provider text,
    key_ref text,
    account text,
    public_key bytea
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select k.purpose, k.network, k.anchor_id, k.provider, k.key_ref, k.account, k.public_key
    from ops.signing_keys as k
   where k.status = 'active' and k.purpose = any (purposes)
   order by k.id
$fn$;

grant execute on function ops.active_signing_keys(text[]) to ujira_app;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ops to ujira_ops;
alter function ops.active_signing_keys(text[]) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ops.active_signing_keys(text[]);
drop table ops.signing_keys;
drop function ops.keep_signing_key();
drop table ujira.managed_signers;
drop function ujira.keep_managed_signer();
delete from ujira.status_transitions where machine = 'managed_signer';

reset role;
