-- Generated from the migrations by `pnpm db:snapshot`.
-- Do not edit by hand: CI regenerates this file and fails if it differs.

--
-- PostgreSQL database dump
--

\restrict ujira


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: ops; Type: SCHEMA; Schema: -; Owner: ujira_owner
--

CREATE SCHEMA ops;


ALTER SCHEMA ops OWNER TO ujira_owner;

--
-- Name: ujira; Type: SCHEMA; Schema: -; Owner: ujira_owner
--

CREATE SCHEMA ujira;


ALTER SCHEMA ujira OWNER TO ujira_owner;

--
-- Name: amount; Type: DOMAIN; Schema: ujira; Owner: ujira_owner
--

CREATE DOMAIN ujira.amount AS numeric
	CONSTRAINT amount_is_i128_integer CHECK ((((VALUE >= '-170141183460469231731687303715884105728'::numeric) AND (VALUE <= '170141183460469231731687303715884105727'::numeric)) AND (scale(VALUE) = 0)));


ALTER DOMAIN ujira.amount OWNER TO ujira_owner;

--
-- Name: hash32; Type: DOMAIN; Schema: ujira; Owner: ujira_owner
--

CREATE DOMAIN ujira.hash32 AS bytea
	CONSTRAINT hash32_is_32_bytes CHECK ((octet_length(VALUE) = 32));


ALTER DOMAIN ujira.hash32 OWNER TO ujira_owner;

--
-- Name: network_id; Type: DOMAIN; Schema: ujira; Owner: ujira_owner
--

CREATE DOMAIN ujira.network_id AS text
	CONSTRAINT network_id_known CHECK ((VALUE = ANY (ARRAY['stellar:pubnet'::text, 'stellar:testnet'::text])));


ALTER DOMAIN ujira.network_id OWNER TO ujira_owner;

--
-- Name: scale; Type: DOMAIN; Schema: ujira; Owner: ujira_owner
--

CREATE DOMAIN ujira.scale AS smallint
	CONSTRAINT scale_in_range CHECK (((VALUE >= 0) AND (VALUE <= 18)));


ALTER DOMAIN ujira.scale OWNER TO ujira_owner;

--
-- Name: u64; Type: DOMAIN; Schema: ujira; Owner: ujira_owner
--

CREATE DOMAIN ujira.u64 AS numeric
	CONSTRAINT u64_range CHECK ((((VALUE >= (0)::numeric) AND (VALUE <= '18446744073709551615'::numeric)) AND (scale(VALUE) = 0)));


ALTER DOMAIN ujira.u64 OWNER TO ujira_owner;

--
-- Name: active_routing_config(); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.active_routing_config() RETURNS TABLE(version bigint, document jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  select v.version, v.document
    from ops.routing_config_active as a
    join ops.routing_config_versions as v on v.version = a.version
$$;


ALTER FUNCTION ops.active_routing_config() OWNER TO ujira_ops;

--
-- Name: active_signing_keys(text[]); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.active_signing_keys(purposes text[]) RETURNS TABLE(purpose text, network text, anchor_id text, provider text, key_ref text, account text, public_key bytea)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  select k.purpose, k.network, k.anchor_id, k.provider, k.key_ref, k.account, k.public_key
    from ops.signing_keys as k
   where k.status = 'active' and k.purpose = any (purposes)
   order by k.id
$$;


ALTER FUNCTION ops.active_signing_keys(purposes text[]) OWNER TO ujira_ops;

--
-- Name: identity_provider_event_seen(text, text, text); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.identity_provider_event_seen(p_provider text, p_provider_account text, p_event_key text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  select exists (
    select from ops.identity_provider_events as e
     where e.provider = p_provider
       and e.provider_account = p_provider_account
       and e.event_key = p_event_key
  )
$$;


ALTER FUNCTION ops.identity_provider_event_seen(p_provider text, p_provider_account text, p_event_key text) OWNER TO ujira_ops;

--
-- Name: keep_signing_key(); Type: FUNCTION; Schema: ops; Owner: ujira_owner
--

CREATE FUNCTION ops.keep_signing_key() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
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
$$;


ALTER FUNCTION ops.keep_signing_key() OWNER TO ujira_owner;

--
-- Name: lease_executor(text, text, integer); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.lease_executor(target_network text, holder text, lease_seconds integer) RETURNS TABLE(account_ref text, next_sequence bigint, lease_expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if lease_seconds is null or lease_seconds < 1 or lease_seconds > 3600 then
    raise exception using
      errcode = '22023',
      message = 'a lease lasts from 1 to 3600 seconds';
  end if;
  return query
    update ops.executor_accounts as e
       set lease_holder = holder,
           lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds)
     where (e.network, e.account_ref) = (
       select c.network, c.account_ref
         from ops.executor_accounts as c
        where c.network = target_network
          and (c.lease_expires_at is null or c.lease_expires_at < clock_timestamp())
        order by c.account_ref
        limit 1
        for update skip locked
     )
    returning e.account_ref, e.next_sequence, e.lease_expires_at;
end
$$;


ALTER FUNCTION ops.lease_executor(target_network text, holder text, lease_seconds integer) OWNER TO ujira_ops;

--
-- Name: record_identity_provider_event(text, text, text, bytea); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.record_identity_provider_event(p_provider text, p_provider_account text, p_event_key text, p_raw_sha256 bytea) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  stored boolean;
begin
  insert into ops.identity_provider_events (provider, provider_account, event_key, raw_sha256)
    values (p_provider, p_provider_account, p_event_key, p_raw_sha256)
    on conflict (provider, provider_account, event_key) do nothing
    returning true into stored;
  return coalesce(stored, false);
end
$$;


ALTER FUNCTION ops.record_identity_provider_event(p_provider text, p_provider_account text, p_event_key text, p_raw_sha256 bytea) OWNER TO ujira_ops;

--
-- Name: release_executor(text, text, text, bigint); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.release_executor(target_network text, account text, holder text, sequence_reached bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  released integer;
begin
  update ops.executor_accounts as e
     set lease_holder = null,
         lease_expires_at = null,
         next_sequence = greatest(e.next_sequence, sequence_reached)
   where e.network = target_network
     and e.account_ref = account
     and e.lease_holder = holder;
  get diagnostics released = row_count;
  return released > 0;
end
$$;


ALTER FUNCTION ops.release_executor(target_network text, account text, holder text, sequence_reached bigint) OWNER TO ujira_ops;

--
-- Name: apply_tenant_policies(regclass); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.apply_tenant_policies(target regclass) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  own_tenant constant text :=
    'principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id()';
begin
  execute format('alter table %s enable row level security', target);
  execute format('alter table %s force row level security', target);
  execute format(
    'create policy tenant_read on %s for select to ujira_app, ujira_reader using ('
      || 'principal_id = ujira.current_principal_id() and '
      || '(ujira.project_scope_all() or project_id = ujira.current_project_id()))',
    target
  );
  execute format(
    'create policy tenant_insert on %s for insert to ujira_app with check (%s)',
    target, own_tenant
  );
  execute format(
    'create policy tenant_update on %s for update to ujira_app using (%s) with check (%s)',
    target, own_tenant, own_tenant
  );
  execute format(
    'create policy owner_all on %s for all to ujira_owner using (true) with check (true)',
    target
  );
end
$$;


ALTER FUNCTION ujira.apply_tenant_policies(target regclass) OWNER TO ujira_owner;

--
-- Name: attestation_pending(bytea); Type: FUNCTION; Schema: ujira; Owner: ujira_signer_read
--

CREATE FUNCTION ujira.attestation_pending(p_digest bytea) RETURNS TABLE(principal_id uuid, project_id uuid, attestation_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  select null::uuid, null::uuid, null::uuid where false and p_digest is not null
$$;


ALTER FUNCTION ujira.attestation_pending(p_digest bytea) OWNER TO ujira_signer_read;

--
-- Name: audit_chain(); Type: FUNCTION; Schema: ujira; Owner: ujira_fn_audit
--

CREATE FUNCTION ujira.audit_chain() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  head ujira.audit_heads%rowtype;
begin
  perform ujira.audit_check_metadata(new.metadata);
  insert into ujira.audit_heads (principal_id, last_seq, last_hash)
    values (new.principal_id, 0, decode(repeat('00', 32), 'hex'))
    on conflict (principal_id) do nothing;
  select * into head
    from ujira.audit_heads as h
   where h.principal_id = new.principal_id
   for update;
  new.seq := head.last_seq + 1;
  new.prev_hash := head.last_hash;
  new.occurred_at := clock_timestamp();
  new.row_hash := ujira.audit_row_hash(
    new.prev_hash::bytea,
    new.principal_id,
    new.project_id,
    new.seq,
    new.action,
    new.actor_kind,
    new.actor_id,
    new.metadata,
    new.occurred_at
  );
  update ujira.audit_heads as h
     set last_seq = new.seq,
         last_hash = new.row_hash
   where h.principal_id = new.principal_id;
  return new;
end
$$;


ALTER FUNCTION ujira.audit_chain() OWNER TO ujira_fn_audit;

--
-- Name: audit_check_metadata(jsonb); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.audit_check_metadata(metadata jsonb) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog'
    AS $$
declare
  refused text;
begin
  if jsonb_typeof(metadata) <> 'object' then
    raise exception using errcode = 'UJ012', message = 'audit metadata must be an object';
  end if;
  select k into refused
    from jsonb_object_keys(metadata) as k
   where not exists (select 1 from ujira.audit_metadata_keys as a where a.key = k)
   limit 1;
  if refused is not null then
    raise exception using
      errcode = 'UJ012',
      message = format('audit metadata key %L is not on the allowlist', refused);
  end if;
  if exists (
    select 1 from jsonb_each(metadata) as e where jsonb_typeof(e.value) in ('object', 'array')
  ) then
    raise exception using errcode = 'UJ012', message = 'audit metadata values must be scalars';
  end if;
end
$$;


ALTER FUNCTION ujira.audit_check_metadata(metadata jsonb) OWNER TO ujira_owner;

--
-- Name: audit_row_hash(bytea, uuid, uuid, bigint, text, text, uuid, jsonb, timestamp with time zone); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.audit_row_hash(prev_hash bytea, principal_id uuid, project_id uuid, seq bigint, action text, actor_kind text, actor_id uuid, metadata jsonb, occurred_at timestamp with time zone) RETURNS bytea
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
  select sha256(
    prev_hash || convert_to(
      format(
        '%L|%L|%L|%L|%L|%L|%L|%L',
        principal_id,
        project_id,
        seq,
        action,
        actor_kind,
        actor_id,
        metadata::text,
        extract(epoch from occurred_at)::text
      ),
      'UTF8'
    )
  )
$$;


ALTER FUNCTION ujira.audit_row_hash(prev_hash bytea, principal_id uuid, project_id uuid, seq bigint, action text, actor_kind text, actor_id uuid, metadata jsonb, occurred_at timestamp with time zone) OWNER TO ujira_owner;

--
-- Name: authenticate_token(text); Type: FUNCTION; Schema: ujira; Owner: ujira_fn_tokens
--

CREATE FUNCTION ujira.authenticate_token(token_prefix text) RETURNS TABLE(token_id uuid, principal_id uuid, project_id uuid, secret_sha256 bytea, scopes text[], expires_at timestamp with time zone, revoked_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  select t.id, t.principal_id, t.project_id, t.secret_sha256::bytea, t.scopes, t.expires_at, t.revoked_at
    from ujira.api_tokens as t
   where t.prefix = token_prefix
$$;


ALTER FUNCTION ujira.authenticate_token(token_prefix text) OWNER TO ujira_fn_tokens;

--
-- Name: check_new_funding_sweep(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.check_new_funding_sweep() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if new.status <> 'awaiting_signature' then
    raise exception using
      errcode = 'UJ004',
      message = format('a funding sweep starts awaiting a signature, not %s', new.status);
  end if;
  if not exists (
    select 1
      from ujira.funding_sources as s
     where s.id = new.funding_source_id
       and s.mandate_instance_id = new.mandate_instance_id
       and s.kind = 'stellar_funding_account'
  ) then
    raise exception using
      errcode = '23503',
      message = 'a funding sweep comes from a funding account on its own mandate instance';
  end if;
  return null;
end
$$;


ALTER FUNCTION ujira.check_new_funding_sweep() OWNER TO ujira_owner;

--
-- Name: check_reporting_time_zone(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.check_reporting_time_zone() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.reporting_time_zone) then
    raise exception using
      errcode = '22023',
      message = 'reporting_time_zone is not an IANA time zone this server knows';
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.check_reporting_time_zone() OWNER TO ujira_owner;

--
-- Name: check_transition(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.check_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if new.status is distinct from old.status and not exists (
    select 1
      from ujira.status_transitions as t
     where t.machine = tg_argv[0]
       and t.from_status = old.status
       and t.to_status = new.status
  ) then
    raise exception using
      errcode = 'UJ004',
      message = format('%s cannot move from %s to %s', tg_argv[0], old.status, new.status);
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.check_transition() OWNER TO ujira_owner;

--
-- Name: create_principal(text, text, uuid, text); Type: FUNCTION; Schema: ujira; Owner: ujira_fn_principals
--

CREATE FUNCTION ujira.create_principal(principal_name text, project_name text, owner_user_id uuid, reporting_time_zone text DEFAULT 'UTC'::text) RETURNS TABLE(principal_id uuid, project_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  new_principal uuid := gen_random_uuid();
  new_project uuid := gen_random_uuid();
begin
  insert into ujira.principals (id, name, reporting_time_zone)
    values (new_principal, principal_name, create_principal.reporting_time_zone);
  insert into ujira.projects (principal_id, id, name)
    values (new_principal, new_project, project_name);
  insert into ujira.principal_members (principal_id, user_id, role)
    values (new_principal, owner_user_id, 'owner');
  return query select new_principal, new_project;
end
$$;


ALTER FUNCTION ujira.create_principal(principal_name text, project_name text, owner_user_id uuid, reporting_time_zone text) OWNER TO ujira_fn_principals;

--
-- Name: current_principal_id(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.current_principal_id() RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog'
    AS $$
declare
  principal text := current_setting('ujira.principal_id', true);
  bound text := current_setting('ujira.txid', true);
begin
  if principal is null or principal = '' then
    raise exception using
      errcode = 'UJ001',
      message = 'no tenant context: this transaction did not set one';
  end if;
  if bound is distinct from txid_current()::text then
    raise exception using
      errcode = 'UJ001',
      message = 'no tenant context: the settings belong to another transaction';
  end if;
  return principal::uuid;
end
$$;


ALTER FUNCTION ujira.current_principal_id() OWNER TO ujira_owner;

--
-- Name: current_project_id(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.current_project_id() RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog'
    AS $$
declare
  project text := current_setting('ujira.project_id', true);
begin
  if ujira.project_scope_all() then
    return null;
  end if;
  if project is null or project = '' then
    raise exception using
      errcode = 'UJ001',
      message = 'no tenant context: this transaction set no project';
  end if;
  return project::uuid;
end
$$;


ALTER FUNCTION ujira.current_project_id() OWNER TO ujira_owner;

--
-- Name: data_key_stays_shredded(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.data_key_stays_shredded() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if old.shredded_at is not null and new.shredded_at is null then
    raise exception using errcode = 'UJ018', message = 'a shredded data key stays shredded';
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.data_key_stays_shredded() OWNER TO ujira_owner;

--
-- Name: erased_subjects(uuid, bigint); Type: FUNCTION; Schema: ujira; Owner: ujira_fn_erasure
--

CREATE FUNCTION ujira.erased_subjects(after_id uuid, page_size bigint) RETURNS TABLE(id uuid, principal_id uuid, project_id uuid, subject_id uuid, occurred_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  select l.id, l.principal_id, l.project_id, l.subject_id, l.occurred_at
    from ujira.erasure_log as l
   where l.event = 'completed'
     and (after_id is null or l.id > after_id)
   order by l.id
   limit least(page_size, 10000)
$$;


ALTER FUNCTION ujira.erased_subjects(after_id uuid, page_size bigint) OWNER TO ujira_fn_erasure;

--
-- Name: fee_cap_only_lowers(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.fee_cap_only_lowers() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if old.max_fee_bps is not null
     and (new.max_fee_bps is null or new.max_fee_bps > old.max_fee_bps) then
    raise exception using
      errcode = 'UJ007',
      message = 'a fee cap can only go down';
  end if;
  if old.fee_address is not null and new.fee_address is distinct from old.fee_address then
    raise exception using
      errcode = 'UJ007',
      message = 'a fee address cannot change';
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.fee_cap_only_lowers() OWNER TO ujira_owner;

--
-- Name: fee_reconciliation_needs_execution(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.fee_reconciliation_needs_execution() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if not exists (
    select 1
      from ujira.payout_attempts as a
     where a.principal_id = new.principal_id
       and a.project_id = new.project_id
       and a.id = new.attempt_id
       and a.status in ('settled', 'final')
  ) then
    raise exception using
      errcode = 'UJ019',
      message = 'a fee can only be reconciled on an executed attempt';
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.fee_reconciliation_needs_execution() OWNER TO ujira_owner;

--
-- Name: fee_refunds_within_fee(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.fee_refunds_within_fee() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  fee numeric;
  refunded numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('ujira/fee-refund/' || new.attempt_id::text, 0));
  select a.fee_amount into fee
    from ujira.payout_attempts as a
   where a.principal_id = new.principal_id
     and a.project_id = new.project_id
     and a.id = new.attempt_id;
  select coalesce(sum(r.amount), 0) into refunded
    from ujira.fee_refunds as r
   where r.principal_id = new.principal_id
     and r.project_id = new.project_id
     and r.attempt_id = new.attempt_id
     and r.status <> 'not_owed';
  if refunded > fee then
    raise exception using
      errcode = 'UJ009',
      message = format('fee refunds of %s on an attempt that charged %s', refunded, fee);
  end if;
  return null;
end
$$;


ALTER FUNCTION ujira.fee_refunds_within_fee() OWNER TO ujira_owner;

--
-- Name: forbid_mutation(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  raise exception using
    errcode = 'UJ002',
    message = format('%I.%I is append only: %s is refused', tg_table_schema, tg_table_name, lower(tg_op));
end
$$;


ALTER FUNCTION ujira.forbid_mutation() OWNER TO ujira_owner;

--
-- Name: funding_hold_is_held(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.funding_hold_is_held() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if not exists (
    select 1
      from ujira.payouts as p
     where p.principal_id = new.principal_id
       and p.project_id = new.project_id
       and p.id = new.payout_id
       and p.status = 'received'
       and p.status_reason = 'awaiting_funding'
  ) then
    raise exception using
      errcode = 'UJ013',
      message = 'a funding hold needs a payout received and awaiting funding';
  end if;
  return null;
end
$$;


ALTER FUNCTION ujira.funding_hold_is_held() OWNER TO ujira_owner;

--
-- Name: keep_funding_sweep(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.keep_funding_sweep() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if new.principal_id <> old.principal_id or new.project_id <> old.project_id
     or new.funding_source_id <> old.funding_source_id
     or new.mandate_instance_id <> old.mandate_instance_id
     or new.chain <> old.chain or new.asset <> old.asset or new.scale <> old.scale
     or new.deposit_operation_id <> old.deposit_operation_id
     or new.amount <> old.amount then
    raise exception using
      errcode = 'UJ006',
      message = 'a funding sweep keeps its tenant, source, operation and amount';
  end if;
  if (new.sweep_tx_hash is distinct from old.sweep_tx_hash
      or new.sweep_valid_until is distinct from old.sweep_valid_until)
     and not (old.status = 'awaiting_signature' and new.status = 'submitted')
     and not (old.status = 'failed' and new.status = 'awaiting_signature') then
    raise exception using
      errcode = 'UJ006',
      message = 'a funding sweep takes its transaction on submission and drops it only to try again';
  end if;
  if new.failed_ledger is distinct from old.failed_ledger
     and not (old.status = 'submitted' and new.status = 'failed')
     and not (old.status = 'failed' and new.status = 'awaiting_signature') then
    raise exception using
      errcode = 'UJ006',
      message = 'a funding sweep takes its failed ledger only when it fails';
  end if;
  if old.status = 'awaiting_signature' and new.status = 'submitted'
     and new.sweep_valid_until <= now() then
    raise exception using
      errcode = 'UJ004',
      message = 'a funding sweep cannot be submitted with time bounds already past';
  end if;
  if old.status = 'submitted' and new.status = 'failed' and new.failed_ledger is null
     and now() < old.sweep_valid_until + interval '5 minutes' then
    raise exception using
      errcode = 'UJ004',
      message = 'a funding sweep cannot fail while its transaction might still land';
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.keep_funding_sweep() OWNER TO ujira_owner;

--
-- Name: keep_managed_signer(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.keep_managed_signer() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
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
$$;


ALTER FUNCTION ujira.keep_managed_signer() OWNER TO ujira_owner;

--
-- Name: keep_token_revoked(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.keep_token_revoked() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception using
      errcode = 'UJ006',
      message = 'a revoked api token cannot be restored or re-revoked';
  end if;
  if new.prefix <> old.prefix or new.secret_sha256 <> old.secret_sha256
     or new.principal_id <> old.principal_id or new.project_id <> old.project_id then
    raise exception using
      errcode = 'UJ006',
      message = 'an api token keeps its prefix, secret and tenant';
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.keep_token_revoked() OWNER TO ujira_owner;

--
-- Name: ledger_accounts_guard(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.ledger_accounts_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if tg_op = 'INSERT' then
    new.balance := 0;
    new.last_seq := 0;
    return new;
  end if;
  if tg_op = 'UPDATE' and current_user = 'ujira_fn_ledger'
     and new.id = old.id
     and new.principal_id = old.principal_id
     and new.project_id = old.project_id
     and new.mandate_instance_id = old.mandate_instance_id
     and new.kind = old.kind
     and new.chain = old.chain
     and new.asset = old.asset
     and new.scale = old.scale then
    return new;
  end if;
  raise exception using
    errcode = 'UJ002',
    message = format('%I.%I is changed only by the ledger stamp: %s is refused', tg_table_schema, tg_table_name, lower(tg_op));
end
$$;


ALTER FUNCTION ujira.ledger_accounts_guard() OWNER TO ujira_owner;

--
-- Name: ledger_balanced(); Type: FUNCTION; Schema: ujira; Owner: ujira_fn_ledger
--

CREATE FUNCTION ujira.ledger_balanced() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  journal uuid;
  total numeric;
  entries bigint;
begin
  -- Two statements, because a field of NEW is resolved when its statement is
  -- planned, and each table has only one of these columns.
  if tg_table_name = 'ledger_journals' then
    journal := new.id;
  else
    journal := new.journal_id;
  end if;
  select coalesce(sum(e.amount), 0), count(*) into total, entries
    from ujira.ledger_entries as e
   where e.journal_id = journal;
  if entries = 0 or total <> 0 then
    raise exception using
      errcode = 'UJ003',
      message = format('ledger journal %s does not balance: %s entries summing to %s', journal, entries, total);
  end if;
  return null;
end
$$;


ALTER FUNCTION ujira.ledger_balanced() OWNER TO ujira_fn_ledger;

--
-- Name: ledger_stamp(); Type: FUNCTION; Schema: ujira; Owner: ujira_fn_ledger
--

CREATE FUNCTION ujira.ledger_stamp() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  account ujira.ledger_accounts%rowtype;
  next_balance numeric;
begin
  select * into account
    from ujira.ledger_accounts as a
   where a.id = new.account_id
     and a.principal_id = new.principal_id
     and a.project_id = new.project_id
   for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'a ledger entry must name an account of its own tenant';
  end if;
  next_balance := account.balance + new.amount;
  if (account.kind = 'external' and next_balance > 0)
     or (account.kind <> 'external' and next_balance < 0) then
    raise exception using
      errcode = 'UJ011',
      message = format('this entry would take a %s account past zero', account.kind);
  end if;
  new.account_seq := account.last_seq + 1;
  new.balance_after := next_balance;
  update ujira.ledger_accounts as a
     set balance = next_balance,
         last_seq = new.account_seq
   where a.id = account.id;
  return new;
end
$$;


ALTER FUNCTION ujira.ledger_stamp() OWNER TO ujira_fn_ledger;

--
-- Name: leg_refund_stamp(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.leg_refund_stamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  select l.payout_id, l.attempt_id, l.chain, l.asset, l.scale
    into new.payout_id, new.attempt_id, new.chain, new.asset, new.scale
    from ujira.payout_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.id = new.payout_leg_id;
  return new;
end
$$;


ALTER FUNCTION ujira.leg_refund_stamp() OWNER TO ujira_owner;

--
-- Name: leg_refunds_within_leg(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.leg_refunds_within_leg() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  paid numeric;
  refunded numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('ujira/leg-refund/' || new.payout_leg_id::text, 0));
  select l.amount into paid
    from ujira.payout_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.id = new.payout_leg_id;
  select coalesce(sum(r.amount), 0) into refunded
    from ujira.leg_refunds as r
   where r.principal_id = new.principal_id
     and r.project_id = new.project_id
     and r.payout_leg_id = new.payout_leg_id;
  if refunded > paid then
    raise exception using
      errcode = 'UJ008',
      message = format('refunds of %s on a leg that paid %s', refunded, paid);
  end if;
  return null;
end
$$;


ALTER FUNCTION ujira.leg_refunds_within_leg() OWNER TO ujira_owner;

--
-- Name: legs_match_attempt(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.legs_match_attempt() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  target uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
  expected numeric;
  actual numeric;
begin
  select a.total_amount into expected
    from ujira.payout_attempts as a
   where a.principal_id = new.principal_id
     and a.project_id = new.project_id
     and a.id = target;
  select coalesce(sum(l.amount), 0) into actual
    from ujira.payout_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.attempt_id = target;
  if actual is distinct from expected then
    raise exception using
      errcode = 'UJ005',
      message = format('the legs of an attempt sum to %s and its total is %s', actual, expected);
  end if;
  return null;
end
$$;


ALTER FUNCTION ujira.legs_match_attempt() OWNER TO ujira_owner;

--
-- Name: legs_match_method(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.legs_match_method() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if not exists (
    select 1
      from ujira.payout_methods as m
     where m.principal_id = new.principal_id
       and m.project_id = new.project_id
       and m.id = new.payout_method_id
       and m.destination_address = new.destination_address
       and m.destination_tag is not distinct from new.destination_tag
  ) then
    raise exception using
      errcode = 'UJ010',
      message = 'a leg must use exactly the destination of its payout method';
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.legs_match_method() OWNER TO ujira_owner;

--
-- Name: payout_attempt_needs_open_payout(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.payout_attempt_needs_open_payout() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  payout_status text;
begin
  select p.status into payout_status
    from ujira.payouts as p
   where p.principal_id = new.principal_id
     and p.project_id = new.project_id
     and p.id = new.payout_id
   for share;
  if payout_status in ('paid', 'blocked', 'rejected', 'cancelled', 'failed') then
    raise exception using
      errcode = 'UJ017',
      message = format('a %s payout cannot take a new attempt', payout_status);
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.payout_attempt_needs_open_payout() OWNER TO ujira_owner;

--
-- Name: payout_instance_matches(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.payout_instance_matches() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if not exists (
    select 1
      from ujira.payouts as p
      join ujira.mandate_instances as i
        on i.principal_id = p.principal_id
       and i.project_id = p.project_id
       and i.mandate_id = p.mandate_id
     where p.principal_id = new.principal_id
       and p.project_id = new.project_id
       and p.id = new.payout_id
       and i.id = new.mandate_instance_id
  ) then
    raise exception using
      errcode = 'UJ014',
      message = 'the mandate instance does not belong to the mandate of this payout';
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.payout_instance_matches() OWNER TO ujira_owner;

--
-- Name: payout_left_its_holds(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.payout_left_its_holds() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if exists (
    select 1
      from ujira.payout_funding_holds as h
     where h.principal_id = new.principal_id
       and h.project_id = new.project_id
       and h.payout_id = new.id
  ) and exists (
    select 1
      from ujira.payouts as p
     where p.principal_id = new.principal_id
       and p.project_id = new.project_id
       and p.id = new.id
       and (p.status <> 'received' or p.status_reason is distinct from 'awaiting_funding')
  ) then
    raise exception using
      errcode = 'UJ013',
      message = 'a payout that is no longer held still has funding holds';
  end if;
  return null;
end
$$;


ALTER FUNCTION ujira.payout_left_its_holds() OWNER TO ujira_owner;

--
-- Name: payout_leg_stamp(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.payout_leg_stamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if not exists (
    select 1
      from ujira.payouts as p
      join ujira.payout_methods as m
        on m.principal_id = p.principal_id
       and m.project_id = p.project_id
       and m.recipient_id = p.recipient_id
     where p.principal_id = new.principal_id
       and p.project_id = new.project_id
       and p.id = new.payout_id
       and m.id = new.payout_method_id
       and m.chain = new.chain
       and m.method = new.method
  ) then
    raise exception using
      errcode = 'UJ015',
      message = 'the payout method is not one the recipient of this payout has for this leg';
  end if;
  new.leg_key := encode(
    sha256(convert_to('ujira/leg/v1|' || new.payout_id::text || '|' || new.leg_index::text, 'UTF8')),
    'hex'
  );
  return new;
end
$$;


ALTER FUNCTION ujira.payout_leg_stamp() OWNER TO ujira_owner;

--
-- Name: project_scope_all(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.project_scope_all() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog'
    AS $$
declare
  scope text := current_setting('ujira.scope', true);
begin
  perform ujira.current_principal_id();
  if scope = 'all' then
    return true;
  end if;
  if scope = 'project' then
    return false;
  end if;
  raise exception using
    errcode = 'UJ001',
    message = 'no tenant context: the scope is neither project nor all';
end
$$;


ALTER FUNCTION ujira.project_scope_all() OWNER TO ujira_owner;

--
-- Name: receipt_is_whole(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.receipt_is_whole() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  target uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
  receipt ujira.receipts%rowtype;
  listed bigint;
  settled numeric;
  fees numeric;
  expected bigint;
begin
  select * into receipt
    from ujira.receipts as r
   where r.principal_id = new.principal_id
     and r.project_id = new.project_id
     and r.id = target;
  select count(*), coalesce(sum(l.amount), 0), coalesce(sum(l.fee_amount), 0)
    into listed, settled, fees
    from ujira.receipt_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.receipt_id = target;
  select count(*) into expected
    from ujira.payout_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.attempt_id = receipt.attempt_id;
  if listed <> expected
     or settled <> receipt.settlement_amount
     or fees <> receipt.fee_amount then
    raise exception using
      errcode = 'UJ016',
      message = 'a receipt must list every leg of its attempt, and its totals must be their sums';
  end if;
  return null;
end
$$;


ALTER FUNCTION ujira.receipt_is_whole() OWNER TO ujira_owner;

--
-- Name: recipient_stays_erased(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.recipient_stays_erased() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if old.status = 'erased' and new.status <> 'erased' then
    raise exception using errcode = 'UJ018', message = 'an erased recipient stays erased';
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.recipient_stays_erased() OWNER TO ujira_owner;

--
-- Name: record_fee_terms(bigint, text, timestamp with time zone, text, text, uuid); Type: FUNCTION; Schema: ujira; Owner: ujira_fn_fees
--

CREATE FUNCTION ujira.record_fee_terms(p_rate_bps bigint, p_basis text, p_valid_from timestamp with time zone, p_contract_reference text, p_actor_kind text, p_actor_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  new_id uuid := gen_random_uuid();
begin
  insert into ujira.fee_terms
    (principal_id, project_id, id, rate_bps, basis, valid_from, contract_reference)
  values (
    ujira.current_principal_id(), ujira.current_project_id(), new_id, p_rate_bps, p_basis,
    p_valid_from, p_contract_reference
  );
  -- audit_chain overwrites the sequence and both hashes.
  insert into ujira.audit_log
    (principal_id, project_id, action, actor_kind, actor_id, metadata, seq, prev_hash, row_hash)
  values (
    ujira.current_principal_id(), ujira.current_project_id(), 'fee_terms.recorded', p_actor_kind,
    p_actor_id,
    jsonb_build_object(
      'target_type', 'fee_terms', 'target_id', new_id::text, 'new_value', p_rate_bps::text
    ),
    0, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex')
  );
  return new_id;
end
$$;


ALTER FUNCTION ujira.record_fee_terms(p_rate_bps bigint, p_basis text, p_valid_from timestamp with time zone, p_contract_reference text, p_actor_kind text, p_actor_id uuid) OWNER TO ujira_fn_fees;

--
-- Name: refuse_personal_data_after_erasure(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.refuse_personal_data_after_erasure() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if exists (
    select 1
      from ujira.recipients as r
     where r.principal_id = new.principal_id
       and r.project_id = new.project_id
       and r.id = new.recipient_id
       and r.status = 'erased'
  ) then
    raise exception using errcode = 'UJ018', message = 'this recipient has been erased';
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.refuse_personal_data_after_erasure() OWNER TO ujira_owner;

--
-- Name: replay_erasure(uuid, uuid, uuid); Type: FUNCTION; Schema: ujira; Owner: ujira_fn_erasure
--

CREATE FUNCTION ujira.replay_erasure(target_principal uuid, target_project uuid, target_subject uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  changed boolean := false;
  touched bigint;
  new_erasure uuid := gen_random_uuid();
begin
  perform 1
    from ujira.recipients as r
   where r.principal_id = target_principal
     and r.project_id = target_project
     and r.id = target_subject
   for update;
  if not found then
    return false;
  end if;

  update ujira.data_keys as k
     set wrapped_key = null, kek_id = null, shredded_at = now()
   where k.principal_id = target_principal
     and k.project_id = target_project
     and k.subject_id = target_subject
     and k.shredded_at is null;
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  insert into ujira.data_keys (principal_id, project_id, subject_id, shredded_at)
    values (target_principal, target_project, target_subject, now())
    on conflict (principal_id, project_id, subject_id) do nothing;
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  delete from ujira.recipient_pii as p
   where p.principal_id = target_principal
     and p.project_id = target_project
     and p.recipient_id = target_subject;
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  update ujira.payout_methods as m
     set details_ciphertext = null, details_nonce = null
   where m.principal_id = target_principal
     and m.project_id = target_project
     and m.recipient_id = target_subject
     and m.details_ciphertext is not null;
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  -- As recipientIdentities.erase does, because a restore brings these back too.
  update ujira.recipient_identities as i
     set state = 'revoked',
         provider_ref = null,
         provider_subject = null,
         nullifier_hmac = null,
         pending_session_id = null,
         pending_session_url = null,
         pending_session_expires_at = null
   where i.principal_id = target_principal
     and i.project_id = target_project
     and i.recipient_id = target_subject
     and (
       i.state <> 'revoked'
       or i.provider_ref is not null
       or i.provider_subject is not null
       or i.nullifier_hmac is not null
       or i.pending_session_id is not null
       or i.pending_session_url is not null
       or i.pending_session_expires_at is not null
     );
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  update ujira.recipients as r
     set status = 'erased'
   where r.principal_id = target_principal
     and r.project_id = target_project
     and r.id = target_subject
     and r.status <> 'erased';
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  if not exists (
    select 1
      from ujira.erasure_log as l
     where l.principal_id = target_principal
       and l.project_id = target_project
       and l.subject_id = target_subject
       and l.event = 'completed'
  ) then
    insert into ujira.erasure_log (principal_id, project_id, erasure_id, subject_id, event)
      values
        (target_principal, target_project, new_erasure, target_subject, 'requested'),
        (target_principal, target_project, new_erasure, target_subject, 'completed');
    changed := true;
  end if;
  return changed;
end
$$;


ALTER FUNCTION ujira.replay_erasure(target_principal uuid, target_project uuid, target_subject uuid) OWNER TO ujira_fn_erasure;

--
-- Name: resolve_mandate_instance(text, text); Type: FUNCTION; Schema: ujira; Owner: ujira_fn_instances
--

CREATE FUNCTION ujira.resolve_mandate_instance(target_chain text, target_address text) RETURNS TABLE(principal_id uuid, project_id uuid, mandate_instance_id uuid, asset text, scale smallint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  select i.principal_id, i.project_id, i.id, i.asset, i.scale::smallint
    from ujira.mandate_instances as i
   where i.chain = target_chain
     and i.contract_address = target_address
$$;


ALTER FUNCTION ujira.resolve_mandate_instance(target_chain text, target_address text) OWNER TO ujira_fn_instances;

--
-- Name: touch(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.touch() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  new.updated_at := now();
  return new;
end
$$;


ALTER FUNCTION ujira.touch() OWNER TO ujira_owner;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: chain_cursors; Type: TABLE; Schema: ops; Owner: ujira_owner
--

CREATE TABLE ops.chain_cursors (
    network text NOT NULL,
    cursor text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chain_cursors_network_format CHECK ((network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'::text))
);


ALTER TABLE ops.chain_cursors OWNER TO ujira_owner;

--
-- Name: executor_accounts; Type: TABLE; Schema: ops; Owner: ujira_owner
--

CREATE TABLE ops.executor_accounts (
    network text NOT NULL,
    account_ref text NOT NULL,
    lease_holder text,
    lease_expires_at timestamp with time zone,
    next_sequence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT executor_accounts_lease_whole CHECK (((lease_holder IS NULL) = (lease_expires_at IS NULL))),
    CONSTRAINT executor_accounts_network_format CHECK ((network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'::text)),
    CONSTRAINT executor_accounts_sequence_positive CHECK ((next_sequence >= 0))
);


ALTER TABLE ops.executor_accounts OWNER TO ujira_owner;

--
-- Name: fee_estimates; Type: TABLE; Schema: ops; Owner: ujira_owner
--

CREATE TABLE ops.fee_estimates (
    network text NOT NULL,
    op text NOT NULL,
    leg_count bigint NOT NULL,
    p95_resource_fee_stroops bigint NOT NULL,
    p95_rent_stroops bigint NOT NULL,
    p95_inclusion_fee_stroops bigint NOT NULL,
    sample_count bigint NOT NULL,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fee_estimates_inclusion_fee_not_negative CHECK ((p95_inclusion_fee_stroops >= 0)),
    CONSTRAINT fee_estimates_leg_count_range CHECK (((leg_count >= 1) AND (leg_count <= 4))),
    CONSTRAINT fee_estimates_network_format CHECK ((network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'::text)),
    CONSTRAINT fee_estimates_op_known CHECK ((op = ANY (ARRAY['request'::text, 'request_batch'::text, 'execute'::text, 'execute_batch'::text, 'approve'::text, 'reject'::text, 'cancel'::text, 'cancel_batch'::text]))),
    CONSTRAINT fee_estimates_rent_not_negative CHECK ((p95_rent_stroops >= 0)),
    CONSTRAINT fee_estimates_rent_within_resource_fee CHECK ((p95_rent_stroops <= p95_resource_fee_stroops)),
    CONSTRAINT fee_estimates_resource_fee_not_negative CHECK ((p95_resource_fee_stroops >= 0)),
    CONSTRAINT fee_estimates_sample_count_positive CHECK ((sample_count > 0)),
    CONSTRAINT fee_estimates_window_ordered CHECK ((window_end > window_start))
);


ALTER TABLE ops.fee_estimates OWNER TO ujira_owner;

--
-- Name: identity_provider_events; Type: TABLE; Schema: ops; Owner: ujira_owner
--

CREATE TABLE ops.identity_provider_events (
    provider text NOT NULL,
    provider_account text NOT NULL,
    event_key text NOT NULL,
    raw_sha256 bytea NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_provider_events_account_format CHECK ((provider_account ~ '^[A-Za-z0-9_.:-]{1,128}$'::text)),
    CONSTRAINT identity_provider_events_digest_length CHECK ((octet_length(raw_sha256) = 32)),
    CONSTRAINT identity_provider_events_key_format CHECK ((event_key ~ '^[A-Za-z0-9_.:-]{1,200}$'::text)),
    CONSTRAINT identity_provider_events_provider_format CHECK ((provider ~ '^[a-z0-9_]{1,32}$'::text))
);


ALTER TABLE ops.identity_provider_events OWNER TO ujira_owner;

--
-- Name: routing_config_active; Type: TABLE; Schema: ops; Owner: ujira_owner
--

CREATE TABLE ops.routing_config_active (
    only_row boolean DEFAULT true NOT NULL,
    version bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT routing_config_active_one_row CHECK (only_row)
);


ALTER TABLE ops.routing_config_active OWNER TO ujira_owner;

--
-- Name: routing_config_versions; Type: TABLE; Schema: ops; Owner: ujira_owner
--

CREATE TABLE ops.routing_config_versions (
    version bigint NOT NULL,
    document jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT routing_config_created_by_format CHECK ((created_by ~ '^[a-z0-9_.:-]{1,64}$'::text))
);


ALTER TABLE ops.routing_config_versions OWNER TO ujira_owner;

--
-- Name: routing_config_versions_version_seq; Type: SEQUENCE; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ops.routing_config_versions ALTER COLUMN version ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME ops.routing_config_versions_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: signing_keys; Type: TABLE; Schema: ops; Owner: ujira_owner
--

CREATE TABLE ops.signing_keys (
    id bigint NOT NULL,
    purpose text NOT NULL,
    network text,
    anchor_id text,
    provider text NOT NULL,
    key_ref text NOT NULL,
    account text,
    public_key bytea,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT signing_keys_account_format CHECK ((account ~ '^[A-Za-z0-9]{1,128}$'::text)),
    CONSTRAINT signing_keys_anchor_format CHECK ((anchor_id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'::text)),
    CONSTRAINT signing_keys_anchor_only_sep10 CHECK (((purpose = 'sep10'::text) = (anchor_id IS NOT NULL))),
    CONSTRAINT signing_keys_chain_fields CHECK (
CASE
    WHEN (purpose = 'pii_kek'::text) THEN ((network IS NULL) AND (account IS NULL) AND (public_key IS NULL))
    ELSE ((network IS NOT NULL) AND (account IS NOT NULL) AND (public_key IS NOT NULL))
END),
    CONSTRAINT signing_keys_key_ref_format CHECK (((key_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$'::text) AND (key_ref !~ '//'::text) AND (key_ref !~ '^S[A-Z2-7]{55}$'::text))),
    CONSTRAINT signing_keys_network_format CHECK ((network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'::text)),
    CONSTRAINT signing_keys_provider CHECK ((provider = ANY (ARRAY['aws_kms'::text, 'gcp_kms'::text, 'local'::text]))),
    CONSTRAINT signing_keys_public_key_size CHECK ((octet_length(public_key) = 32)),
    CONSTRAINT signing_keys_purpose CHECK ((purpose = ANY (ARRAY['executor'::text, 'fee_sponsor'::text, 'sep10'::text, 'attester'::text, 'pii_kek'::text]))),
    CONSTRAINT signing_keys_status CHECK ((status = ANY (ARRAY['active'::text, 'retiring'::text, 'retired'::text])))
);


ALTER TABLE ops.signing_keys OWNER TO ujira_owner;

--
-- Name: signing_keys_id_seq; Type: SEQUENCE; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ops.signing_keys ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME ops.signing_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ujira_migrations; Type: TABLE; Schema: public; Owner: test
--

CREATE TABLE public.ujira_migrations (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    run_on timestamp without time zone NOT NULL
);


ALTER TABLE public.ujira_migrations OWNER TO test;

--
-- Name: ujira_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: test
--

CREATE SEQUENCE public.ujira_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.ujira_migrations_id_seq OWNER TO test;

--
-- Name: ujira_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: test
--

ALTER SEQUENCE public.ujira_migrations_id_seq OWNED BY public.ujira_migrations.id;


--
-- Name: api_tokens; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.api_tokens (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    prefix text NOT NULL,
    secret_sha256 ujira.hash32 NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT api_tokens_prefix_format CHECK ((prefix ~ '^[A-Za-z0-9_]{8,40}$'::text)),
    CONSTRAINT api_tokens_scopes_bounded CHECK ((cardinality(scopes) <= 32))
);

ALTER TABLE ONLY ujira.api_tokens FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.api_tokens OWNER TO ujira_owner;

--
-- Name: approvals; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.approvals (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attempt_id uuid NOT NULL,
    approver text NOT NULL,
    decision text NOT NULL,
    signed_message_hash ujira.hash32 NOT NULL,
    signature bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approvals_approver_length CHECK (((char_length(approver) >= 1) AND (char_length(approver) <= 128))),
    CONSTRAINT approvals_decision CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text]))),
    CONSTRAINT approvals_signature_length CHECK (((octet_length(signature) >= 1) AND (octet_length(signature) <= 512)))
);

ALTER TABLE ONLY ujira.approvals FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.approvals OWNER TO ujira_owner;

--
-- Name: audit_heads; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.audit_heads (
    principal_id uuid NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    last_hash ujira.hash32 NOT NULL
);

ALTER TABLE ONLY ujira.audit_heads FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.audit_heads OWNER TO ujira_owner;

--
-- Name: audit_log; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.audit_log (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    action text NOT NULL,
    actor_kind text NOT NULL,
    actor_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    prev_hash ujira.hash32 NOT NULL,
    row_hash ujira.hash32 NOT NULL,
    CONSTRAINT audit_log_action_format CHECK ((action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'::text)),
    CONSTRAINT audit_log_actor_kind CHECK ((actor_kind = ANY (ARRAY['member'::text, 'token'::text, 'system'::text]))),
    CONSTRAINT audit_log_actor_whole CHECK (((actor_kind = 'system'::text) = (actor_id IS NULL)))
);

ALTER TABLE ONLY ujira.audit_log FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.audit_log OWNER TO ujira_owner;

--
-- Name: audit_metadata_keys; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.audit_metadata_keys (
    key text NOT NULL,
    CONSTRAINT audit_metadata_keys_format CHECK ((key ~ '^[a-z][a-z0-9_]{0,63}$'::text))
);


ALTER TABLE ujira.audit_metadata_keys OWNER TO ujira_owner;

--
-- Name: chain_events; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.chain_events (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mandate_instance_id uuid NOT NULL,
    chain text NOT NULL,
    tx_hash ujira.hash32 NOT NULL,
    event_index bigint NOT NULL,
    ledger bigint NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    finalized_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chain_events_index_positive CHECK ((event_index >= 0)),
    CONSTRAINT chain_events_ledger_positive CHECK ((ledger >= 0)),
    CONSTRAINT chain_events_type_length CHECK (((char_length(event_type) >= 1) AND (char_length(event_type) <= 64)))
);

ALTER TABLE ONLY ujira.chain_events FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.chain_events OWNER TO ujira_owner;

--
-- Name: chains; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.chains (
    code text NOT NULL,
    CONSTRAINT chains_code_format CHECK ((code ~ '^[a-z][a-z0-9_]{0,31}$'::text))
);


ALTER TABLE ujira.chains OWNER TO ujira_owner;

--
-- Name: currencies; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.currencies (
    code text NOT NULL,
    minor_units ujira.scale NOT NULL,
    CONSTRAINT currencies_code_format CHECK ((code ~ '^[A-Z]{3}$'::text))
);


ALTER TABLE ujira.currencies OWNER TO ujira_owner;

--
-- Name: currency_scales; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.currency_scales (
    currency text NOT NULL,
    scale ujira.scale NOT NULL
);


ALTER TABLE ujira.currency_scales OWNER TO ujira_owner;

--
-- Name: data_keys; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.data_keys (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    wrapped_key bytea,
    kek_id text,
    schema_version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shredded_at timestamp with time zone,
    CONSTRAINT data_keys_kek_id_length CHECK (((char_length(kek_id) >= 1) AND (char_length(kek_id) <= 128))),
    CONSTRAINT data_keys_schema_version_range CHECK (((schema_version >= 1) AND (schema_version <= 1000))),
    CONSTRAINT data_keys_whole CHECK ((((wrapped_key IS NOT NULL) AND (kek_id IS NOT NULL) AND (shredded_at IS NULL)) OR ((wrapped_key IS NULL) AND (kek_id IS NULL) AND (shredded_at IS NOT NULL))))
);

ALTER TABLE ONLY ujira.data_keys FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.data_keys OWNER TO ujira_owner;

--
-- Name: deposits; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.deposits (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mandate_instance_id uuid NOT NULL,
    funding_source_id uuid,
    chain_event_id uuid NOT NULL,
    amount ujira.amount NOT NULL,
    asset text NOT NULL,
    chain text NOT NULL,
    scale ujira.scale NOT NULL,
    from_address text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deposits_amount_positive CHECK (((amount)::numeric > (0)::numeric)),
    CONSTRAINT deposits_from_length CHECK (((char_length(from_address) >= 1) AND (char_length(from_address) <= 128)))
);

ALTER TABLE ONLY ujira.deposits FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.deposits OWNER TO ujira_owner;

--
-- Name: erasure_log; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.erasure_log (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    erasure_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    event text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erasure_log_event CHECK ((event = ANY (ARRAY['requested'::text, 'completed'::text])))
);

ALTER TABLE ONLY ujira.erasure_log FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.erasure_log OWNER TO ujira_owner;

--
-- Name: fee_reconciliations; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.fee_reconciliations (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payout_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    revision bigint NOT NULL,
    chain text NOT NULL,
    asset text NOT NULL,
    scale ujira.scale NOT NULL,
    expected_fee_amount ujira.amount NOT NULL,
    on_chain_fee_amount ujira.amount NOT NULL,
    received_fee_amount ujira.amount NOT NULL,
    shortfall_amount ujira.amount NOT NULL,
    outcome text NOT NULL,
    resolution text DEFAULT 'none'::text NOT NULL,
    invoice_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fee_reconciliations_expected_not_negative CHECK (((expected_fee_amount)::numeric >= (0)::numeric)),
    CONSTRAINT fee_reconciliations_invoice_length CHECK (((char_length(invoice_reference) >= 1) AND (char_length(invoice_reference) <= 128))),
    CONSTRAINT fee_reconciliations_invoice_when_invoiced CHECK (((resolution = 'invoiced'::text) = (invoice_reference IS NOT NULL))),
    CONSTRAINT fee_reconciliations_matched_needs_nothing CHECK (((outcome <> 'matched'::text) OR (resolution = 'none'::text))),
    CONSTRAINT fee_reconciliations_on_chain_not_negative CHECK (((on_chain_fee_amount)::numeric >= (0)::numeric)),
    CONSTRAINT fee_reconciliations_outcome CHECK ((outcome = ANY (ARRAY['matched'::text, 'underpaid'::text, 'mismatch'::text]))),
    CONSTRAINT fee_reconciliations_outcome_follows CHECK ((outcome =
CASE
    WHEN (((expected_fee_amount)::numeric = (on_chain_fee_amount)::numeric) AND ((on_chain_fee_amount)::numeric = (received_fee_amount)::numeric)) THEN 'matched'::text
    WHEN ((received_fee_amount)::numeric < (expected_fee_amount)::numeric) THEN 'underpaid'::text
    ELSE 'mismatch'::text
END)),
    CONSTRAINT fee_reconciliations_received_not_negative CHECK (((received_fee_amount)::numeric >= (0)::numeric)),
    CONSTRAINT fee_reconciliations_resolution CHECK ((resolution = ANY (ARRAY['none'::text, 'invoiced'::text, 'waived'::text]))),
    CONSTRAINT fee_reconciliations_revision_range CHECK (((revision >= 1) AND (revision <= 1000000))),
    CONSTRAINT fee_reconciliations_shortfall_is_missing CHECK (((shortfall_amount)::numeric = GREATEST(((expected_fee_amount)::numeric - (received_fee_amount)::numeric), (0)::numeric)))
);

ALTER TABLE ONLY ujira.fee_reconciliations FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.fee_reconciliations OWNER TO ujira_owner;

--
-- Name: fee_refunds; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.fee_refunds (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    leg_refund_id uuid NOT NULL,
    payout_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    chain text NOT NULL,
    asset text NOT NULL,
    scale ujira.scale NOT NULL,
    amount ujira.amount NOT NULL,
    from_address text,
    to_address text NOT NULL,
    status text DEFAULT 'owed'::text NOT NULL,
    idempotency_key ujira.hash32 NOT NULL,
    due_at timestamp with time zone NOT NULL,
    tx_hash ujira.hash32,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fee_refunds_amount_not_negative CHECK (((amount)::numeric >= (0)::numeric)),
    CONSTRAINT fee_refunds_failure_format CHECK ((failure_reason ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
    CONSTRAINT fee_refunds_from_length CHECK (((char_length(from_address) >= 1) AND (char_length(from_address) <= 128))),
    CONSTRAINT fee_refunds_has_a_source CHECK (((status = 'not_owed'::text) OR (from_address IS NOT NULL))),
    CONSTRAINT fee_refunds_key_is_derived CHECK (((idempotency_key)::bytea = sha256(convert_to(('ujira/fee-refund/v1'::text || (leg_refund_id)::text), 'UTF8'::name)))),
    CONSTRAINT fee_refunds_owes_something CHECK (((status = 'not_owed'::text) OR ((amount)::numeric > (0)::numeric))),
    CONSTRAINT fee_refunds_status CHECK ((status = ANY (ARRAY['owed'::text, 'awaiting_signatures'::text, 'submitted'::text, 'settled'::text, 'failed'::text, 'not_owed'::text]))),
    CONSTRAINT fee_refunds_submitted_has_hash CHECK (((status <> ALL (ARRAY['submitted'::text, 'settled'::text])) OR (tx_hash IS NOT NULL))),
    CONSTRAINT fee_refunds_to_length CHECK (((char_length(to_address) >= 1) AND (char_length(to_address) <= 128)))
);

ALTER TABLE ONLY ujira.fee_refunds FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.fee_refunds OWNER TO ujira_owner;

--
-- Name: fee_terms; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.fee_terms (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rate_bps bigint NOT NULL,
    basis text NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    contract_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fee_terms_basis CHECK ((basis = ANY (ARRAY['standard'::text, 'committed_volume'::text, 'negotiated'::text, 'internal_at_cost'::text]))),
    CONSTRAINT fee_terms_contract_reference_length CHECK (((char_length(contract_reference) >= 1) AND (char_length(contract_reference) <= 128))),
    CONSTRAINT fee_terms_rate_range CHECK (((rate_bps >= 0) AND (rate_bps <= 100)))
);

ALTER TABLE ONLY ujira.fee_terms FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.fee_terms OWNER TO ujira_owner;

--
-- Name: funding_sources; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.funding_sources (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mandate_instance_id uuid NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT funding_sources_config_shape CHECK (
CASE
    WHEN (kind <> 'stellar_funding_account'::text) THEN (config = '{}'::jsonb)
    WHEN (jsonb_typeof(config) <> 'object'::text) THEN false
    ELSE COALESCE(((((config - 'sponsored_reserves'::text) - 'sponsor_tx_hash'::text) = '{}'::jsonb) AND ((config -> 'sponsored_reserves'::text) = 'true'::jsonb) AND (jsonb_typeof((config -> 'sponsor_tx_hash'::text)) = 'string'::text) AND ((config ->> 'sponsor_tx_hash'::text) ~ '^[0-9a-f]{64}$'::text)), false)
END),
    CONSTRAINT funding_sources_kind CHECK ((kind = ANY (ARRAY['stablecoin_deposit'::text, 'stellar_funding_account'::text])))
);

ALTER TABLE ONLY ujira.funding_sources FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.funding_sources OWNER TO ujira_owner;

--
-- Name: funding_sweeps; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.funding_sweeps (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    funding_source_id uuid NOT NULL,
    mandate_instance_id uuid NOT NULL,
    chain text NOT NULL,
    asset text NOT NULL,
    scale ujira.scale NOT NULL,
    deposit_operation_id text NOT NULL,
    amount ujira.amount NOT NULL,
    status text DEFAULT 'awaiting_signature'::text NOT NULL,
    sweep_tx_hash ujira.hash32,
    sweep_valid_until timestamp with time zone,
    failed_ledger bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT funding_sweeps_amount_positive CHECK (((amount)::numeric > (0)::numeric)),
    CONSTRAINT funding_sweeps_attempt_by_status CHECK (
CASE
    WHEN (status = ANY (ARRAY['submitted'::text, 'settled'::text])) THEN ((sweep_tx_hash IS NOT NULL) AND (sweep_valid_until IS NOT NULL) AND (failed_ledger IS NULL))
    WHEN (status = 'failed'::text) THEN ((sweep_tx_hash IS NOT NULL) AND (sweep_valid_until IS NOT NULL))
    ELSE ((sweep_tx_hash IS NULL) AND (sweep_valid_until IS NULL) AND (failed_ledger IS NULL))
END),
    CONSTRAINT funding_sweeps_failed_ledger_positive CHECK ((failed_ledger >= 0)),
    CONSTRAINT funding_sweeps_operation_length CHECK (((char_length(deposit_operation_id) >= 1) AND (char_length(deposit_operation_id) <= 128))),
    CONSTRAINT funding_sweeps_status CHECK ((status = ANY (ARRAY['awaiting_signature'::text, 'submitted'::text, 'settled'::text, 'failed'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY ujira.funding_sweeps FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.funding_sweeps OWNER TO ujira_owner;

--
-- Name: ledger_accounts; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.ledger_accounts (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mandate_instance_id uuid NOT NULL,
    kind text NOT NULL,
    chain text NOT NULL,
    asset text NOT NULL,
    scale ujira.scale NOT NULL,
    balance ujira.amount DEFAULT 0 NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_accounts_kind CHECK ((kind = ANY (ARRAY['balance'::text, 'pending'::text, 'committed'::text, 'spent'::text, 'external'::text, 'fee'::text])))
);

ALTER TABLE ONLY ujira.ledger_accounts FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.ledger_accounts OWNER TO ujira_owner;

--
-- Name: ledger_entries; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.ledger_entries (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    journal_id uuid NOT NULL,
    account_id uuid NOT NULL,
    amount ujira.amount NOT NULL,
    account_seq bigint NOT NULL,
    balance_after ujira.amount NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_entries_amount_nonzero CHECK (((amount)::numeric <> (0)::numeric))
);

ALTER TABLE ONLY ujira.ledger_entries FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.ledger_entries OWNER TO ujira_owner;

--
-- Name: ledger_journals; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.ledger_journals (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mandate_instance_id uuid NOT NULL,
    chain_event_id uuid,
    reverses_journal_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_journals_one_cause CHECK (((chain_event_id IS NULL) <> (reverses_journal_id IS NULL)))
);

ALTER TABLE ONLY ujira.ledger_journals FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.ledger_journals OWNER TO ujira_owner;

--
-- Name: mandate_state_snapshots; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.mandate_state_snapshots (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mandate_instance_id uuid NOT NULL,
    ledger bigint NOT NULL,
    balance ujira.amount NOT NULL,
    pending ujira.amount NOT NULL,
    committed ujira.amount NOT NULL,
    spent ujira.amount NOT NULL,
    taken_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mandate_state_snapshots_ledger_positive CHECK ((ledger >= 0))
);

ALTER TABLE ONLY ujira.mandate_state_snapshots FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.mandate_state_snapshots OWNER TO ujira_owner;

--
-- Name: ledger_reconciliation; Type: VIEW; Schema: ujira; Owner: ujira_owner
--

CREATE VIEW ujira.ledger_reconciliation WITH (security_invoker='true') AS
 WITH latest AS (
         SELECT DISTINCT ON (s.mandate_instance_id) s.principal_id,
            s.project_id,
            s.id,
            s.mandate_instance_id,
            s.ledger,
            s.balance,
            s.pending,
            s.committed,
            s.spent,
            s.taken_at
           FROM ujira.mandate_state_snapshots s
          ORDER BY s.mandate_instance_id, s.ledger DESC
        ), accounts AS (
         SELECT a_1.mandate_instance_id,
            sum((a_1.balance)::numeric) FILTER (WHERE (a_1.kind = 'balance'::text)) AS balance,
            sum((a_1.balance)::numeric) FILTER (WHERE (a_1.kind = 'pending'::text)) AS pending,
            sum((a_1.balance)::numeric) FILTER (WHERE (a_1.kind = 'committed'::text)) AS committed,
            sum((a_1.balance)::numeric) FILTER (WHERE (a_1.kind = 'spent'::text)) AS spent,
            sum((a_1.balance)::numeric) FILTER (WHERE (a_1.kind = 'fee'::text)) AS fee
           FROM ujira.ledger_accounts a_1
          GROUP BY a_1.mandate_instance_id
        )
 SELECT l.principal_id,
    l.project_id,
    l.mandate_instance_id,
    l.ledger,
    l.taken_at,
    l.balance AS state_balance,
    COALESCE(a.balance, (0)::numeric) AS ledger_balance,
    l.pending AS state_pending,
    COALESCE(a.pending, (0)::numeric) AS ledger_pending,
    l.committed AS state_committed,
    COALESCE(a.committed, (0)::numeric) AS ledger_committed,
    l.spent AS state_spent,
    COALESCE(a.spent, (0)::numeric) AS ledger_spent,
    (((l.balance)::numeric = COALESCE(a.balance, (0)::numeric)) AND ((l.pending)::numeric = COALESCE(a.pending, (0)::numeric)) AND ((l.committed)::numeric = COALESCE(a.committed, (0)::numeric)) AND ((l.spent)::numeric = (COALESCE(a.spent, (0)::numeric) + COALESCE(a.fee, (0)::numeric)))) AS matches,
    COALESCE(a.fee, (0)::numeric) AS ledger_fee
   FROM (latest l
     LEFT JOIN accounts a ON ((a.mandate_instance_id = l.mandate_instance_id)));


ALTER VIEW ujira.ledger_reconciliation OWNER TO ujira_owner;

--
-- Name: leg_refunds; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.leg_refunds (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payout_leg_id uuid NOT NULL,
    payout_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    chain text NOT NULL,
    asset text NOT NULL,
    scale ujira.scale NOT NULL,
    amount ujira.amount NOT NULL,
    refund_to_address text NOT NULL,
    tx_hash ujira.hash32 NOT NULL,
    event_index bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT leg_refunds_address_length CHECK (((char_length(refund_to_address) >= 1) AND (char_length(refund_to_address) <= 128))),
    CONSTRAINT leg_refunds_amount_positive CHECK (((amount)::numeric > (0)::numeric)),
    CONSTRAINT leg_refunds_index_positive CHECK ((event_index >= 0))
);

ALTER TABLE ONLY ujira.leg_refunds FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.leg_refunds OWNER TO ujira_owner;

--
-- Name: managed_signers; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.managed_signers (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    network text NOT NULL,
    agent_id uuid NOT NULL,
    key_ref text NOT NULL,
    address text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    consented_by_member_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT managed_signers_address_format CHECK ((address ~ '^[A-Za-z0-9]{1,128}$'::text)),
    CONSTRAINT managed_signers_key_ref_format CHECK (((key_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$'::text) AND (key_ref !~ '//'::text) AND (key_ref !~ '^S[A-Z2-7]{55}$'::text))),
    CONSTRAINT managed_signers_network_format CHECK ((network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'::text)),
    CONSTRAINT managed_signers_status CHECK ((status = ANY (ARRAY['active'::text, 'retiring'::text, 'retired'::text])))
);

ALTER TABLE ONLY ujira.managed_signers FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.managed_signers OWNER TO ujira_owner;

--
-- Name: mandate_instance_roles; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.mandate_instance_roles (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    mandate_instance_id uuid NOT NULL,
    role text NOT NULL,
    address text NOT NULL,
    granted_event_id uuid NOT NULL,
    revoked_event_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mandate_instance_roles_address_length CHECK (((char_length(address) >= 1) AND (char_length(address) <= 128))),
    CONSTRAINT mandate_instance_roles_role CHECK ((role = ANY (ARRAY['agent'::text, 'approver'::text, 'guardian'::text, 'executor'::text, 'recovery'::text])))
);

ALTER TABLE ONLY ujira.mandate_instance_roles FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.mandate_instance_roles OWNER TO ujira_owner;

--
-- Name: mandate_instances; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.mandate_instances (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mandate_id uuid NOT NULL,
    chain text NOT NULL,
    contract_address text NOT NULL,
    spec_version text NOT NULL,
    asset text NOT NULL,
    scale ujira.scale NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attester_public_key bytea,
    country_policy_hash ujira.hash32,
    max_fee_bps bigint,
    fee_address text,
    CONSTRAINT mandate_instances_address_length CHECK (((char_length(contract_address) >= 1) AND (char_length(contract_address) <= 128))),
    CONSTRAINT mandate_instances_attester_key_length CHECK ((octet_length(attester_public_key) = 32)),
    CONSTRAINT mandate_instances_fee_address_length CHECK (((char_length(fee_address) >= 1) AND (char_length(fee_address) <= 128))),
    CONSTRAINT mandate_instances_max_fee_bps_range CHECK (((max_fee_bps >= 0) AND (max_fee_bps <= 100))),
    CONSTRAINT mandate_instances_spec_length CHECK (((char_length(spec_version) >= 1) AND (char_length(spec_version) <= 32)))
);

ALTER TABLE ONLY ujira.mandate_instances FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.mandate_instances OWNER TO ujira_owner;

--
-- Name: mandates; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.mandates (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    country_policy_mode text DEFAULT 'allow'::text NOT NULL,
    country_policy_list text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT mandates_country_policy_list CHECK (((cardinality(country_policy_list) <= 250) AND (array_position(country_policy_list, NULL::text) IS NULL) AND (array_to_string(country_policy_list, ','::text) ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'::text))),
    CONSTRAINT mandates_country_policy_mode CHECK ((country_policy_mode = ANY (ARRAY['allow'::text, 'deny'::text]))),
    CONSTRAINT mandates_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200)))
);

ALTER TABLE ONLY ujira.mandates FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.mandates OWNER TO ujira_owner;

--
-- Name: payout_attempts; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.payout_attempts (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payout_id uuid NOT NULL,
    attempt_number bigint NOT NULL,
    chain text NOT NULL,
    network ujira.network_id NOT NULL,
    mandate_instance_id uuid NOT NULL,
    total_amount ujira.amount NOT NULL,
    asset text NOT NULL,
    scale ujira.scale NOT NULL,
    on_chain_payout_id text,
    deadline timestamp with time zone NOT NULL,
    dead_proof jsonb,
    status text DEFAULT 'created'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fee_amount ujira.amount DEFAULT 0 NOT NULL,
    fee_bps_applied bigint DEFAULT 0 NOT NULL,
    fee_terms_id uuid,
    charged_amount ujira.amount,
    CONSTRAINT payout_attempts_chain_id_length CHECK (((char_length(on_chain_payout_id) >= 1) AND (char_length(on_chain_payout_id) <= 128))),
    CONSTRAINT payout_attempts_charged_is_total_plus_fee CHECK (((charged_amount IS NULL) OR ((charged_amount)::numeric = ((total_amount)::numeric + (fee_amount)::numeric)))),
    CONSTRAINT payout_attempts_charged_positive CHECK (((charged_amount IS NULL) OR ((charged_amount)::numeric > (0)::numeric))),
    CONSTRAINT payout_attempts_dead_has_proof CHECK (((status = 'dead'::text) = (dead_proof IS NOT NULL))),
    CONSTRAINT payout_attempts_fee_bps_range CHECK (((fee_bps_applied >= 0) AND (fee_bps_applied <= 100))),
    CONSTRAINT payout_attempts_fee_has_terms CHECK ((((fee_amount)::numeric = (0)::numeric) OR (fee_terms_id IS NOT NULL))),
    CONSTRAINT payout_attempts_fee_not_negative CHECK (((fee_amount)::numeric >= (0)::numeric)),
    CONSTRAINT payout_attempts_fee_within_cap CHECK (((fee_amount)::numeric <= ((div((total_amount)::numeric, (10000)::numeric) * (fee_bps_applied)::numeric) + div((mod((total_amount)::numeric, (10000)::numeric) * (fee_bps_applied)::numeric), (10000)::numeric)))),
    CONSTRAINT payout_attempts_network_on_chain CHECK ((split_part((network)::text, ':'::text, 1) = chain)),
    CONSTRAINT payout_attempts_number_range CHECK (((attempt_number >= 1) AND (attempt_number <= 1000000))),
    CONSTRAINT payout_attempts_proof_object CHECK (((dead_proof IS NULL) OR (jsonb_typeof(dead_proof) = 'object'::text))),
    CONSTRAINT payout_attempts_status CHECK ((status = ANY (ARRAY['created'::text, 'requested'::text, 'pending_approval'::text, 'approved'::text, 'executing'::text, 'settled'::text, 'final'::text, 'dead'::text]))),
    CONSTRAINT payout_attempts_total_positive CHECK (((total_amount)::numeric > (0)::numeric))
);

ALTER TABLE ONLY ujira.payout_attempts FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.payout_attempts OWNER TO ujira_owner;

--
-- Name: payout_batches; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.payout_batches (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idempotency_key text NOT NULL,
    request_hash ujira.hash32 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_batches_key_length CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 255)))
);

ALTER TABLE ONLY ujira.payout_batches FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.payout_batches OWNER TO ujira_owner;

--
-- Name: payout_funding_holds; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.payout_funding_holds (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    payout_id uuid NOT NULL,
    network ujira.network_id NOT NULL,
    chain text NOT NULL,
    mandate_instance_id uuid NOT NULL,
    needed_amount ujira.amount NOT NULL,
    asset text NOT NULL,
    scale ujira.scale NOT NULL,
    held_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_funding_holds_needed_positive CHECK (((needed_amount)::numeric > (0)::numeric)),
    CONSTRAINT payout_funding_holds_network_on_chain CHECK ((split_part((network)::text, ':'::text, 1) = chain))
);

ALTER TABLE ONLY ujira.payout_funding_holds FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.payout_funding_holds OWNER TO ujira_owner;

--
-- Name: payout_legs; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.payout_legs (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payout_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    leg_index bigint NOT NULL,
    payout_method_id uuid NOT NULL,
    method text NOT NULL,
    destination_address text NOT NULL,
    destination_tag ujira.u64,
    amount ujira.amount NOT NULL,
    chain text NOT NULL,
    asset text NOT NULL,
    scale ujira.scale NOT NULL,
    fee_amount ujira.amount DEFAULT 0 NOT NULL,
    leg_key text DEFAULT ''::text NOT NULL,
    chain_tx_hash text,
    status text DEFAULT 'planned'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_legs_address_length CHECK (((char_length(destination_address) >= 1) AND (char_length(destination_address) <= 128))),
    CONSTRAINT payout_legs_amount_positive CHECK (((amount)::numeric > (0)::numeric)),
    CONSTRAINT payout_legs_fee_not_negative CHECK (((fee_amount)::numeric >= (0)::numeric)),
    CONSTRAINT payout_legs_index_range CHECK (((leg_index >= 0) AND (leg_index <= 3))),
    CONSTRAINT payout_legs_key_format CHECK ((leg_key ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT payout_legs_method CHECK ((method = ANY (ARRAY['stellar_wallet'::text, 'bank'::text, 'mobile_money'::text, 'cash_pickup'::text]))),
    CONSTRAINT payout_legs_status CHECK ((status = ANY (ARRAY['planned'::text, 'submitted'::text, 'settled'::text, 'delivering'::text, 'delivered'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT payout_legs_tag_chain CHECK (((destination_tag IS NULL) OR (chain = 'stellar'::text))),
    CONSTRAINT payout_legs_tx_hash_length CHECK (((char_length(chain_tx_hash) >= 1) AND (char_length(chain_tx_hash) <= 128)))
);

ALTER TABLE ONLY ujira.payout_legs FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.payout_legs OWNER TO ujira_owner;

--
-- Name: payout_methods; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.payout_methods (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_id uuid NOT NULL,
    method text NOT NULL,
    rail text NOT NULL,
    chain text NOT NULL,
    destination_address text NOT NULL,
    has_tag boolean DEFAULT false NOT NULL,
    destination_tag ujira.u64,
    details_ciphertext bytea,
    details_nonce bytea,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_methods_address_length CHECK (((char_length(destination_address) >= 1) AND (char_length(destination_address) <= 128))),
    CONSTRAINT payout_methods_details_whole CHECK (((details_ciphertext IS NULL) = (details_nonce IS NULL))),
    CONSTRAINT payout_methods_method CHECK ((method = ANY (ARRAY['stellar_wallet'::text, 'bank'::text, 'mobile_money'::text, 'cash_pickup'::text]))),
    CONSTRAINT payout_methods_nonce_length CHECK ((octet_length(details_nonce) = 12)),
    CONSTRAINT payout_methods_rail CHECK ((rail = ANY (ARRAY['wallet'::text, 'anchor'::text]))),
    CONSTRAINT payout_methods_status CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
    CONSTRAINT payout_methods_tag_canonical CHECK ((has_tag = (destination_tag IS NOT NULL))),
    CONSTRAINT payout_methods_tag_chain CHECK (((NOT has_tag) OR (chain = 'stellar'::text)))
);

ALTER TABLE ONLY ujira.payout_methods FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.payout_methods OWNER TO ujira_owner;

--
-- Name: payouts; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.payouts (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid,
    idempotency_key text NOT NULL,
    request_hash ujira.hash32 NOT NULL,
    recipient_id uuid NOT NULL,
    mandate_id uuid NOT NULL,
    method text NOT NULL,
    cashout_cost_bearer text NOT NULL,
    requested_amount ujira.amount NOT NULL,
    requested_asset text,
    requested_chain text,
    requested_token_scale ujira.scale,
    requested_currency text,
    requested_currency_scale ujira.scale,
    total_amount ujira.amount,
    total_asset text,
    total_chain text,
    total_scale ujira.scale,
    status text DEFAULT 'received'::text NOT NULL,
    public_status text GENERATED ALWAYS AS (
CASE status
    WHEN 'received'::text THEN 'queued'::text
    WHEN 'routed'::text THEN 'submitting'::text
    ELSE status
END) STORED NOT NULL,
    status_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payouts_cashout_cost_bearer CHECK ((cashout_cost_bearer = ANY (ARRAY['recipient'::text, 'principal'::text]))),
    CONSTRAINT payouts_key_length CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 255))),
    CONSTRAINT payouts_method CHECK ((method = ANY (ARRAY['stellar_wallet'::text, 'bank'::text, 'mobile_money'::text, 'cash_pickup'::text]))),
    CONSTRAINT payouts_requested_positive CHECK (((requested_amount)::numeric > (0)::numeric)),
    CONSTRAINT payouts_requested_unit CHECK ((((cashout_cost_bearer = 'recipient'::text) AND (num_nonnulls(requested_asset, requested_chain, requested_token_scale) = 3) AND (num_nonnulls(requested_currency, requested_currency_scale) = 0)) OR ((cashout_cost_bearer = 'principal'::text) AND (num_nonnulls(requested_asset, requested_chain, requested_token_scale) = 0) AND (num_nonnulls(requested_currency, requested_currency_scale) = 2)))),
    CONSTRAINT payouts_status CHECK ((status = ANY (ARRAY['received'::text, 'routed'::text, 'submitting'::text, 'pending_approval'::text, 'approved'::text, 'settling'::text, 'delivering'::text, 'partly_paid'::text, 'paid'::text, 'needs_attention'::text, 'blocked'::text, 'rejected'::text, 'cancelled'::text, 'failed'::text]))),
    CONSTRAINT payouts_status_reason CHECK (((status_reason IS NULL) OR ((status_reason = ANY (ARRAY['awaiting_funding'::text, 'network_unavailable'::text])) AND (status = 'received'::text)) OR ((status_reason = 'funding_hold_expired'::text) AND (status = 'failed'::text)))),
    CONSTRAINT payouts_total_positive CHECK (((total_amount)::numeric > (0)::numeric)),
    CONSTRAINT payouts_total_whole CHECK ((num_nonnulls(total_amount, total_asset, total_chain, total_scale) = ANY (ARRAY[0, 4])))
);

ALTER TABLE ONLY ujira.payouts FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.payouts OWNER TO ujira_owner;

--
-- Name: principal_members; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.principal_members (
    principal_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT principal_members_role CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'developer'::text, 'viewer'::text])))
);

ALTER TABLE ONLY ujira.principal_members FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.principal_members OWNER TO ujira_owner;

--
-- Name: principals; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.principals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    reporting_time_zone text DEFAULT 'UTC'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT principals_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200)))
);

ALTER TABLE ONLY ujira.principals FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.principals OWNER TO ujira_owner;

--
-- Name: project_payout_minimums; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.project_payout_minimums (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    method text NOT NULL,
    currency text NOT NULL,
    scale ujira.scale NOT NULL,
    min_amount ujira.amount NOT NULL,
    set_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_payout_minimums_method CHECK ((method = ANY (ARRAY['stellar_wallet'::text, 'bank'::text, 'mobile_money'::text, 'cash_pickup'::text]))),
    CONSTRAINT project_payout_minimums_positive CHECK (((min_amount)::numeric > (0)::numeric))
);

ALTER TABLE ONLY ujira.project_payout_minimums FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.project_payout_minimums OWNER TO ujira_owner;

--
-- Name: projects; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.projects (
    principal_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    chain_fallback text DEFAULT 'off'::text NOT NULL,
    funding_hold_max_seconds bigint DEFAULT 1209600 NOT NULL,
    cashout_cost_bearer text DEFAULT 'recipient'::text NOT NULL,
    CONSTRAINT projects_cashout_cost_bearer CHECK ((cashout_cost_bearer = ANY (ARRAY['recipient'::text, 'principal'::text]))),
    CONSTRAINT projects_chain_fallback CHECK ((chain_fallback = ANY (ARRAY['off'::text, 'verified_methods'::text]))),
    CONSTRAINT projects_funding_hold_range CHECK (((funding_hold_max_seconds >= 3600) AND (funding_hold_max_seconds <= 2592000))),
    CONSTRAINT projects_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200)))
);

ALTER TABLE ONLY ujira.projects FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.projects OWNER TO ujira_owner;

--
-- Name: receipt_legs; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.receipt_legs (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    leg_index bigint NOT NULL,
    destination_masked text NOT NULL,
    destination_tag ujira.u64,
    amount ujira.amount NOT NULL,
    fee_amount ujira.amount DEFAULT 0 NOT NULL,
    chain text NOT NULL,
    asset text NOT NULL,
    scale ujira.scale NOT NULL,
    chain_receipt_ref text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT receipt_legs_amount_positive CHECK (((amount)::numeric > (0)::numeric)),
    CONSTRAINT receipt_legs_fee_not_negative CHECK (((fee_amount)::numeric >= (0)::numeric)),
    CONSTRAINT receipt_legs_masked_length CHECK (((char_length(destination_masked) >= 1) AND (char_length(destination_masked) <= 32))),
    CONSTRAINT receipt_legs_ref_length CHECK (((char_length(chain_receipt_ref) >= 1) AND (char_length(chain_receipt_ref) <= 512))),
    CONSTRAINT receipt_legs_tag_chain CHECK (((destination_tag IS NULL) OR (chain = 'stellar'::text)))
);

ALTER TABLE ONLY ujira.receipt_legs FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.receipt_legs OWNER TO ujira_owner;

--
-- Name: receipts; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.receipts (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payout_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    revision bigint NOT NULL,
    receipt_number text NOT NULL,
    network ujira.network_id NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    chain_receipt_ref text NOT NULL,
    chain text NOT NULL,
    asset text NOT NULL,
    scale ujira.scale NOT NULL,
    settlement_amount ujira.amount NOT NULL,
    fee_amount ujira.amount DEFAULT 0 NOT NULL,
    canonical_document text NOT NULL,
    document_sha256 ujira.hash32 NOT NULL,
    supersedes_sha256 ujira.hash32,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    take_rate_amount ujira.amount DEFAULT 0 NOT NULL,
    take_rate_bps bigint DEFAULT 0 NOT NULL,
    take_rate_refunded_amount ujira.amount DEFAULT 0 NOT NULL,
    charged_amount ujira.amount,
    CONSTRAINT receipts_charged_is_settlement_plus_take CHECK (((charged_amount IS NULL) OR ((charged_amount)::numeric = ((settlement_amount)::numeric + (take_rate_amount)::numeric)))),
    CONSTRAINT receipts_document_present CHECK ((char_length(canonical_document) > 0)),
    CONSTRAINT receipts_fee_not_negative CHECK (((fee_amount)::numeric >= (0)::numeric)),
    CONSTRAINT receipts_network_on_chain CHECK ((split_part((network)::text, ':'::text, 1) = chain)),
    CONSTRAINT receipts_number_format CHECK ((receipt_number ~ '^R-[0-9A-Z]{12}$'::text)),
    CONSTRAINT receipts_ref_length CHECK (((char_length(chain_receipt_ref) >= 1) AND (char_length(chain_receipt_ref) <= 512))),
    CONSTRAINT receipts_revision_range CHECK (((revision >= 1) AND (revision <= 1000000))),
    CONSTRAINT receipts_settlement_positive CHECK (((settlement_amount)::numeric > (0)::numeric)),
    CONSTRAINT receipts_supersedes_after_first CHECK (((revision = 1) = (supersedes_sha256 IS NULL))),
    CONSTRAINT receipts_take_rate_bps_range CHECK (((take_rate_bps >= 0) AND (take_rate_bps <= 100))),
    CONSTRAINT receipts_take_rate_not_negative CHECK (((take_rate_amount)::numeric >= (0)::numeric)),
    CONSTRAINT receipts_take_rate_refund_within CHECK ((((take_rate_refunded_amount)::numeric >= (0)::numeric) AND ((take_rate_refunded_amount)::numeric <= (take_rate_amount)::numeric)))
);

ALTER TABLE ONLY ujira.receipts FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.receipts OWNER TO ujira_owner;

--
-- Name: recipient_identities; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.recipient_identities (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_id uuid NOT NULL,
    chain text,
    provider text NOT NULL,
    provider_ref text,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_account text,
    provider_subject text,
    provider_status text,
    assurance text DEFAULT 'none'::text NOT NULL,
    flow_ref text,
    nullifier_hmac ujira.hash32,
    pending_session_id text,
    pending_session_url text,
    pending_session_expires_at timestamp with time zone,
    failure_reason text,
    raw_sha256 ujira.hash32,
    last_checked_at timestamp with time zone,
    expires_at timestamp with time zone,
    CONSTRAINT recipient_identities_account_length CHECK (((char_length(provider_account) >= 1) AND (char_length(provider_account) <= 128))),
    CONSTRAINT recipient_identities_assurance CHECK ((assurance = ANY (ARRAY['anchor_kyc'::text, 'document_zk'::text, 'principal_kyc'::text, 'none'::text]))),
    CONSTRAINT recipient_identities_failure_length CHECK (((char_length(failure_reason) >= 1) AND (char_length(failure_reason) <= 64))),
    CONSTRAINT recipient_identities_flow_length CHECK (((char_length(flow_ref) >= 1) AND (char_length(flow_ref) <= 200))),
    CONSTRAINT recipient_identities_provider_length CHECK (((char_length(provider) >= 1) AND (char_length(provider) <= 64))),
    CONSTRAINT recipient_identities_ref_length CHECK (((char_length(provider_ref) >= 1) AND (char_length(provider_ref) <= 128))),
    CONSTRAINT recipient_identities_session_length CHECK (((char_length(pending_session_id) >= 1) AND (char_length(pending_session_id) <= 128))),
    CONSTRAINT recipient_identities_session_url_length CHECK (((char_length(pending_session_url) >= 1) AND (char_length(pending_session_url) <= 2048))),
    CONSTRAINT recipient_identities_state CHECK ((state = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text, 'expired'::text, 'revoked'::text]))),
    CONSTRAINT recipient_identities_status_length CHECK (((char_length(provider_status) >= 1) AND (char_length(provider_status) <= 64))),
    CONSTRAINT recipient_identities_subject_length CHECK (((char_length(provider_subject) >= 1) AND (char_length(provider_subject) <= 128)))
);

ALTER TABLE ONLY ujira.recipient_identities FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.recipient_identities OWNER TO ujira_owner;

--
-- Name: recipient_pii; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.recipient_pii (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recipient_pii_nonce_length CHECK ((octet_length(nonce) = 12))
);

ALTER TABLE ONLY ujira.recipient_pii FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.recipient_pii OWNER TO ujira_owner;

--
-- Name: recipients; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.recipients (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_ref ujira.hash32 NOT NULL,
    country text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recipients_country_format CHECK ((country ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT recipients_status CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'erased'::text])))
);

ALTER TABLE ONLY ujira.recipients FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.recipients OWNER TO ujira_owner;

--
-- Name: settlement_tokens; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.settlement_tokens (
    asset text NOT NULL,
    chain text NOT NULL,
    token_scale ujira.scale NOT NULL,
    display_scale ujira.scale NOT NULL,
    CONSTRAINT settlement_tokens_asset_format CHECK ((asset ~ '^[A-Z][A-Z0-9]{1,11}$'::text))
);


ALTER TABLE ujira.settlement_tokens OWNER TO ujira_owner;

--
-- Name: status_transitions; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.status_transitions (
    machine text NOT NULL,
    from_status text NOT NULL,
    to_status text NOT NULL,
    CONSTRAINT status_transitions_machine_format CHECK ((machine ~ '^[a-z][a-z0-9_]*$'::text))
);


ALTER TABLE ujira.status_transitions OWNER TO ujira_owner;

--
-- Name: ujira_migrations id; Type: DEFAULT; Schema: public; Owner: test
--

ALTER TABLE ONLY public.ujira_migrations ALTER COLUMN id SET DEFAULT nextval('public.ujira_migrations_id_seq'::regclass);


--
-- Name: chain_cursors chain_cursors_pkey; Type: CONSTRAINT; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ONLY ops.chain_cursors
    ADD CONSTRAINT chain_cursors_pkey PRIMARY KEY (network);


--
-- Name: executor_accounts executor_accounts_pkey; Type: CONSTRAINT; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ONLY ops.executor_accounts
    ADD CONSTRAINT executor_accounts_pkey PRIMARY KEY (network, account_ref);


--
-- Name: fee_estimates fee_estimates_pkey; Type: CONSTRAINT; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ONLY ops.fee_estimates
    ADD CONSTRAINT fee_estimates_pkey PRIMARY KEY (network, op, leg_count);


--
-- Name: identity_provider_events identity_provider_events_pkey; Type: CONSTRAINT; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ONLY ops.identity_provider_events
    ADD CONSTRAINT identity_provider_events_pkey PRIMARY KEY (provider, provider_account, event_key);


--
-- Name: routing_config_active routing_config_active_pkey; Type: CONSTRAINT; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ONLY ops.routing_config_active
    ADD CONSTRAINT routing_config_active_pkey PRIMARY KEY (only_row);


--
-- Name: routing_config_versions routing_config_versions_pkey; Type: CONSTRAINT; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ONLY ops.routing_config_versions
    ADD CONSTRAINT routing_config_versions_pkey PRIMARY KEY (version);


--
-- Name: signing_keys signing_keys_pkey; Type: CONSTRAINT; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ONLY ops.signing_keys
    ADD CONSTRAINT signing_keys_pkey PRIMARY KEY (id);


--
-- Name: ujira_migrations ujira_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: test
--

ALTER TABLE ONLY public.ujira_migrations
    ADD CONSTRAINT ujira_migrations_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_prefix_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.api_tokens
    ADD CONSTRAINT api_tokens_prefix_key UNIQUE (prefix);


--
-- Name: api_tokens api_tokens_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.api_tokens
    ADD CONSTRAINT api_tokens_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: approvals approvals_per_approver; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.approvals
    ADD CONSTRAINT approvals_per_approver UNIQUE (principal_id, project_id, attempt_id, approver);


--
-- Name: approvals approvals_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);


--
-- Name: audit_heads audit_heads_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.audit_heads
    ADD CONSTRAINT audit_heads_pkey PRIMARY KEY (principal_id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_seq; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.audit_log
    ADD CONSTRAINT audit_log_seq UNIQUE (principal_id, seq);


--
-- Name: audit_metadata_keys audit_metadata_keys_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.audit_metadata_keys
    ADD CONSTRAINT audit_metadata_keys_pkey PRIMARY KEY (key);


--
-- Name: chain_events chain_events_once; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.chain_events
    ADD CONSTRAINT chain_events_once UNIQUE (chain, tx_hash, event_index);


--
-- Name: chain_events chain_events_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.chain_events
    ADD CONSTRAINT chain_events_pkey PRIMARY KEY (id);


--
-- Name: chain_events chain_events_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.chain_events
    ADD CONSTRAINT chain_events_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: chains chains_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.chains
    ADD CONSTRAINT chains_pkey PRIMARY KEY (code);


--
-- Name: currencies currencies_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.currencies
    ADD CONSTRAINT currencies_pkey PRIMARY KEY (code);


--
-- Name: currency_scales currency_scales_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.currency_scales
    ADD CONSTRAINT currency_scales_pkey PRIMARY KEY (currency, scale);


--
-- Name: data_keys data_keys_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.data_keys
    ADD CONSTRAINT data_keys_pkey PRIMARY KEY (principal_id, project_id, subject_id);


--
-- Name: deposits deposits_per_event; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.deposits
    ADD CONSTRAINT deposits_per_event UNIQUE (principal_id, project_id, chain_event_id);


--
-- Name: deposits deposits_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.deposits
    ADD CONSTRAINT deposits_pkey PRIMARY KEY (id);


--
-- Name: deposits deposits_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.deposits
    ADD CONSTRAINT deposits_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: erasure_log erasure_log_once; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.erasure_log
    ADD CONSTRAINT erasure_log_once UNIQUE (principal_id, project_id, erasure_id, event);


--
-- Name: erasure_log erasure_log_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.erasure_log
    ADD CONSTRAINT erasure_log_pkey PRIMARY KEY (id);


--
-- Name: fee_reconciliations fee_reconciliations_per_revision; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.fee_reconciliations
    ADD CONSTRAINT fee_reconciliations_per_revision UNIQUE (principal_id, project_id, attempt_id, revision);


--
-- Name: fee_reconciliations fee_reconciliations_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.fee_reconciliations
    ADD CONSTRAINT fee_reconciliations_pkey PRIMARY KEY (id);


--
-- Name: fee_refunds fee_refunds_once; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.fee_refunds
    ADD CONSTRAINT fee_refunds_once UNIQUE (principal_id, project_id, idempotency_key);


--
-- Name: fee_refunds fee_refunds_one_per_leg_refund; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.fee_refunds
    ADD CONSTRAINT fee_refunds_one_per_leg_refund UNIQUE (principal_id, project_id, leg_refund_id);


--
-- Name: fee_refunds fee_refunds_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.fee_refunds
    ADD CONSTRAINT fee_refunds_pkey PRIMARY KEY (id);


--
-- Name: fee_terms fee_terms_per_instant; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.fee_terms
    ADD CONSTRAINT fee_terms_per_instant UNIQUE (principal_id, project_id, valid_from);


--
-- Name: fee_terms fee_terms_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.fee_terms
    ADD CONSTRAINT fee_terms_pkey PRIMARY KEY (id);


--
-- Name: fee_terms fee_terms_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.fee_terms
    ADD CONSTRAINT fee_terms_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: funding_sources funding_sources_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_sources
    ADD CONSTRAINT funding_sources_pkey PRIMARY KEY (id);


--
-- Name: funding_sources funding_sources_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_sources
    ADD CONSTRAINT funding_sources_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: funding_sweeps funding_sweeps_once; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_sweeps
    ADD CONSTRAINT funding_sweeps_once UNIQUE (chain, deposit_operation_id);


--
-- Name: funding_sweeps funding_sweeps_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_sweeps
    ADD CONSTRAINT funding_sweeps_pkey PRIMARY KEY (id);


--
-- Name: funding_sweeps funding_sweeps_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_sweeps
    ADD CONSTRAINT funding_sweeps_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: ledger_accounts ledger_accounts_per_kind; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_accounts
    ADD CONSTRAINT ledger_accounts_per_kind UNIQUE (principal_id, project_id, mandate_instance_id, kind);


--
-- Name: ledger_accounts ledger_accounts_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_accounts
    ADD CONSTRAINT ledger_accounts_pkey PRIMARY KEY (id);


--
-- Name: ledger_accounts ledger_accounts_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_accounts
    ADD CONSTRAINT ledger_accounts_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: ledger_entries ledger_entries_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_entries
    ADD CONSTRAINT ledger_entries_pkey PRIMARY KEY (id);


--
-- Name: ledger_entries ledger_entries_seq; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_entries
    ADD CONSTRAINT ledger_entries_seq UNIQUE (account_id, account_seq);


--
-- Name: ledger_journals ledger_journals_per_event; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_journals
    ADD CONSTRAINT ledger_journals_per_event UNIQUE (principal_id, project_id, chain_event_id);


--
-- Name: ledger_journals ledger_journals_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_journals
    ADD CONSTRAINT ledger_journals_pkey PRIMARY KEY (id);


--
-- Name: ledger_journals ledger_journals_reversed_once; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_journals
    ADD CONSTRAINT ledger_journals_reversed_once UNIQUE (principal_id, project_id, reverses_journal_id);


--
-- Name: ledger_journals ledger_journals_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_journals
    ADD CONSTRAINT ledger_journals_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: leg_refunds leg_refunds_fee_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.leg_refunds
    ADD CONSTRAINT leg_refunds_fee_key UNIQUE (principal_id, project_id, id, payout_id, attempt_id, chain, asset, scale);


--
-- Name: leg_refunds leg_refunds_once; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.leg_refunds
    ADD CONSTRAINT leg_refunds_once UNIQUE (chain, tx_hash, event_index);


--
-- Name: leg_refunds leg_refunds_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.leg_refunds
    ADD CONSTRAINT leg_refunds_pkey PRIMARY KEY (id);


--
-- Name: leg_refunds leg_refunds_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.leg_refunds
    ADD CONSTRAINT leg_refunds_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: managed_signers managed_signers_address_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.managed_signers
    ADD CONSTRAINT managed_signers_address_key UNIQUE (network, address);


--
-- Name: managed_signers managed_signers_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.managed_signers
    ADD CONSTRAINT managed_signers_pkey PRIMARY KEY (id);


--
-- Name: managed_signers managed_signers_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.managed_signers
    ADD CONSTRAINT managed_signers_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: mandate_instance_roles mandate_instance_roles_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instance_roles
    ADD CONSTRAINT mandate_instance_roles_pkey PRIMARY KEY (principal_id, project_id, mandate_instance_id, role, address);


--
-- Name: mandate_instances mandate_instances_address_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instances
    ADD CONSTRAINT mandate_instances_address_key UNIQUE (chain, contract_address);


--
-- Name: mandate_instances mandate_instances_chain_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instances
    ADD CONSTRAINT mandate_instances_chain_key UNIQUE (principal_id, project_id, id, chain);


--
-- Name: mandate_instances mandate_instances_per_asset; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instances
    ADD CONSTRAINT mandate_instances_per_asset UNIQUE (principal_id, project_id, mandate_id, chain, asset);


--
-- Name: mandate_instances mandate_instances_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instances
    ADD CONSTRAINT mandate_instances_pkey PRIMARY KEY (id);


--
-- Name: mandate_instances mandate_instances_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instances
    ADD CONSTRAINT mandate_instances_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: mandate_instances mandate_instances_unit_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instances
    ADD CONSTRAINT mandate_instances_unit_key UNIQUE (principal_id, project_id, id, chain, asset, scale);


--
-- Name: mandate_state_snapshots mandate_state_snapshots_per_ledger; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_state_snapshots
    ADD CONSTRAINT mandate_state_snapshots_per_ledger UNIQUE (principal_id, project_id, mandate_instance_id, ledger);


--
-- Name: mandate_state_snapshots mandate_state_snapshots_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_state_snapshots
    ADD CONSTRAINT mandate_state_snapshots_pkey PRIMARY KEY (id);


--
-- Name: mandates mandates_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandates
    ADD CONSTRAINT mandates_pkey PRIMARY KEY (id);


--
-- Name: mandates mandates_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandates
    ADD CONSTRAINT mandates_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: payout_attempts payout_attempts_chain_id; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_attempts
    ADD CONSTRAINT payout_attempts_chain_id UNIQUE (principal_id, project_id, mandate_instance_id, on_chain_payout_id);


--
-- Name: payout_attempts payout_attempts_leg_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_attempts
    ADD CONSTRAINT payout_attempts_leg_key UNIQUE (principal_id, project_id, payout_id, id, chain, asset, scale);


--
-- Name: payout_attempts payout_attempts_number; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_attempts
    ADD CONSTRAINT payout_attempts_number UNIQUE (principal_id, project_id, payout_id, attempt_number);


--
-- Name: payout_attempts payout_attempts_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_attempts
    ADD CONSTRAINT payout_attempts_pkey PRIMARY KEY (id);


--
-- Name: payout_attempts payout_attempts_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_attempts
    ADD CONSTRAINT payout_attempts_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: payout_batches payout_batches_idempotency; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_batches
    ADD CONSTRAINT payout_batches_idempotency UNIQUE (principal_id, project_id, idempotency_key);


--
-- Name: payout_batches payout_batches_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_batches
    ADD CONSTRAINT payout_batches_pkey PRIMARY KEY (id);


--
-- Name: payout_batches payout_batches_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_batches
    ADD CONSTRAINT payout_batches_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: payout_funding_holds payout_funding_holds_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_funding_holds
    ADD CONSTRAINT payout_funding_holds_pkey PRIMARY KEY (principal_id, project_id, payout_id, network);


--
-- Name: payout_legs payout_legs_per_attempt; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_legs
    ADD CONSTRAINT payout_legs_per_attempt UNIQUE (principal_id, project_id, attempt_id, leg_index);


--
-- Name: payout_legs payout_legs_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_legs
    ADD CONSTRAINT payout_legs_pkey PRIMARY KEY (id);


--
-- Name: payout_legs payout_legs_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_legs
    ADD CONSTRAINT payout_legs_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: payout_methods payout_methods_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_methods
    ADD CONSTRAINT payout_methods_pkey PRIMARY KEY (id);


--
-- Name: payout_methods payout_methods_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_methods
    ADD CONSTRAINT payout_methods_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: payouts payouts_idempotency; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payouts
    ADD CONSTRAINT payouts_idempotency UNIQUE (principal_id, project_id, idempotency_key);


--
-- Name: payouts payouts_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payouts
    ADD CONSTRAINT payouts_pkey PRIMARY KEY (id);


--
-- Name: payouts payouts_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payouts
    ADD CONSTRAINT payouts_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: principal_members principal_members_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.principal_members
    ADD CONSTRAINT principal_members_pkey PRIMARY KEY (principal_id, user_id);


--
-- Name: principals principals_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.principals
    ADD CONSTRAINT principals_pkey PRIMARY KEY (id);


--
-- Name: project_payout_minimums project_payout_minimums_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.project_payout_minimums
    ADD CONSTRAINT project_payout_minimums_pkey PRIMARY KEY (principal_id, project_id, method, currency);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: projects projects_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.projects
    ADD CONSTRAINT projects_tenant_key UNIQUE (principal_id, id);


--
-- Name: receipt_legs receipt_legs_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.receipt_legs
    ADD CONSTRAINT receipt_legs_pkey PRIMARY KEY (principal_id, project_id, receipt_id, leg_index);


--
-- Name: receipts receipts_leg_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.receipts
    ADD CONSTRAINT receipts_leg_key UNIQUE (principal_id, project_id, id, attempt_id, chain, asset, scale);


--
-- Name: receipts receipts_number; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.receipts
    ADD CONSTRAINT receipts_number UNIQUE (principal_id, project_id, receipt_number);


--
-- Name: receipts receipts_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (id);


--
-- Name: receipts receipts_revision; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.receipts
    ADD CONSTRAINT receipts_revision UNIQUE (principal_id, project_id, payout_id, revision);


--
-- Name: receipts receipts_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.receipts
    ADD CONSTRAINT receipts_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: recipient_identities recipient_identities_per_chain; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.recipient_identities
    ADD CONSTRAINT recipient_identities_per_chain UNIQUE (principal_id, project_id, recipient_id, chain, provider);


--
-- Name: recipient_identities recipient_identities_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.recipient_identities
    ADD CONSTRAINT recipient_identities_pkey PRIMARY KEY (id);


--
-- Name: recipient_pii recipient_pii_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.recipient_pii
    ADD CONSTRAINT recipient_pii_pkey PRIMARY KEY (principal_id, project_id, recipient_id);


--
-- Name: recipients recipients_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.recipients
    ADD CONSTRAINT recipients_pkey PRIMARY KEY (id);


--
-- Name: recipients recipients_ref_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.recipients
    ADD CONSTRAINT recipients_ref_key UNIQUE (principal_id, project_id, recipient_ref);


--
-- Name: recipients recipients_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.recipients
    ADD CONSTRAINT recipients_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: settlement_tokens settlement_tokens_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.settlement_tokens
    ADD CONSTRAINT settlement_tokens_pkey PRIMARY KEY (asset, chain);


--
-- Name: settlement_tokens settlement_tokens_scale_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.settlement_tokens
    ADD CONSTRAINT settlement_tokens_scale_key UNIQUE (asset, chain, token_scale);


--
-- Name: status_transitions status_transitions_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.status_transitions
    ADD CONSTRAINT status_transitions_pkey PRIMARY KEY (machine, from_status, to_status);


--
-- Name: signing_keys_one_active; Type: INDEX; Schema: ops; Owner: ujira_owner
--

CREATE UNIQUE INDEX signing_keys_one_active ON ops.signing_keys USING btree (purpose, COALESCE(network, ''::text), COALESCE(anchor_id, ''::text), key_ref) WHERE (status = 'active'::text);


--
-- Name: chain_events_by_instance; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX chain_events_by_instance ON ujira.chain_events USING btree (principal_id, project_id, mandate_instance_id, ledger, event_index);


--
-- Name: deposits_by_instance; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX deposits_by_instance ON ujira.deposits USING btree (principal_id, project_id, mandate_instance_id, created_at);


--
-- Name: erasure_log_by_subject; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX erasure_log_by_subject ON ujira.erasure_log USING btree (principal_id, project_id, subject_id);


--
-- Name: erasure_log_completed; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX erasure_log_completed ON ujira.erasure_log USING btree (id) WHERE (event = 'completed'::text);


--
-- Name: fee_reconciliations_by_attempt_unit; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX fee_reconciliations_by_attempt_unit ON ujira.fee_reconciliations USING btree (principal_id, project_id, payout_id, attempt_id, chain, asset, scale);


--
-- Name: fee_reconciliations_by_payout; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX fee_reconciliations_by_payout ON ujira.fee_reconciliations USING btree (principal_id, project_id, payout_id);


--
-- Name: fee_refunds_by_attempt; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX fee_refunds_by_attempt ON ujira.fee_refunds USING btree (principal_id, project_id, attempt_id);


--
-- Name: fee_refunds_open_by_due; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX fee_refunds_open_by_due ON ujira.fee_refunds USING btree (due_at, id) WHERE (status = ANY (ARRAY['owed'::text, 'awaiting_signatures'::text, 'failed'::text]));


--
-- Name: funding_sweeps_by_instance; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX funding_sweeps_by_instance ON ujira.funding_sweeps USING btree (principal_id, project_id, mandate_instance_id, created_at);


--
-- Name: ledger_entries_by_journal; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX ledger_entries_by_journal ON ujira.ledger_entries USING btree (principal_id, project_id, journal_id);


--
-- Name: leg_refunds_by_attempt; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX leg_refunds_by_attempt ON ujira.leg_refunds USING btree (principal_id, project_id, payout_id, attempt_id, chain, asset, scale);


--
-- Name: leg_refunds_by_leg; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX leg_refunds_by_leg ON ujira.leg_refunds USING btree (principal_id, project_id, payout_leg_id);


--
-- Name: managed_signers_one_active; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE UNIQUE INDEX managed_signers_one_active ON ujira.managed_signers USING btree (principal_id, project_id, agent_id, network) WHERE (status = 'active'::text);


--
-- Name: payout_attempts_one_live; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE UNIQUE INDEX payout_attempts_one_live ON ujira.payout_attempts USING btree (principal_id, project_id, payout_id) WHERE (status <> 'dead'::text);


--
-- Name: payout_funding_holds_release; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX payout_funding_holds_release ON ujira.payout_funding_holds USING btree (principal_id, project_id, network, held_at);


--
-- Name: payout_legs_by_key; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX payout_legs_by_key ON ujira.payout_legs USING btree (principal_id, project_id, leg_key);


--
-- Name: payout_legs_by_method; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX payout_legs_by_method ON ujira.payout_legs USING btree (principal_id, project_id, payout_method_id);


--
-- Name: payout_legs_by_payout; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX payout_legs_by_payout ON ujira.payout_legs USING btree (principal_id, project_id, payout_id);


--
-- Name: payout_legs_destination_identity; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE UNIQUE INDEX payout_legs_destination_identity ON ujira.payout_legs USING btree (principal_id, project_id, attempt_id, destination_address, destination_tag) NULLS NOT DISTINCT;


--
-- Name: payout_methods_by_recipient; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX payout_methods_by_recipient ON ujira.payout_methods USING btree (principal_id, project_id, recipient_id);


--
-- Name: payout_methods_destination_identity; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE UNIQUE INDEX payout_methods_destination_identity ON ujira.payout_methods USING btree (principal_id, chain, destination_address, destination_tag) NULLS NOT DISTINCT WHERE (status = 'active'::text);


--
-- Name: payouts_by_batch; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX payouts_by_batch ON ujira.payouts USING btree (principal_id, project_id, batch_id) WHERE (batch_id IS NOT NULL);


--
-- Name: payouts_by_mandate; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX payouts_by_mandate ON ujira.payouts USING btree (principal_id, project_id, mandate_id);


--
-- Name: payouts_by_recipient; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX payouts_by_recipient ON ujira.payouts USING btree (principal_id, project_id, recipient_id);


--
-- Name: payouts_by_status; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX payouts_by_status ON ujira.payouts USING btree (principal_id, project_id, public_status, id);


--
-- Name: receipt_legs_by_leg; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX receipt_legs_by_leg ON ujira.receipt_legs USING btree (principal_id, project_id, attempt_id, leg_index);


--
-- Name: receipts_by_attempt; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX receipts_by_attempt ON ujira.receipts USING btree (principal_id, project_id, attempt_id);


--
-- Name: recipient_identities_one_per_provider; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE UNIQUE INDEX recipient_identities_one_per_provider ON ujira.recipient_identities USING btree (principal_id, project_id, recipient_id, provider, provider_account) NULLS NOT DISTINCT;


--
-- Name: recipient_identities_provider_ref; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE UNIQUE INDEX recipient_identities_provider_ref ON ujira.recipient_identities USING btree (provider, provider_account, provider_ref) NULLS NOT DISTINCT WHERE (provider_ref IS NOT NULL);


--
-- Name: recipient_identities_verified_nullifier; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE UNIQUE INDEX recipient_identities_verified_nullifier ON ujira.recipient_identities USING btree (principal_id, nullifier_hmac) WHERE ((state = 'verified'::text) AND (nullifier_hmac IS NOT NULL));


--
-- Name: chain_cursors chain_cursors_touch; Type: TRIGGER; Schema: ops; Owner: ujira_owner
--

CREATE TRIGGER chain_cursors_touch BEFORE UPDATE ON ops.chain_cursors FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: identity_provider_events identity_provider_events_append_only; Type: TRIGGER; Schema: ops; Owner: ujira_owner
--

CREATE TRIGGER identity_provider_events_append_only BEFORE DELETE OR UPDATE ON ops.identity_provider_events FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: identity_provider_events identity_provider_events_no_truncate; Type: TRIGGER; Schema: ops; Owner: ujira_owner
--

CREATE TRIGGER identity_provider_events_no_truncate BEFORE TRUNCATE ON ops.identity_provider_events FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: routing_config_active routing_config_active_touch; Type: TRIGGER; Schema: ops; Owner: ujira_owner
--

CREATE TRIGGER routing_config_active_touch BEFORE UPDATE ON ops.routing_config_active FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: routing_config_versions routing_config_versions_append_only; Type: TRIGGER; Schema: ops; Owner: ujira_owner
--

CREATE TRIGGER routing_config_versions_append_only BEFORE DELETE OR UPDATE ON ops.routing_config_versions FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: signing_keys signing_keys_keep; Type: TRIGGER; Schema: ops; Owner: ujira_owner
--

CREATE TRIGGER signing_keys_keep BEFORE UPDATE ON ops.signing_keys FOR EACH ROW EXECUTE FUNCTION ops.keep_signing_key();


--
-- Name: signing_keys signing_keys_touch; Type: TRIGGER; Schema: ops; Owner: ujira_owner
--

CREATE TRIGGER signing_keys_touch BEFORE UPDATE ON ops.signing_keys FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: api_tokens api_tokens_keep_revoked; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER api_tokens_keep_revoked BEFORE UPDATE ON ujira.api_tokens FOR EACH ROW EXECUTE FUNCTION ujira.keep_token_revoked();


--
-- Name: approvals approvals_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER approvals_append_only BEFORE DELETE OR UPDATE ON ujira.approvals FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: approvals approvals_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER approvals_no_truncate BEFORE TRUNCATE ON ujira.approvals FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: audit_heads audit_heads_no_delete; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER audit_heads_no_delete BEFORE DELETE ON ujira.audit_heads FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: audit_heads audit_heads_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER audit_heads_no_truncate BEFORE TRUNCATE ON ujira.audit_heads FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: audit_log audit_log_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER audit_log_append_only BEFORE DELETE OR UPDATE ON ujira.audit_log FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: audit_log audit_log_chain; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER audit_log_chain BEFORE INSERT ON ujira.audit_log FOR EACH ROW EXECUTE FUNCTION ujira.audit_chain();


--
-- Name: audit_log audit_log_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON ujira.audit_log FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: chain_events chain_events_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER chain_events_append_only BEFORE DELETE OR UPDATE ON ujira.chain_events FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: chain_events chain_events_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER chain_events_no_truncate BEFORE TRUNCATE ON ujira.chain_events FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: data_keys data_keys_no_delete; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER data_keys_no_delete BEFORE DELETE ON ujira.data_keys FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: data_keys data_keys_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER data_keys_no_truncate BEFORE TRUNCATE ON ujira.data_keys FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: data_keys data_keys_stay_shredded; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER data_keys_stay_shredded BEFORE UPDATE ON ujira.data_keys FOR EACH ROW EXECUTE FUNCTION ujira.data_key_stays_shredded();


--
-- Name: deposits deposits_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER deposits_append_only BEFORE DELETE OR UPDATE ON ujira.deposits FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: deposits deposits_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER deposits_no_truncate BEFORE TRUNCATE ON ujira.deposits FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: erasure_log erasure_log_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER erasure_log_append_only BEFORE DELETE OR UPDATE ON ujira.erasure_log FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: erasure_log erasure_log_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER erasure_log_no_truncate BEFORE TRUNCATE ON ujira.erasure_log FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: fee_reconciliations fee_reconciliations_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER fee_reconciliations_append_only BEFORE DELETE OR UPDATE ON ujira.fee_reconciliations FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: fee_reconciliations fee_reconciliations_executed_attempt; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER fee_reconciliations_executed_attempt BEFORE INSERT ON ujira.fee_reconciliations FOR EACH ROW EXECUTE FUNCTION ujira.fee_reconciliation_needs_execution();


--
-- Name: fee_reconciliations fee_reconciliations_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER fee_reconciliations_no_truncate BEFORE TRUNCATE ON ujira.fee_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: fee_refunds fee_refunds_no_delete; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER fee_refunds_no_delete BEFORE DELETE ON ujira.fee_refunds FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: fee_refunds fee_refunds_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER fee_refunds_no_truncate BEFORE TRUNCATE ON ujira.fee_refunds FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: fee_refunds fee_refunds_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER fee_refunds_touch BEFORE UPDATE ON ujira.fee_refunds FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: fee_refunds fee_refunds_transition; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER fee_refunds_transition BEFORE UPDATE OF status ON ujira.fee_refunds FOR EACH ROW EXECUTE FUNCTION ujira.check_transition('fee_refund');


--
-- Name: fee_refunds fee_refunds_within_fee; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE CONSTRAINT TRIGGER fee_refunds_within_fee AFTER INSERT OR UPDATE OF amount, status ON ujira.fee_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ujira.fee_refunds_within_fee();


--
-- Name: fee_terms fee_terms_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER fee_terms_append_only BEFORE DELETE OR UPDATE ON ujira.fee_terms FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: fee_terms fee_terms_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER fee_terms_no_truncate BEFORE TRUNCATE ON ujira.fee_terms FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: funding_sweeps funding_sweeps_check_new; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER funding_sweeps_check_new AFTER INSERT ON ujira.funding_sweeps FOR EACH ROW EXECUTE FUNCTION ujira.check_new_funding_sweep();


--
-- Name: funding_sweeps funding_sweeps_keep; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER funding_sweeps_keep BEFORE UPDATE ON ujira.funding_sweeps FOR EACH ROW EXECUTE FUNCTION ujira.keep_funding_sweep();


--
-- Name: funding_sweeps funding_sweeps_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER funding_sweeps_touch BEFORE UPDATE ON ujira.funding_sweeps FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: funding_sweeps funding_sweeps_transition; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER funding_sweeps_transition BEFORE UPDATE ON ujira.funding_sweeps FOR EACH ROW EXECUTE FUNCTION ujira.check_transition('funding_sweep');


--
-- Name: ledger_accounts ledger_accounts_guard; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER ledger_accounts_guard BEFORE INSERT OR DELETE OR UPDATE ON ujira.ledger_accounts FOR EACH ROW EXECUTE FUNCTION ujira.ledger_accounts_guard();


--
-- Name: ledger_accounts ledger_accounts_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER ledger_accounts_no_truncate BEFORE TRUNCATE ON ujira.ledger_accounts FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: ledger_entries ledger_entries_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER ledger_entries_append_only BEFORE DELETE OR UPDATE ON ujira.ledger_entries FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: ledger_entries ledger_entries_balanced; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ujira.ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ujira.ledger_balanced();


--
-- Name: ledger_entries ledger_entries_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ujira.ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: ledger_entries ledger_entries_stamp; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER ledger_entries_stamp BEFORE INSERT ON ujira.ledger_entries FOR EACH ROW EXECUTE FUNCTION ujira.ledger_stamp();


--
-- Name: ledger_journals ledger_journals_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER ledger_journals_append_only BEFORE DELETE OR UPDATE ON ujira.ledger_journals FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: ledger_journals ledger_journals_balanced; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE CONSTRAINT TRIGGER ledger_journals_balanced AFTER INSERT ON ujira.ledger_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ujira.ledger_balanced();


--
-- Name: ledger_journals ledger_journals_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER ledger_journals_no_truncate BEFORE TRUNCATE ON ujira.ledger_journals FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: leg_refunds leg_refunds_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER leg_refunds_append_only BEFORE DELETE OR UPDATE ON ujira.leg_refunds FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: leg_refunds leg_refunds_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER leg_refunds_no_truncate BEFORE TRUNCATE ON ujira.leg_refunds FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: leg_refunds leg_refunds_stamp; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER leg_refunds_stamp BEFORE INSERT ON ujira.leg_refunds FOR EACH ROW EXECUTE FUNCTION ujira.leg_refund_stamp();


--
-- Name: leg_refunds leg_refunds_within_leg; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE CONSTRAINT TRIGGER leg_refunds_within_leg AFTER INSERT ON ujira.leg_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ujira.leg_refunds_within_leg();


--
-- Name: managed_signers managed_signers_keep; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER managed_signers_keep BEFORE UPDATE ON ujira.managed_signers FOR EACH ROW EXECUTE FUNCTION ujira.keep_managed_signer();


--
-- Name: managed_signers managed_signers_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER managed_signers_touch BEFORE UPDATE ON ujira.managed_signers FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: managed_signers managed_signers_transition; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER managed_signers_transition BEFORE UPDATE ON ujira.managed_signers FOR EACH ROW EXECUTE FUNCTION ujira.check_transition('managed_signer');


--
-- Name: mandate_instance_roles mandate_instance_roles_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER mandate_instance_roles_touch BEFORE UPDATE ON ujira.mandate_instance_roles FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: mandate_instances mandate_instances_fee_cap_only_lowers; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER mandate_instances_fee_cap_only_lowers BEFORE UPDATE OF max_fee_bps, fee_address ON ujira.mandate_instances FOR EACH ROW EXECUTE FUNCTION ujira.fee_cap_only_lowers();


--
-- Name: mandate_state_snapshots mandate_state_snapshots_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER mandate_state_snapshots_append_only BEFORE DELETE OR UPDATE ON ujira.mandate_state_snapshots FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: mandate_state_snapshots mandate_state_snapshots_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER mandate_state_snapshots_no_truncate BEFORE TRUNCATE ON ujira.mandate_state_snapshots FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: mandates mandates_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER mandates_touch BEFORE UPDATE ON ujira.mandates FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: payout_attempts payout_attempts_have_legs; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE CONSTRAINT TRIGGER payout_attempts_have_legs AFTER INSERT ON ujira.payout_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ujira.legs_match_attempt('id');


--
-- Name: payout_attempts payout_attempts_instance; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_attempts_instance BEFORE INSERT ON ujira.payout_attempts FOR EACH ROW EXECUTE FUNCTION ujira.payout_instance_matches();


--
-- Name: payout_attempts payout_attempts_match_legs; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE CONSTRAINT TRIGGER payout_attempts_match_legs AFTER UPDATE OF total_amount ON ujira.payout_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ujira.legs_match_attempt('id');


--
-- Name: payout_attempts payout_attempts_no_delete; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_attempts_no_delete BEFORE DELETE ON ujira.payout_attempts FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: payout_attempts payout_attempts_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_attempts_no_truncate BEFORE TRUNCATE ON ujira.payout_attempts FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: payout_attempts payout_attempts_open_payout; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_attempts_open_payout BEFORE INSERT ON ujira.payout_attempts FOR EACH ROW EXECUTE FUNCTION ujira.payout_attempt_needs_open_payout();


--
-- Name: payout_attempts payout_attempts_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_attempts_touch BEFORE UPDATE ON ujira.payout_attempts FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: payout_attempts payout_attempts_transition; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_attempts_transition BEFORE UPDATE ON ujira.payout_attempts FOR EACH ROW EXECUTE FUNCTION ujira.check_transition('payout_attempt');


--
-- Name: payout_batches payout_batches_no_delete; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_batches_no_delete BEFORE DELETE ON ujira.payout_batches FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: payout_batches payout_batches_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_batches_no_truncate BEFORE TRUNCATE ON ujira.payout_batches FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: payout_funding_holds payout_funding_holds_held; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE CONSTRAINT TRIGGER payout_funding_holds_held AFTER INSERT ON ujira.payout_funding_holds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ujira.funding_hold_is_held();


--
-- Name: payout_funding_holds payout_funding_holds_instance; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_funding_holds_instance BEFORE INSERT ON ujira.payout_funding_holds FOR EACH ROW EXECUTE FUNCTION ujira.payout_instance_matches();


--
-- Name: payout_legs payout_legs_match_attempt; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE CONSTRAINT TRIGGER payout_legs_match_attempt AFTER INSERT OR UPDATE OF amount, attempt_id ON ujira.payout_legs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ujira.legs_match_attempt('attempt_id');


--
-- Name: payout_legs payout_legs_no_delete; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_legs_no_delete BEFORE DELETE ON ujira.payout_legs FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: payout_legs payout_legs_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_legs_no_truncate BEFORE TRUNCATE ON ujira.payout_legs FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: payout_legs payout_legs_stamp; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_legs_stamp BEFORE INSERT OR UPDATE OF payout_id, leg_index, payout_method_id, chain, method ON ujira.payout_legs FOR EACH ROW EXECUTE FUNCTION ujira.payout_leg_stamp();


--
-- Name: payout_legs payout_legs_to_method; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_legs_to_method BEFORE INSERT OR UPDATE OF payout_method_id, destination_address, destination_tag ON ujira.payout_legs FOR EACH ROW EXECUTE FUNCTION ujira.legs_match_method();


--
-- Name: payout_legs payout_legs_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_legs_touch BEFORE UPDATE ON ujira.payout_legs FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: payout_legs payout_legs_transition; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_legs_transition BEFORE UPDATE ON ujira.payout_legs FOR EACH ROW EXECUTE FUNCTION ujira.check_transition('payout_leg');


--
-- Name: payout_methods payout_methods_details_not_erased; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_methods_details_not_erased BEFORE INSERT OR UPDATE ON ujira.payout_methods FOR EACH ROW WHEN ((new.details_ciphertext IS NOT NULL)) EXECUTE FUNCTION ujira.refuse_personal_data_after_erasure();


--
-- Name: payout_methods payout_methods_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_methods_touch BEFORE UPDATE ON ujira.payout_methods FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: payouts payouts_holds_released; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE CONSTRAINT TRIGGER payouts_holds_released AFTER UPDATE ON ujira.payouts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.status <> 'received'::text) OR (new.status_reason IS DISTINCT FROM 'awaiting_funding'::text))) EXECUTE FUNCTION ujira.payout_left_its_holds();


--
-- Name: payouts payouts_no_delete; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payouts_no_delete BEFORE DELETE ON ujira.payouts FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: payouts payouts_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payouts_no_truncate BEFORE TRUNCATE ON ujira.payouts FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: payouts payouts_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payouts_touch BEFORE UPDATE ON ujira.payouts FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: payouts payouts_transition; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payouts_transition BEFORE UPDATE ON ujira.payouts FOR EACH ROW EXECUTE FUNCTION ujira.check_transition('payout');


--
-- Name: principal_members principal_members_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER principal_members_touch BEFORE UPDATE ON ujira.principal_members FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: principals principals_reporting_time_zone; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER principals_reporting_time_zone BEFORE INSERT OR UPDATE OF reporting_time_zone ON ujira.principals FOR EACH ROW EXECUTE FUNCTION ujira.check_reporting_time_zone();


--
-- Name: principals principals_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER principals_touch BEFORE UPDATE ON ujira.principals FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: project_payout_minimums project_payout_minimums_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER project_payout_minimums_touch BEFORE UPDATE ON ujira.project_payout_minimums FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: projects projects_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER projects_touch BEFORE UPDATE ON ujira.projects FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: receipt_legs receipt_legs_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER receipt_legs_append_only BEFORE DELETE OR UPDATE ON ujira.receipt_legs FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: receipt_legs receipt_legs_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER receipt_legs_no_truncate BEFORE TRUNCATE ON ujira.receipt_legs FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: receipt_legs receipt_legs_whole; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE CONSTRAINT TRIGGER receipt_legs_whole AFTER INSERT ON ujira.receipt_legs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ujira.receipt_is_whole('receipt_id');


--
-- Name: receipts receipts_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER receipts_append_only BEFORE DELETE OR UPDATE ON ujira.receipts FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: receipts receipts_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER receipts_no_truncate BEFORE TRUNCATE ON ujira.receipts FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: receipts receipts_whole; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE CONSTRAINT TRIGGER receipts_whole AFTER INSERT ON ujira.receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ujira.receipt_is_whole('id');


--
-- Name: recipient_identities recipient_identities_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER recipient_identities_touch BEFORE UPDATE ON ujira.recipient_identities FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: recipient_pii recipient_pii_not_erased; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER recipient_pii_not_erased BEFORE INSERT OR UPDATE ON ujira.recipient_pii FOR EACH ROW EXECUTE FUNCTION ujira.refuse_personal_data_after_erasure();


--
-- Name: recipient_pii recipient_pii_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER recipient_pii_touch BEFORE UPDATE ON ujira.recipient_pii FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: recipients recipients_stay_erased; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER recipients_stay_erased BEFORE UPDATE ON ujira.recipients FOR EACH ROW EXECUTE FUNCTION ujira.recipient_stays_erased();


--
-- Name: recipients recipients_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER recipients_touch BEFORE UPDATE ON ujira.recipients FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: routing_config_active routing_config_active_version_fkey; Type: FK CONSTRAINT; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ONLY ops.routing_config_active
    ADD CONSTRAINT routing_config_active_version_fkey FOREIGN KEY (version) REFERENCES ops.routing_config_versions(version);


--
-- Name: api_tokens api_tokens_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.api_tokens
    ADD CONSTRAINT api_tokens_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


--
-- Name: approvals approvals_principal_id_project_id_attempt_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.approvals
    ADD CONSTRAINT approvals_principal_id_project_id_attempt_id_fkey FOREIGN KEY (principal_id, project_id, attempt_id) REFERENCES ujira.payout_attempts(principal_id, project_id, id);


--
-- Name: audit_heads audit_heads_principal_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.audit_heads
    ADD CONSTRAINT audit_heads_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES ujira.principals(id);


--
-- Name: audit_log audit_log_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.audit_log
    ADD CONSTRAINT audit_log_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


--
-- Name: chain_events chain_events_principal_id_project_id_mandate_instance_id_c_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.chain_events
    ADD CONSTRAINT chain_events_principal_id_project_id_mandate_instance_id_c_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id, chain) REFERENCES ujira.mandate_instances(principal_id, project_id, id, chain);


--
-- Name: currency_scales currency_scales_currency_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.currency_scales
    ADD CONSTRAINT currency_scales_currency_fkey FOREIGN KEY (currency) REFERENCES ujira.currencies(code);


--
-- Name: data_keys data_keys_principal_id_project_id_subject_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.data_keys
    ADD CONSTRAINT data_keys_principal_id_project_id_subject_id_fkey FOREIGN KEY (principal_id, project_id, subject_id) REFERENCES ujira.recipients(principal_id, project_id, id);


--
-- Name: deposits deposits_asset_chain_scale_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.deposits
    ADD CONSTRAINT deposits_asset_chain_scale_fkey FOREIGN KEY (asset, chain, scale) REFERENCES ujira.settlement_tokens(asset, chain, token_scale);


--
-- Name: deposits deposits_principal_id_project_id_chain_event_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.deposits
    ADD CONSTRAINT deposits_principal_id_project_id_chain_event_id_fkey FOREIGN KEY (principal_id, project_id, chain_event_id) REFERENCES ujira.chain_events(principal_id, project_id, id);


--
-- Name: deposits deposits_principal_id_project_id_funding_source_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.deposits
    ADD CONSTRAINT deposits_principal_id_project_id_funding_source_id_fkey FOREIGN KEY (principal_id, project_id, funding_source_id) REFERENCES ujira.funding_sources(principal_id, project_id, id);


--
-- Name: deposits deposits_principal_id_project_id_mandate_instance_id_chain_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.deposits
    ADD CONSTRAINT deposits_principal_id_project_id_mandate_instance_id_chain_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id, chain, asset, scale) REFERENCES ujira.mandate_instances(principal_id, project_id, id, chain, asset, scale);


--
-- Name: erasure_log erasure_log_principal_id_project_id_subject_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.erasure_log
    ADD CONSTRAINT erasure_log_principal_id_project_id_subject_id_fkey FOREIGN KEY (principal_id, project_id, subject_id) REFERENCES ujira.recipients(principal_id, project_id, id);


--
-- Name: fee_reconciliations fee_reconciliations_principal_id_project_id_payout_id_atte_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.fee_reconciliations
    ADD CONSTRAINT fee_reconciliations_principal_id_project_id_payout_id_atte_fkey FOREIGN KEY (principal_id, project_id, payout_id, attempt_id, chain, asset, scale) REFERENCES ujira.payout_attempts(principal_id, project_id, payout_id, id, chain, asset, scale);


--
-- Name: fee_refunds fee_refunds_principal_id_project_id_leg_refund_id_payout_i_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.fee_refunds
    ADD CONSTRAINT fee_refunds_principal_id_project_id_leg_refund_id_payout_i_fkey FOREIGN KEY (principal_id, project_id, leg_refund_id, payout_id, attempt_id, chain, asset, scale) REFERENCES ujira.leg_refunds(principal_id, project_id, id, payout_id, attempt_id, chain, asset, scale);


--
-- Name: fee_terms fee_terms_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.fee_terms
    ADD CONSTRAINT fee_terms_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


--
-- Name: funding_sources funding_sources_principal_id_project_id_mandate_instance_i_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_sources
    ADD CONSTRAINT funding_sources_principal_id_project_id_mandate_instance_i_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id) REFERENCES ujira.mandate_instances(principal_id, project_id, id);


--
-- Name: funding_sweeps funding_sweeps_asset_chain_scale_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_sweeps
    ADD CONSTRAINT funding_sweeps_asset_chain_scale_fkey FOREIGN KEY (asset, chain, scale) REFERENCES ujira.settlement_tokens(asset, chain, token_scale);


--
-- Name: funding_sweeps funding_sweeps_principal_id_project_id_funding_source_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_sweeps
    ADD CONSTRAINT funding_sweeps_principal_id_project_id_funding_source_id_fkey FOREIGN KEY (principal_id, project_id, funding_source_id) REFERENCES ujira.funding_sources(principal_id, project_id, id);


--
-- Name: funding_sweeps funding_sweeps_principal_id_project_id_mandate_instance_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_sweeps
    ADD CONSTRAINT funding_sweeps_principal_id_project_id_mandate_instance_id_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id, chain, asset, scale) REFERENCES ujira.mandate_instances(principal_id, project_id, id, chain, asset, scale);


--
-- Name: ledger_accounts ledger_accounts_principal_id_project_id_mandate_instance_i_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_accounts
    ADD CONSTRAINT ledger_accounts_principal_id_project_id_mandate_instance_i_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id, chain, asset, scale) REFERENCES ujira.mandate_instances(principal_id, project_id, id, chain, asset, scale);


--
-- Name: ledger_entries ledger_entries_principal_id_project_id_account_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_entries
    ADD CONSTRAINT ledger_entries_principal_id_project_id_account_id_fkey FOREIGN KEY (principal_id, project_id, account_id) REFERENCES ujira.ledger_accounts(principal_id, project_id, id);


--
-- Name: ledger_entries ledger_entries_principal_id_project_id_journal_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_entries
    ADD CONSTRAINT ledger_entries_principal_id_project_id_journal_id_fkey FOREIGN KEY (principal_id, project_id, journal_id) REFERENCES ujira.ledger_journals(principal_id, project_id, id);


--
-- Name: ledger_journals ledger_journals_principal_id_project_id_chain_event_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_journals
    ADD CONSTRAINT ledger_journals_principal_id_project_id_chain_event_id_fkey FOREIGN KEY (principal_id, project_id, chain_event_id) REFERENCES ujira.chain_events(principal_id, project_id, id);


--
-- Name: ledger_journals ledger_journals_principal_id_project_id_mandate_instance_i_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_journals
    ADD CONSTRAINT ledger_journals_principal_id_project_id_mandate_instance_i_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id) REFERENCES ujira.mandate_instances(principal_id, project_id, id);


--
-- Name: ledger_journals ledger_journals_principal_id_project_id_reverses_journal_i_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.ledger_journals
    ADD CONSTRAINT ledger_journals_principal_id_project_id_reverses_journal_i_fkey FOREIGN KEY (principal_id, project_id, reverses_journal_id) REFERENCES ujira.ledger_journals(principal_id, project_id, id);


--
-- Name: leg_refunds leg_refunds_principal_id_project_id_payout_id_attempt_id_c_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.leg_refunds
    ADD CONSTRAINT leg_refunds_principal_id_project_id_payout_id_attempt_id_c_fkey FOREIGN KEY (principal_id, project_id, payout_id, attempt_id, chain, asset, scale) REFERENCES ujira.payout_attempts(principal_id, project_id, payout_id, id, chain, asset, scale);


--
-- Name: leg_refunds leg_refunds_principal_id_project_id_payout_leg_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.leg_refunds
    ADD CONSTRAINT leg_refunds_principal_id_project_id_payout_leg_id_fkey FOREIGN KEY (principal_id, project_id, payout_leg_id) REFERENCES ujira.payout_legs(principal_id, project_id, id);


--
-- Name: managed_signers managed_signers_principal_id_consented_by_member_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.managed_signers
    ADD CONSTRAINT managed_signers_principal_id_consented_by_member_id_fkey FOREIGN KEY (principal_id, consented_by_member_id) REFERENCES ujira.principal_members(principal_id, user_id);


--
-- Name: managed_signers managed_signers_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.managed_signers
    ADD CONSTRAINT managed_signers_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


--
-- Name: mandate_instance_roles mandate_instance_roles_principal_id_project_id_granted_eve_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instance_roles
    ADD CONSTRAINT mandate_instance_roles_principal_id_project_id_granted_eve_fkey FOREIGN KEY (principal_id, project_id, granted_event_id) REFERENCES ujira.chain_events(principal_id, project_id, id);


--
-- Name: mandate_instance_roles mandate_instance_roles_principal_id_project_id_mandate_ins_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instance_roles
    ADD CONSTRAINT mandate_instance_roles_principal_id_project_id_mandate_ins_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id) REFERENCES ujira.mandate_instances(principal_id, project_id, id);


--
-- Name: mandate_instance_roles mandate_instance_roles_principal_id_project_id_revoked_eve_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instance_roles
    ADD CONSTRAINT mandate_instance_roles_principal_id_project_id_revoked_eve_fkey FOREIGN KEY (principal_id, project_id, revoked_event_id) REFERENCES ujira.chain_events(principal_id, project_id, id);


--
-- Name: mandate_instances mandate_instances_asset_chain_scale_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instances
    ADD CONSTRAINT mandate_instances_asset_chain_scale_fkey FOREIGN KEY (asset, chain, scale) REFERENCES ujira.settlement_tokens(asset, chain, token_scale);


--
-- Name: mandate_instances mandate_instances_principal_id_project_id_mandate_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_instances
    ADD CONSTRAINT mandate_instances_principal_id_project_id_mandate_id_fkey FOREIGN KEY (principal_id, project_id, mandate_id) REFERENCES ujira.mandates(principal_id, project_id, id);


--
-- Name: mandate_state_snapshots mandate_state_snapshots_principal_id_project_id_mandate_in_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandate_state_snapshots
    ADD CONSTRAINT mandate_state_snapshots_principal_id_project_id_mandate_in_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id) REFERENCES ujira.mandate_instances(principal_id, project_id, id);


--
-- Name: mandates mandates_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandates
    ADD CONSTRAINT mandates_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


--
-- Name: payout_attempts payout_attempts_principal_id_project_id_mandate_instance_i_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_attempts
    ADD CONSTRAINT payout_attempts_principal_id_project_id_mandate_instance_i_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id, chain, asset, scale) REFERENCES ujira.mandate_instances(principal_id, project_id, id, chain, asset, scale);


--
-- Name: payout_attempts payout_attempts_principal_id_project_id_payout_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_attempts
    ADD CONSTRAINT payout_attempts_principal_id_project_id_payout_id_fkey FOREIGN KEY (principal_id, project_id, payout_id) REFERENCES ujira.payouts(principal_id, project_id, id);


--
-- Name: payout_batches payout_batches_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_batches
    ADD CONSTRAINT payout_batches_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


--
-- Name: payout_funding_holds payout_funding_holds_principal_id_project_id_mandate_insta_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_funding_holds
    ADD CONSTRAINT payout_funding_holds_principal_id_project_id_mandate_insta_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id, chain, asset, scale) REFERENCES ujira.mandate_instances(principal_id, project_id, id, chain, asset, scale);


--
-- Name: payout_funding_holds payout_funding_holds_principal_id_project_id_payout_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_funding_holds
    ADD CONSTRAINT payout_funding_holds_principal_id_project_id_payout_id_fkey FOREIGN KEY (principal_id, project_id, payout_id) REFERENCES ujira.payouts(principal_id, project_id, id);


--
-- Name: payout_legs payout_legs_principal_id_project_id_payout_id_attempt_id_c_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_legs
    ADD CONSTRAINT payout_legs_principal_id_project_id_payout_id_attempt_id_c_fkey FOREIGN KEY (principal_id, project_id, payout_id, attempt_id, chain, asset, scale) REFERENCES ujira.payout_attempts(principal_id, project_id, payout_id, id, chain, asset, scale);


--
-- Name: payout_legs payout_legs_principal_id_project_id_payout_method_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_legs
    ADD CONSTRAINT payout_legs_principal_id_project_id_payout_method_id_fkey FOREIGN KEY (principal_id, project_id, payout_method_id) REFERENCES ujira.payout_methods(principal_id, project_id, id);


--
-- Name: payout_methods payout_methods_chain_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_methods
    ADD CONSTRAINT payout_methods_chain_fkey FOREIGN KEY (chain) REFERENCES ujira.chains(code);


--
-- Name: payout_methods payout_methods_principal_id_project_id_recipient_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_methods
    ADD CONSTRAINT payout_methods_principal_id_project_id_recipient_id_fkey FOREIGN KEY (principal_id, project_id, recipient_id) REFERENCES ujira.recipients(principal_id, project_id, id);


--
-- Name: payouts payouts_principal_id_project_id_batch_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payouts
    ADD CONSTRAINT payouts_principal_id_project_id_batch_id_fkey FOREIGN KEY (principal_id, project_id, batch_id) REFERENCES ujira.payout_batches(principal_id, project_id, id);


--
-- Name: payouts payouts_principal_id_project_id_mandate_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payouts
    ADD CONSTRAINT payouts_principal_id_project_id_mandate_id_fkey FOREIGN KEY (principal_id, project_id, mandate_id) REFERENCES ujira.mandates(principal_id, project_id, id);


--
-- Name: payouts payouts_principal_id_project_id_recipient_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payouts
    ADD CONSTRAINT payouts_principal_id_project_id_recipient_id_fkey FOREIGN KEY (principal_id, project_id, recipient_id) REFERENCES ujira.recipients(principal_id, project_id, id);


--
-- Name: payouts payouts_requested_asset_requested_chain_requested_token_sc_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payouts
    ADD CONSTRAINT payouts_requested_asset_requested_chain_requested_token_sc_fkey FOREIGN KEY (requested_asset, requested_chain, requested_token_scale) REFERENCES ujira.settlement_tokens(asset, chain, token_scale);


--
-- Name: payouts payouts_requested_currency_requested_currency_scale_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payouts
    ADD CONSTRAINT payouts_requested_currency_requested_currency_scale_fkey FOREIGN KEY (requested_currency, requested_currency_scale) REFERENCES ujira.currency_scales(currency, scale);


--
-- Name: payouts payouts_total_asset_total_chain_total_scale_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payouts
    ADD CONSTRAINT payouts_total_asset_total_chain_total_scale_fkey FOREIGN KEY (total_asset, total_chain, total_scale) REFERENCES ujira.settlement_tokens(asset, chain, token_scale);


--
-- Name: principal_members principal_members_principal_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.principal_members
    ADD CONSTRAINT principal_members_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES ujira.principals(id);


--
-- Name: project_payout_minimums project_payout_minimums_currency_scale_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.project_payout_minimums
    ADD CONSTRAINT project_payout_minimums_currency_scale_fkey FOREIGN KEY (currency, scale) REFERENCES ujira.currency_scales(currency, scale);


--
-- Name: project_payout_minimums project_payout_minimums_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.project_payout_minimums
    ADD CONSTRAINT project_payout_minimums_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


--
-- Name: project_payout_minimums project_payout_minimums_principal_id_set_by_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.project_payout_minimums
    ADD CONSTRAINT project_payout_minimums_principal_id_set_by_fkey FOREIGN KEY (principal_id, set_by) REFERENCES ujira.principal_members(principal_id, user_id);


--
-- Name: projects projects_principal_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.projects
    ADD CONSTRAINT projects_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES ujira.principals(id);


--
-- Name: receipt_legs receipt_legs_principal_id_project_id_attempt_id_leg_index_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.receipt_legs
    ADD CONSTRAINT receipt_legs_principal_id_project_id_attempt_id_leg_index_fkey FOREIGN KEY (principal_id, project_id, attempt_id, leg_index) REFERENCES ujira.payout_legs(principal_id, project_id, attempt_id, leg_index);


--
-- Name: receipt_legs receipt_legs_principal_id_project_id_receipt_id_attempt_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.receipt_legs
    ADD CONSTRAINT receipt_legs_principal_id_project_id_receipt_id_attempt_id_fkey FOREIGN KEY (principal_id, project_id, receipt_id, attempt_id, chain, asset, scale) REFERENCES ujira.receipts(principal_id, project_id, id, attempt_id, chain, asset, scale);


--
-- Name: receipts receipts_principal_id_project_id_payout_id_attempt_id_chai_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.receipts
    ADD CONSTRAINT receipts_principal_id_project_id_payout_id_attempt_id_chai_fkey FOREIGN KEY (principal_id, project_id, payout_id, attempt_id, chain, asset, scale) REFERENCES ujira.payout_attempts(principal_id, project_id, payout_id, id, chain, asset, scale);


--
-- Name: recipient_identities recipient_identities_chain_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.recipient_identities
    ADD CONSTRAINT recipient_identities_chain_fkey FOREIGN KEY (chain) REFERENCES ujira.chains(code);


--
-- Name: recipient_identities recipient_identities_principal_id_project_id_recipient_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.recipient_identities
    ADD CONSTRAINT recipient_identities_principal_id_project_id_recipient_id_fkey FOREIGN KEY (principal_id, project_id, recipient_id) REFERENCES ujira.recipients(principal_id, project_id, id);


--
-- Name: recipient_pii recipient_pii_principal_id_project_id_recipient_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.recipient_pii
    ADD CONSTRAINT recipient_pii_principal_id_project_id_recipient_id_fkey FOREIGN KEY (principal_id, project_id, recipient_id) REFERENCES ujira.recipients(principal_id, project_id, id);


--
-- Name: recipients recipients_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.recipients
    ADD CONSTRAINT recipients_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


--
-- Name: settlement_tokens settlement_tokens_chain_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.settlement_tokens
    ADD CONSTRAINT settlement_tokens_chain_fkey FOREIGN KEY (chain) REFERENCES ujira.chains(code);


--
-- Name: api_tokens; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.api_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: approvals; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.approvals ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_heads audit_chain_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY audit_chain_all ON ujira.audit_heads TO ujira_fn_audit USING (true) WITH CHECK (true);


--
-- Name: audit_heads; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.audit_heads ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: api_tokens authenticate; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY authenticate ON ujira.api_tokens FOR SELECT TO ujira_fn_tokens USING (true);


--
-- Name: chain_events; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.chain_events ENABLE ROW LEVEL SECURITY;

--
-- Name: principal_members create_principal; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY create_principal ON ujira.principal_members FOR INSERT TO ujira_fn_principals WITH CHECK (true);


--
-- Name: principals create_principal; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY create_principal ON ujira.principals FOR INSERT TO ujira_fn_principals WITH CHECK (true);


--
-- Name: projects create_principal; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY create_principal ON ujira.projects FOR INSERT TO ujira_fn_principals WITH CHECK (true);


--
-- Name: data_keys; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.data_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: deposits; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.deposits ENABLE ROW LEVEL SECURITY;

--
-- Name: data_keys erasure_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY erasure_all ON ujira.data_keys TO ujira_fn_erasure USING (true) WITH CHECK (true);


--
-- Name: erasure_log erasure_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY erasure_all ON ujira.erasure_log TO ujira_fn_erasure USING (true) WITH CHECK (true);


--
-- Name: payout_methods erasure_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY erasure_all ON ujira.payout_methods TO ujira_fn_erasure USING (true) WITH CHECK (true);


--
-- Name: recipient_identities erasure_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY erasure_all ON ujira.recipient_identities TO ujira_fn_erasure USING (true) WITH CHECK (true);


--
-- Name: recipient_pii erasure_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY erasure_all ON ujira.recipient_pii TO ujira_fn_erasure USING (true) WITH CHECK (true);


--
-- Name: recipients erasure_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY erasure_all ON ujira.recipients TO ujira_fn_erasure USING (true) WITH CHECK (true);


--
-- Name: erasure_log; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.erasure_log ENABLE ROW LEVEL SECURITY;

--
-- Name: fee_reconciliations; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.fee_reconciliations ENABLE ROW LEVEL SECURITY;

--
-- Name: fee_refunds; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.fee_refunds ENABLE ROW LEVEL SECURITY;

--
-- Name: fee_terms; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.fee_terms ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log fee_terms_audit; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY fee_terms_audit ON ujira.audit_log FOR INSERT TO ujira_fn_fees WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: fee_terms fee_terms_record; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY fee_terms_record ON ujira.fee_terms FOR INSERT TO ujira_fn_fees WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: funding_sources; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.funding_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: funding_sweeps; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.funding_sweeps ENABLE ROW LEVEL SECURITY;

--
-- Name: mandate_instances indexer_fee_cap; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_fee_cap ON ujira.mandate_instances FOR UPDATE TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: chain_events indexer_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_insert ON ujira.chain_events FOR INSERT TO ujira_indexer WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: deposits indexer_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_insert ON ujira.deposits FOR INSERT TO ujira_indexer WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_accounts indexer_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_insert ON ujira.ledger_accounts FOR INSERT TO ujira_indexer WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_entries indexer_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_insert ON ujira.ledger_entries FOR INSERT TO ujira_indexer WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_journals indexer_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_insert ON ujira.ledger_journals FOR INSERT TO ujira_indexer WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instance_roles indexer_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_insert ON ujira.mandate_instance_roles FOR INSERT TO ujira_indexer WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_state_snapshots indexer_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_insert ON ujira.mandate_state_snapshots FOR INSERT TO ujira_indexer WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: chain_events indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.chain_events FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: deposits indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.deposits FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_accounts indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.ledger_accounts FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_entries indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.ledger_entries FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_journals indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.ledger_journals FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instance_roles indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.mandate_instance_roles FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instances indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.mandate_instances FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_state_snapshots indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.mandate_state_snapshots FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instance_roles indexer_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_update ON ujira.mandate_instance_roles FOR UPDATE TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_accounts; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.ledger_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_entries ledger_balanced_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY ledger_balanced_read ON ujira.ledger_entries FOR SELECT TO ujira_fn_ledger USING (true);


--
-- Name: ledger_entries; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.ledger_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_journals; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.ledger_journals ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_accounts ledger_stamp_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY ledger_stamp_read ON ujira.ledger_accounts FOR SELECT TO ujira_fn_ledger USING (true);


--
-- Name: ledger_accounts ledger_stamp_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY ledger_stamp_update ON ujira.ledger_accounts FOR UPDATE TO ujira_fn_ledger USING (true) WITH CHECK (true);


--
-- Name: leg_refunds; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.leg_refunds ENABLE ROW LEVEL SECURITY;

--
-- Name: managed_signers; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.managed_signers ENABLE ROW LEVEL SECURITY;

--
-- Name: mandate_instance_roles; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.mandate_instance_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: mandate_instances; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.mandate_instances ENABLE ROW LEVEL SECURITY;

--
-- Name: mandate_state_snapshots; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.mandate_state_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: mandates; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.mandates ENABLE ROW LEVEL SECURITY;

--
-- Name: api_tokens owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.api_tokens TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: approvals owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.approvals TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: audit_heads owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.audit_heads TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: audit_log owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.audit_log TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: chain_events owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.chain_events TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: data_keys owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.data_keys TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: deposits owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.deposits TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: erasure_log owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.erasure_log TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: fee_reconciliations owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.fee_reconciliations TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: fee_refunds owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.fee_refunds TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: fee_terms owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.fee_terms TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: funding_sources owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.funding_sources TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: funding_sweeps owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.funding_sweeps TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: ledger_accounts owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.ledger_accounts TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: ledger_entries owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.ledger_entries TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: ledger_journals owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.ledger_journals TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: leg_refunds owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.leg_refunds TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: managed_signers owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.managed_signers TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: mandate_instance_roles owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.mandate_instance_roles TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: mandate_instances owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.mandate_instances TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: mandate_state_snapshots owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.mandate_state_snapshots TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: mandates owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.mandates TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: payout_attempts owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.payout_attempts TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: payout_batches owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.payout_batches TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: payout_funding_holds owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.payout_funding_holds TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: payout_legs owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.payout_legs TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: payout_methods owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.payout_methods TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: payouts owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.payouts TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: principal_members owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.principal_members TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: principals owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.principals TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: project_payout_minimums owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.project_payout_minimums TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: projects owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.projects TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: receipt_legs owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.receipt_legs TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: receipts owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.receipts TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: recipient_identities owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.recipient_identities TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: recipient_pii owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.recipient_pii TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: recipients owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.recipients TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: payout_attempts; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.payout_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: payout_batches; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.payout_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: payout_funding_holds; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.payout_funding_holds ENABLE ROW LEVEL SECURITY;

--
-- Name: payout_legs; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.payout_legs ENABLE ROW LEVEL SECURITY;

--
-- Name: payout_methods; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.payout_methods ENABLE ROW LEVEL SECURITY;

--
-- Name: payouts; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.payouts ENABLE ROW LEVEL SECURITY;

--
-- Name: principal_members; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.principal_members ENABLE ROW LEVEL SECURITY;

--
-- Name: principals; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.principals ENABLE ROW LEVEL SECURITY;

--
-- Name: project_payout_minimums; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.project_payout_minimums ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.projects ENABLE ROW LEVEL SECURITY;

--
-- Name: receipt_legs; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.receipt_legs ENABLE ROW LEVEL SECURITY;

--
-- Name: receipts; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: recipient_identities; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.recipient_identities ENABLE ROW LEVEL SECURITY;

--
-- Name: recipient_pii; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.recipient_pii ENABLE ROW LEVEL SECURITY;

--
-- Name: recipients; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.recipients ENABLE ROW LEVEL SECURITY;

--
-- Name: mandate_instances resolve_instance; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY resolve_instance ON ujira.mandate_instances FOR SELECT TO ujira_fn_instances USING (true);


--
-- Name: payout_funding_holds tenant_delete; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_delete ON ujira.payout_funding_holds FOR DELETE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: recipient_pii tenant_delete; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_delete ON ujira.recipient_pii FOR DELETE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: api_tokens tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.api_tokens FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: approvals tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.approvals FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: audit_log tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.audit_log FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: chain_events tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.chain_events FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: data_keys tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.data_keys FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: deposits tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.deposits FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: erasure_log tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.erasure_log FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: fee_reconciliations tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.fee_reconciliations FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: fee_refunds tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.fee_refunds FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: fee_terms tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.fee_terms FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: funding_sources tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.funding_sources FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: funding_sweeps tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.funding_sweeps FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_accounts tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.ledger_accounts FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_entries tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.ledger_entries FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_journals tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.ledger_journals FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: leg_refunds tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.leg_refunds FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: managed_signers tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.managed_signers FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instance_roles tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.mandate_instance_roles FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instances tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.mandate_instances FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_state_snapshots tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.mandate_state_snapshots FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandates tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.mandates FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_attempts tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.payout_attempts FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_batches tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.payout_batches FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_funding_holds tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.payout_funding_holds FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_legs tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.payout_legs FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_methods tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.payout_methods FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payouts tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.payouts FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: principal_members tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.principal_members FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all())));


--
-- Name: project_payout_minimums tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.project_payout_minimums FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: projects tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.projects FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all())));


--
-- Name: receipt_legs tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.receipt_legs FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: receipts tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.receipts FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: recipient_identities tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.recipient_identities FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: recipient_pii tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.recipient_pii FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: recipients tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.recipients FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: api_tokens tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.api_tokens FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: approvals tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.approvals FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: audit_heads tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.audit_heads FOR SELECT TO ujira_app, ujira_reader USING ((principal_id = ujira.current_principal_id()));


--
-- Name: audit_log tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.audit_log FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: chain_events tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.chain_events FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: data_keys tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.data_keys FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: deposits tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.deposits FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: erasure_log tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.erasure_log FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: fee_reconciliations tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.fee_reconciliations FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: fee_refunds tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.fee_refunds FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: fee_terms tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.fee_terms FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: funding_sources tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.funding_sources FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: funding_sweeps tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.funding_sweeps FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: ledger_accounts tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.ledger_accounts FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: ledger_entries tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.ledger_entries FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: ledger_journals tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.ledger_journals FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: leg_refunds tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.leg_refunds FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: managed_signers tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.managed_signers FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: mandate_instance_roles tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.mandate_instance_roles FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: mandate_instances tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.mandate_instances FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: mandate_state_snapshots tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.mandate_state_snapshots FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: mandates tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.mandates FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: payout_attempts tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.payout_attempts FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: payout_batches tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.payout_batches FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: payout_funding_holds tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.payout_funding_holds FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: payout_legs tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.payout_legs FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: payout_methods tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.payout_methods FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: payouts tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.payouts FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: principal_members tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.principal_members FOR SELECT TO ujira_app, ujira_reader USING ((principal_id = ujira.current_principal_id()));


--
-- Name: principals tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.principals FOR SELECT TO ujira_app, ujira_reader USING ((id = ujira.current_principal_id()));


--
-- Name: project_payout_minimums tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.project_payout_minimums FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: projects tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.projects FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (id = ujira.current_project_id()))));


--
-- Name: receipt_legs tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.receipt_legs FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: receipts tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.receipts FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: recipient_identities tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.recipient_identities FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: recipient_pii tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.recipient_pii FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: recipients tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.recipients FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: api_tokens tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.api_tokens FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: approvals tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.approvals FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: audit_log tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.audit_log FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: chain_events tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.chain_events FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: data_keys tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.data_keys FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: deposits tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.deposits FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: erasure_log tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.erasure_log FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: fee_reconciliations tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.fee_reconciliations FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: fee_refunds tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.fee_refunds FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: fee_terms tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.fee_terms FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: funding_sources tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.funding_sources FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: funding_sweeps tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.funding_sweeps FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_accounts tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.ledger_accounts FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_entries tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.ledger_entries FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: ledger_journals tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.ledger_journals FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: leg_refunds tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.leg_refunds FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: managed_signers tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.managed_signers FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instance_roles tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.mandate_instance_roles FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instances tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.mandate_instances FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_state_snapshots tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.mandate_state_snapshots FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandates tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.mandates FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_attempts tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.payout_attempts FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_batches tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.payout_batches FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_funding_holds tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.payout_funding_holds FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_legs tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.payout_legs FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_methods tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.payout_methods FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payouts tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.payouts FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: principal_members tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.principal_members FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all())));


--
-- Name: principals tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.principals FOR UPDATE TO ujira_app USING (((id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all()))) WITH CHECK (((id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all())));


--
-- Name: project_payout_minimums tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.project_payout_minimums FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: projects tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.projects FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (id = ujira.current_project_id())));


--
-- Name: receipt_legs tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.receipt_legs FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: receipts tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.receipts FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: recipient_identities tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.recipient_identities FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: recipient_pii tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.recipient_pii FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: recipients tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.recipients FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: SCHEMA ops; Type: ACL; Schema: -; Owner: ujira_owner
--

GRANT USAGE ON SCHEMA ops TO ujira_ops;
GRANT USAGE ON SCHEMA ops TO ujira_app;


--
-- Name: SCHEMA ujira; Type: ACL; Schema: -; Owner: ujira_owner
--

GRANT USAGE ON SCHEMA ujira TO ujira_app;
GRANT USAGE ON SCHEMA ujira TO ujira_reader;
GRANT USAGE ON SCHEMA ujira TO ujira_retention;
GRANT USAGE ON SCHEMA ujira TO ujira_auth;
GRANT USAGE ON SCHEMA ujira TO ujira_indexer;
GRANT USAGE ON SCHEMA ujira TO ujira_fn_principals;
GRANT USAGE ON SCHEMA ujira TO ujira_fn_tokens;
GRANT USAGE ON SCHEMA ujira TO ujira_signer_read;
GRANT USAGE ON SCHEMA ujira TO ujira_signer_attester;
GRANT USAGE ON SCHEMA ujira TO ujira_fn_instances;
GRANT USAGE ON SCHEMA ujira TO ujira_fn_ledger;
GRANT USAGE ON SCHEMA ujira TO ujira_fn_audit;
GRANT USAGE ON SCHEMA ujira TO ujira_fn_erasure;
GRANT USAGE ON SCHEMA ujira TO ujira_ops;
GRANT USAGE ON SCHEMA ujira TO ujira_fn_fees;


--
-- Name: TYPE amount; Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON TYPE ujira.amount FROM PUBLIC;
GRANT ALL ON TYPE ujira.amount TO ujira_app;
GRANT ALL ON TYPE ujira.amount TO ujira_reader;
GRANT ALL ON TYPE ujira.amount TO ujira_retention;
GRANT ALL ON TYPE ujira.amount TO ujira_auth;
GRANT ALL ON TYPE ujira.amount TO ujira_indexer;
GRANT ALL ON TYPE ujira.amount TO ujira_fn_ledger;


--
-- Name: TYPE hash32; Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON TYPE ujira.hash32 FROM PUBLIC;
GRANT ALL ON TYPE ujira.hash32 TO ujira_app;
GRANT ALL ON TYPE ujira.hash32 TO ujira_reader;
GRANT ALL ON TYPE ujira.hash32 TO ujira_retention;
GRANT ALL ON TYPE ujira.hash32 TO ujira_auth;
GRANT ALL ON TYPE ujira.hash32 TO ujira_indexer;
GRANT ALL ON TYPE ujira.hash32 TO ujira_fn_audit;


--
-- Name: TYPE network_id; Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON TYPE ujira.network_id FROM PUBLIC;
GRANT ALL ON TYPE ujira.network_id TO ujira_app;
GRANT ALL ON TYPE ujira.network_id TO ujira_reader;


--
-- Name: TYPE scale; Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON TYPE ujira.scale FROM PUBLIC;
GRANT ALL ON TYPE ujira.scale TO ujira_app;
GRANT ALL ON TYPE ujira.scale TO ujira_reader;
GRANT ALL ON TYPE ujira.scale TO ujira_retention;
GRANT ALL ON TYPE ujira.scale TO ujira_auth;
GRANT ALL ON TYPE ujira.scale TO ujira_indexer;


--
-- Name: TYPE u64; Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON TYPE ujira.u64 FROM PUBLIC;
GRANT ALL ON TYPE ujira.u64 TO ujira_app;
GRANT ALL ON TYPE ujira.u64 TO ujira_reader;


--
-- Name: FUNCTION active_routing_config(); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.active_routing_config() FROM PUBLIC;
GRANT ALL ON FUNCTION ops.active_routing_config() TO ujira_app;


--
-- Name: FUNCTION active_signing_keys(purposes text[]); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.active_signing_keys(purposes text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.active_signing_keys(purposes text[]) TO ujira_app;


--
-- Name: FUNCTION identity_provider_event_seen(p_provider text, p_provider_account text, p_event_key text); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.identity_provider_event_seen(p_provider text, p_provider_account text, p_event_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.identity_provider_event_seen(p_provider text, p_provider_account text, p_event_key text) TO ujira_app;


--
-- Name: FUNCTION keep_signing_key(); Type: ACL; Schema: ops; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ops.keep_signing_key() FROM PUBLIC;


--
-- Name: FUNCTION lease_executor(target_network text, holder text, lease_seconds integer); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.lease_executor(target_network text, holder text, lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.lease_executor(target_network text, holder text, lease_seconds integer) TO ujira_app;


--
-- Name: FUNCTION record_identity_provider_event(p_provider text, p_provider_account text, p_event_key text, p_raw_sha256 bytea); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.record_identity_provider_event(p_provider text, p_provider_account text, p_event_key text, p_raw_sha256 bytea) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.record_identity_provider_event(p_provider text, p_provider_account text, p_event_key text, p_raw_sha256 bytea) TO ujira_app;


--
-- Name: FUNCTION release_executor(target_network text, account text, holder text, sequence_reached bigint); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.release_executor(target_network text, account text, holder text, sequence_reached bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.release_executor(target_network text, account text, holder text, sequence_reached bigint) TO ujira_app;


--
-- Name: FUNCTION apply_tenant_policies(target regclass); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.apply_tenant_policies(target regclass) FROM PUBLIC;


--
-- Name: FUNCTION attestation_pending(p_digest bytea); Type: ACL; Schema: ujira; Owner: ujira_signer_read
--

REVOKE ALL ON FUNCTION ujira.attestation_pending(p_digest bytea) FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.attestation_pending(p_digest bytea) TO ujira_signer_attester;


--
-- Name: FUNCTION audit_chain(); Type: ACL; Schema: ujira; Owner: ujira_fn_audit
--

REVOKE ALL ON FUNCTION ujira.audit_chain() FROM PUBLIC;


--
-- Name: FUNCTION audit_check_metadata(metadata jsonb); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.audit_check_metadata(metadata jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.audit_check_metadata(metadata jsonb) TO ujira_fn_audit;


--
-- Name: FUNCTION audit_row_hash(prev_hash bytea, principal_id uuid, project_id uuid, seq bigint, action text, actor_kind text, actor_id uuid, metadata jsonb, occurred_at timestamp with time zone); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.audit_row_hash(prev_hash bytea, principal_id uuid, project_id uuid, seq bigint, action text, actor_kind text, actor_id uuid, metadata jsonb, occurred_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.audit_row_hash(prev_hash bytea, principal_id uuid, project_id uuid, seq bigint, action text, actor_kind text, actor_id uuid, metadata jsonb, occurred_at timestamp with time zone) TO ujira_fn_audit;
GRANT ALL ON FUNCTION ujira.audit_row_hash(prev_hash bytea, principal_id uuid, project_id uuid, seq bigint, action text, actor_kind text, actor_id uuid, metadata jsonb, occurred_at timestamp with time zone) TO ujira_app;
GRANT ALL ON FUNCTION ujira.audit_row_hash(prev_hash bytea, principal_id uuid, project_id uuid, seq bigint, action text, actor_kind text, actor_id uuid, metadata jsonb, occurred_at timestamp with time zone) TO ujira_reader;


--
-- Name: FUNCTION authenticate_token(token_prefix text); Type: ACL; Schema: ujira; Owner: ujira_fn_tokens
--

REVOKE ALL ON FUNCTION ujira.authenticate_token(token_prefix text) FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.authenticate_token(token_prefix text) TO ujira_app;
GRANT ALL ON FUNCTION ujira.authenticate_token(token_prefix text) TO ujira_auth;


--
-- Name: FUNCTION check_new_funding_sweep(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.check_new_funding_sweep() FROM PUBLIC;


--
-- Name: FUNCTION check_reporting_time_zone(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.check_reporting_time_zone() FROM PUBLIC;


--
-- Name: FUNCTION check_transition(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.check_transition() FROM PUBLIC;


--
-- Name: FUNCTION create_principal(principal_name text, project_name text, owner_user_id uuid, reporting_time_zone text); Type: ACL; Schema: ujira; Owner: ujira_fn_principals
--

REVOKE ALL ON FUNCTION ujira.create_principal(principal_name text, project_name text, owner_user_id uuid, reporting_time_zone text) FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.create_principal(principal_name text, project_name text, owner_user_id uuid, reporting_time_zone text) TO ujira_app;


--
-- Name: FUNCTION current_principal_id(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.current_principal_id() FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.current_principal_id() TO ujira_app;
GRANT ALL ON FUNCTION ujira.current_principal_id() TO ujira_reader;
GRANT ALL ON FUNCTION ujira.current_principal_id() TO ujira_retention;
GRANT ALL ON FUNCTION ujira.current_principal_id() TO ujira_auth;
GRANT ALL ON FUNCTION ujira.current_principal_id() TO ujira_indexer;
GRANT ALL ON FUNCTION ujira.current_principal_id() TO ujira_fn_fees;


--
-- Name: FUNCTION current_project_id(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.current_project_id() FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.current_project_id() TO ujira_app;
GRANT ALL ON FUNCTION ujira.current_project_id() TO ujira_reader;
GRANT ALL ON FUNCTION ujira.current_project_id() TO ujira_retention;
GRANT ALL ON FUNCTION ujira.current_project_id() TO ujira_auth;
GRANT ALL ON FUNCTION ujira.current_project_id() TO ujira_indexer;
GRANT ALL ON FUNCTION ujira.current_project_id() TO ujira_fn_fees;


--
-- Name: FUNCTION data_key_stays_shredded(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.data_key_stays_shredded() FROM PUBLIC;


--
-- Name: FUNCTION erased_subjects(after_id uuid, page_size bigint); Type: ACL; Schema: ujira; Owner: ujira_fn_erasure
--

REVOKE ALL ON FUNCTION ujira.erased_subjects(after_id uuid, page_size bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.erased_subjects(after_id uuid, page_size bigint) TO ujira_ops;


--
-- Name: FUNCTION fee_cap_only_lowers(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.fee_cap_only_lowers() FROM PUBLIC;


--
-- Name: FUNCTION fee_reconciliation_needs_execution(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.fee_reconciliation_needs_execution() FROM PUBLIC;


--
-- Name: FUNCTION fee_refunds_within_fee(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.fee_refunds_within_fee() FROM PUBLIC;


--
-- Name: FUNCTION forbid_mutation(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.forbid_mutation() FROM PUBLIC;


--
-- Name: FUNCTION funding_hold_is_held(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.funding_hold_is_held() FROM PUBLIC;


--
-- Name: FUNCTION keep_funding_sweep(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.keep_funding_sweep() FROM PUBLIC;


--
-- Name: FUNCTION keep_managed_signer(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.keep_managed_signer() FROM PUBLIC;


--
-- Name: FUNCTION keep_token_revoked(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.keep_token_revoked() FROM PUBLIC;


--
-- Name: FUNCTION ledger_accounts_guard(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.ledger_accounts_guard() FROM PUBLIC;


--
-- Name: FUNCTION ledger_balanced(); Type: ACL; Schema: ujira; Owner: ujira_fn_ledger
--

REVOKE ALL ON FUNCTION ujira.ledger_balanced() FROM PUBLIC;


--
-- Name: FUNCTION ledger_stamp(); Type: ACL; Schema: ujira; Owner: ujira_fn_ledger
--

REVOKE ALL ON FUNCTION ujira.ledger_stamp() FROM PUBLIC;


--
-- Name: FUNCTION leg_refund_stamp(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.leg_refund_stamp() FROM PUBLIC;


--
-- Name: FUNCTION leg_refunds_within_leg(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.leg_refunds_within_leg() FROM PUBLIC;


--
-- Name: FUNCTION legs_match_attempt(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.legs_match_attempt() FROM PUBLIC;


--
-- Name: FUNCTION legs_match_method(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.legs_match_method() FROM PUBLIC;


--
-- Name: FUNCTION payout_attempt_needs_open_payout(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.payout_attempt_needs_open_payout() FROM PUBLIC;


--
-- Name: FUNCTION payout_instance_matches(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.payout_instance_matches() FROM PUBLIC;


--
-- Name: FUNCTION payout_left_its_holds(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.payout_left_its_holds() FROM PUBLIC;


--
-- Name: FUNCTION payout_leg_stamp(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.payout_leg_stamp() FROM PUBLIC;


--
-- Name: FUNCTION project_scope_all(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.project_scope_all() FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.project_scope_all() TO ujira_app;
GRANT ALL ON FUNCTION ujira.project_scope_all() TO ujira_reader;
GRANT ALL ON FUNCTION ujira.project_scope_all() TO ujira_retention;
GRANT ALL ON FUNCTION ujira.project_scope_all() TO ujira_auth;
GRANT ALL ON FUNCTION ujira.project_scope_all() TO ujira_indexer;
GRANT ALL ON FUNCTION ujira.project_scope_all() TO ujira_fn_fees;


--
-- Name: FUNCTION receipt_is_whole(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.receipt_is_whole() FROM PUBLIC;


--
-- Name: FUNCTION recipient_stays_erased(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.recipient_stays_erased() FROM PUBLIC;


--
-- Name: FUNCTION record_fee_terms(p_rate_bps bigint, p_basis text, p_valid_from timestamp with time zone, p_contract_reference text, p_actor_kind text, p_actor_id uuid); Type: ACL; Schema: ujira; Owner: ujira_fn_fees
--

REVOKE ALL ON FUNCTION ujira.record_fee_terms(p_rate_bps bigint, p_basis text, p_valid_from timestamp with time zone, p_contract_reference text, p_actor_kind text, p_actor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.record_fee_terms(p_rate_bps bigint, p_basis text, p_valid_from timestamp with time zone, p_contract_reference text, p_actor_kind text, p_actor_id uuid) TO ujira_app;


--
-- Name: FUNCTION refuse_personal_data_after_erasure(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.refuse_personal_data_after_erasure() FROM PUBLIC;


--
-- Name: FUNCTION replay_erasure(target_principal uuid, target_project uuid, target_subject uuid); Type: ACL; Schema: ujira; Owner: ujira_fn_erasure
--

REVOKE ALL ON FUNCTION ujira.replay_erasure(target_principal uuid, target_project uuid, target_subject uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.replay_erasure(target_principal uuid, target_project uuid, target_subject uuid) TO ujira_ops;


--
-- Name: FUNCTION resolve_mandate_instance(target_chain text, target_address text); Type: ACL; Schema: ujira; Owner: ujira_fn_instances
--

REVOKE ALL ON FUNCTION ujira.resolve_mandate_instance(target_chain text, target_address text) FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.resolve_mandate_instance(target_chain text, target_address text) TO ujira_indexer;


--
-- Name: FUNCTION touch(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.touch() FROM PUBLIC;


--
-- Name: TABLE chain_cursors; Type: ACL; Schema: ops; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ops.chain_cursors TO ujira_ops;


--
-- Name: TABLE executor_accounts; Type: ACL; Schema: ops; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ops.executor_accounts TO ujira_ops;


--
-- Name: TABLE fee_estimates; Type: ACL; Schema: ops; Owner: ujira_owner
--

GRANT SELECT ON TABLE ops.fee_estimates TO ujira_app;
GRANT SELECT,INSERT,UPDATE ON TABLE ops.fee_estimates TO ujira_ops;


--
-- Name: TABLE identity_provider_events; Type: ACL; Schema: ops; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ops.identity_provider_events TO ujira_ops;


--
-- Name: TABLE routing_config_active; Type: ACL; Schema: ops; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ops.routing_config_active TO ujira_ops;


--
-- Name: TABLE routing_config_versions; Type: ACL; Schema: ops; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ops.routing_config_versions TO ujira_ops;


--
-- Name: TABLE signing_keys; Type: ACL; Schema: ops; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ops.signing_keys TO ujira_ops;


--
-- Name: TABLE api_tokens; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.api_tokens TO ujira_app;
GRANT SELECT ON TABLE ujira.api_tokens TO ujira_reader;
GRANT SELECT ON TABLE ujira.api_tokens TO ujira_fn_tokens;


--
-- Name: TABLE approvals; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.approvals TO ujira_app;
GRANT SELECT ON TABLE ujira.approvals TO ujira_reader;


--
-- Name: TABLE audit_heads; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.audit_heads TO ujira_app;
GRANT SELECT ON TABLE ujira.audit_heads TO ujira_reader;
GRANT SELECT,INSERT,UPDATE ON TABLE ujira.audit_heads TO ujira_fn_audit;


--
-- Name: TABLE audit_log; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.audit_log TO ujira_app;
GRANT SELECT ON TABLE ujira.audit_log TO ujira_reader;
GRANT INSERT ON TABLE ujira.audit_log TO ujira_fn_fees;


--
-- Name: TABLE audit_metadata_keys; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.audit_metadata_keys TO ujira_fn_audit;


--
-- Name: TABLE chain_events; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.chain_events TO ujira_app;
GRANT SELECT ON TABLE ujira.chain_events TO ujira_reader;
GRANT SELECT,INSERT ON TABLE ujira.chain_events TO ujira_indexer;


--
-- Name: TABLE chains; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.chains TO ujira_app;
GRANT SELECT ON TABLE ujira.chains TO ujira_reader;
GRANT SELECT ON TABLE ujira.chains TO ujira_retention;
GRANT SELECT ON TABLE ujira.chains TO ujira_auth;
GRANT SELECT ON TABLE ujira.chains TO ujira_indexer;


--
-- Name: TABLE currencies; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.currencies TO ujira_app;
GRANT SELECT ON TABLE ujira.currencies TO ujira_reader;
GRANT SELECT ON TABLE ujira.currencies TO ujira_retention;
GRANT SELECT ON TABLE ujira.currencies TO ujira_auth;
GRANT SELECT ON TABLE ujira.currencies TO ujira_indexer;


--
-- Name: TABLE currency_scales; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.currency_scales TO ujira_app;
GRANT SELECT ON TABLE ujira.currency_scales TO ujira_reader;
GRANT SELECT ON TABLE ujira.currency_scales TO ujira_retention;
GRANT SELECT ON TABLE ujira.currency_scales TO ujira_auth;
GRANT SELECT ON TABLE ujira.currency_scales TO ujira_indexer;


--
-- Name: TABLE data_keys; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.data_keys TO ujira_app;
GRANT SELECT,INSERT,UPDATE ON TABLE ujira.data_keys TO ujira_fn_erasure;


--
-- Name: COLUMN data_keys.wrapped_key; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(wrapped_key) ON TABLE ujira.data_keys TO ujira_app;


--
-- Name: COLUMN data_keys.kek_id; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(kek_id) ON TABLE ujira.data_keys TO ujira_app;


--
-- Name: COLUMN data_keys.shredded_at; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(shredded_at) ON TABLE ujira.data_keys TO ujira_app;


--
-- Name: TABLE deposits; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.deposits TO ujira_app;
GRANT SELECT ON TABLE ujira.deposits TO ujira_reader;
GRANT SELECT,INSERT ON TABLE ujira.deposits TO ujira_indexer;


--
-- Name: TABLE erasure_log; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.erasure_log TO ujira_app;
GRANT SELECT,INSERT ON TABLE ujira.erasure_log TO ujira_fn_erasure;


--
-- Name: TABLE fee_reconciliations; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.fee_reconciliations TO ujira_app;
GRANT SELECT ON TABLE ujira.fee_reconciliations TO ujira_reader;


--
-- Name: TABLE fee_refunds; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.fee_refunds TO ujira_app;
GRANT SELECT ON TABLE ujira.fee_refunds TO ujira_reader;


--
-- Name: COLUMN fee_refunds.status; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(status) ON TABLE ujira.fee_refunds TO ujira_app;


--
-- Name: COLUMN fee_refunds.tx_hash; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(tx_hash) ON TABLE ujira.fee_refunds TO ujira_app;


--
-- Name: COLUMN fee_refunds.failure_reason; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(failure_reason) ON TABLE ujira.fee_refunds TO ujira_app;


--
-- Name: TABLE fee_terms; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.fee_terms TO ujira_app;
GRANT SELECT ON TABLE ujira.fee_terms TO ujira_reader;
GRANT INSERT ON TABLE ujira.fee_terms TO ujira_fn_fees;


--
-- Name: TABLE funding_sources; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.funding_sources TO ujira_app;
GRANT SELECT ON TABLE ujira.funding_sources TO ujira_reader;


--
-- Name: TABLE funding_sweeps; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.funding_sweeps TO ujira_app;
GRANT SELECT ON TABLE ujira.funding_sweeps TO ujira_reader;


--
-- Name: TABLE ledger_accounts; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.ledger_accounts TO ujira_app;
GRANT SELECT ON TABLE ujira.ledger_accounts TO ujira_reader;
GRANT SELECT,INSERT ON TABLE ujira.ledger_accounts TO ujira_indexer;
GRANT SELECT,UPDATE ON TABLE ujira.ledger_accounts TO ujira_fn_ledger;


--
-- Name: TABLE ledger_entries; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.ledger_entries TO ujira_app;
GRANT SELECT ON TABLE ujira.ledger_entries TO ujira_reader;
GRANT SELECT,INSERT ON TABLE ujira.ledger_entries TO ujira_indexer;
GRANT SELECT ON TABLE ujira.ledger_entries TO ujira_fn_ledger;


--
-- Name: TABLE ledger_journals; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.ledger_journals TO ujira_app;
GRANT SELECT ON TABLE ujira.ledger_journals TO ujira_reader;
GRANT SELECT,INSERT ON TABLE ujira.ledger_journals TO ujira_indexer;


--
-- Name: TABLE mandate_state_snapshots; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.mandate_state_snapshots TO ujira_app;
GRANT SELECT ON TABLE ujira.mandate_state_snapshots TO ujira_reader;
GRANT SELECT,INSERT ON TABLE ujira.mandate_state_snapshots TO ujira_indexer;


--
-- Name: TABLE ledger_reconciliation; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.ledger_reconciliation TO ujira_app;
GRANT SELECT ON TABLE ujira.ledger_reconciliation TO ujira_reader;
GRANT SELECT ON TABLE ujira.ledger_reconciliation TO ujira_indexer;


--
-- Name: TABLE leg_refunds; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.leg_refunds TO ujira_app;
GRANT SELECT ON TABLE ujira.leg_refunds TO ujira_reader;


--
-- Name: TABLE managed_signers; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.managed_signers TO ujira_app;
GRANT SELECT ON TABLE ujira.managed_signers TO ujira_reader;


--
-- Name: TABLE mandate_instance_roles; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.mandate_instance_roles TO ujira_app;
GRANT SELECT ON TABLE ujira.mandate_instance_roles TO ujira_reader;
GRANT SELECT,INSERT,UPDATE ON TABLE ujira.mandate_instance_roles TO ujira_indexer;


--
-- Name: TABLE mandate_instances; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.mandate_instances TO ujira_app;
GRANT SELECT ON TABLE ujira.mandate_instances TO ujira_reader;
GRANT SELECT ON TABLE ujira.mandate_instances TO ujira_fn_instances;
GRANT SELECT ON TABLE ujira.mandate_instances TO ujira_indexer;


--
-- Name: COLUMN mandate_instances.max_fee_bps; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(max_fee_bps) ON TABLE ujira.mandate_instances TO ujira_indexer;


--
-- Name: COLUMN mandate_instances.fee_address; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(fee_address) ON TABLE ujira.mandate_instances TO ujira_indexer;


--
-- Name: TABLE mandates; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.mandates TO ujira_app;
GRANT SELECT ON TABLE ujira.mandates TO ujira_reader;


--
-- Name: TABLE payout_attempts; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.payout_attempts TO ujira_app;
GRANT SELECT ON TABLE ujira.payout_attempts TO ujira_reader;


--
-- Name: COLUMN payout_attempts.on_chain_payout_id; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(on_chain_payout_id) ON TABLE ujira.payout_attempts TO ujira_app;


--
-- Name: COLUMN payout_attempts.dead_proof; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(dead_proof) ON TABLE ujira.payout_attempts TO ujira_app;


--
-- Name: COLUMN payout_attempts.status; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(status) ON TABLE ujira.payout_attempts TO ujira_app;


--
-- Name: TABLE payout_batches; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.payout_batches TO ujira_app;
GRANT SELECT ON TABLE ujira.payout_batches TO ujira_reader;


--
-- Name: TABLE payout_funding_holds; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE ujira.payout_funding_holds TO ujira_app;
GRANT SELECT ON TABLE ujira.payout_funding_holds TO ujira_reader;


--
-- Name: TABLE payout_legs; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.payout_legs TO ujira_app;
GRANT SELECT ON TABLE ujira.payout_legs TO ujira_reader;


--
-- Name: COLUMN payout_legs.chain_tx_hash; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(chain_tx_hash) ON TABLE ujira.payout_legs TO ujira_app;


--
-- Name: COLUMN payout_legs.status; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(status) ON TABLE ujira.payout_legs TO ujira_app;


--
-- Name: TABLE payout_methods; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.payout_methods TO ujira_app;
GRANT SELECT ON TABLE ujira.payout_methods TO ujira_reader;
GRANT SELECT,UPDATE ON TABLE ujira.payout_methods TO ujira_fn_erasure;


--
-- Name: TABLE payouts; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.payouts TO ujira_app;
GRANT SELECT ON TABLE ujira.payouts TO ujira_reader;


--
-- Name: COLUMN payouts.total_amount; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(total_amount) ON TABLE ujira.payouts TO ujira_app;


--
-- Name: COLUMN payouts.total_asset; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(total_asset) ON TABLE ujira.payouts TO ujira_app;


--
-- Name: COLUMN payouts.total_chain; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(total_chain) ON TABLE ujira.payouts TO ujira_app;


--
-- Name: COLUMN payouts.total_scale; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(total_scale) ON TABLE ujira.payouts TO ujira_app;


--
-- Name: COLUMN payouts.status; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(status) ON TABLE ujira.payouts TO ujira_app;


--
-- Name: COLUMN payouts.status_reason; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT UPDATE(status_reason) ON TABLE ujira.payouts TO ujira_app;


--
-- Name: TABLE principal_members; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.principal_members TO ujira_app;
GRANT SELECT ON TABLE ujira.principal_members TO ujira_reader;
GRANT INSERT ON TABLE ujira.principal_members TO ujira_fn_principals;


--
-- Name: TABLE principals; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,UPDATE ON TABLE ujira.principals TO ujira_app;
GRANT SELECT ON TABLE ujira.principals TO ujira_reader;
GRANT INSERT ON TABLE ujira.principals TO ujira_fn_principals;


--
-- Name: TABLE project_payout_minimums; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.project_payout_minimums TO ujira_app;
GRANT SELECT ON TABLE ujira.project_payout_minimums TO ujira_reader;


--
-- Name: TABLE projects; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.projects TO ujira_app;
GRANT SELECT ON TABLE ujira.projects TO ujira_reader;
GRANT INSERT ON TABLE ujira.projects TO ujira_fn_principals;


--
-- Name: TABLE receipt_legs; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.receipt_legs TO ujira_app;
GRANT SELECT ON TABLE ujira.receipt_legs TO ujira_reader;


--
-- Name: TABLE receipts; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.receipts TO ujira_app;
GRANT SELECT ON TABLE ujira.receipts TO ujira_reader;


--
-- Name: TABLE recipient_identities; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.recipient_identities TO ujira_app;
GRANT SELECT ON TABLE ujira.recipient_identities TO ujira_reader;
GRANT SELECT,UPDATE ON TABLE ujira.recipient_identities TO ujira_fn_erasure;


--
-- Name: TABLE recipient_pii; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ujira.recipient_pii TO ujira_app;
GRANT SELECT,DELETE ON TABLE ujira.recipient_pii TO ujira_fn_erasure;


--
-- Name: TABLE recipients; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.recipients TO ujira_app;
GRANT SELECT ON TABLE ujira.recipients TO ujira_reader;
GRANT SELECT,UPDATE ON TABLE ujira.recipients TO ujira_fn_erasure;


--
-- Name: TABLE settlement_tokens; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.settlement_tokens TO ujira_app;
GRANT SELECT ON TABLE ujira.settlement_tokens TO ujira_reader;
GRANT SELECT ON TABLE ujira.settlement_tokens TO ujira_retention;
GRANT SELECT ON TABLE ujira.settlement_tokens TO ujira_auth;
GRANT SELECT ON TABLE ujira.settlement_tokens TO ujira_indexer;


--
-- Name: TABLE status_transitions; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.status_transitions TO ujira_app;
GRANT SELECT ON TABLE ujira.status_transitions TO ujira_reader;
GRANT SELECT ON TABLE ujira.status_transitions TO ujira_retention;
GRANT SELECT ON TABLE ujira.status_transitions TO ujira_auth;
GRANT SELECT ON TABLE ujira.status_transitions TO ujira_indexer;


--
-- Name: DEFAULT PRIVILEGES FOR TYPES; Type: DEFAULT ACL; Schema: -; Owner: ujira_owner
--

ALTER DEFAULT PRIVILEGES FOR ROLE ujira_owner REVOKE ALL ON TYPES FROM PUBLIC;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: -; Owner: ujira_owner
--

ALTER DEFAULT PRIVILEGES FOR ROLE ujira_owner REVOKE ALL ON FUNCTIONS FROM PUBLIC;


--
-- PostgreSQL database dump complete
--

\unrestrict ujira

