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
-- Name: advance_chain_cursor(text, text); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.advance_chain_cursor(target_network text, next_cursor text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  insert into ops.chain_cursors (network, cursor)
  values (target_network, next_cursor)
  on conflict (network) do update set cursor = excluded.cursor
$$;


ALTER FUNCTION ops.advance_chain_cursor(target_network text, next_cursor text) OWNER TO ujira_ops;

--
-- Name: chain_cursor(text); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.chain_cursor(target_network text) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  select c.cursor from ops.chain_cursors as c where c.network = target_network
$$;


ALTER FUNCTION ops.chain_cursor(target_network text) OWNER TO ujira_ops;

--
-- Name: email_quota_take(text, text, integer, integer); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.email_quota_take(p_provider_account text, p_kind text, p_cap integer, p_code_reserve integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
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
$$;


ALTER FUNCTION ops.email_quota_take(p_provider_account text, p_kind text, p_cap integer, p_code_reserve integer) OWNER TO ujira_ops;

--
-- Name: flag_mandate(text, text); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.flag_mandate(target_network text, contract text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  flagged integer;
begin
  update ops.mandate_registry as r
     set flagged_at = coalesce(r.flagged_at, clock_timestamp())
   where r.network = target_network
     and r.contract_id = contract;
  get diagnostics flagged = row_count;
  return flagged > 0;
end
$$;


ALTER FUNCTION ops.flag_mandate(target_network text, contract text) OWNER TO ujira_ops;

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
-- Name: register_mandate(text, text, text, bytea, bytea, bigint, bigint); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.register_mandate(target_network text, contract text, factory text, tag bytea, tx bytea, event_at bigint, at_ledger bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  added integer;
begin
  insert into ops.mandate_registry
    (network, contract_id, factory_id, tenant_tag, tx_hash, event_index, ledger)
  values (target_network, contract, factory, tag, tx, event_at, at_ledger)
  on conflict (network, contract_id) do nothing;
  get diagnostics added = row_count;
  return added > 0;
end
$$;


ALTER FUNCTION ops.register_mandate(target_network text, contract text, factory text, tag bytea, tx bytea, event_at bigint, at_ledger bigint) OWNER TO ujira_ops;

--
-- Name: registered_mandate(text, text); Type: FUNCTION; Schema: ops; Owner: ujira_ops
--

CREATE FUNCTION ops.registered_mandate(target_network text, contract text) RETURNS TABLE(factory_id text, tenant_tag bytea, flagged boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  select r.factory_id, r.tenant_tag, r.flagged_at is not null
    from ops.mandate_registry as r
   where r.network = target_network
     and r.contract_id = contract
$$;


ALTER FUNCTION ops.registered_mandate(target_network text, contract text) OWNER TO ujira_ops;

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
  select a.principal_id, a.project_id, a.id
    from ujira.attestations as a
   where a.digest = p_digest
     and a.status = 'pending'
$$;


ALTER FUNCTION ujira.attestation_pending(p_digest bytea) OWNER TO ujira_signer_read;

--
-- Name: attestation_status_only(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.attestation_status_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
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
$$;


ALTER FUNCTION ujira.attestation_status_only() OWNER TO ujira_owner;

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
-- Name: check_payout_booking(); Type: FUNCTION; Schema: ujira; Owner: ujira_fn_instances
--

CREATE FUNCTION ujira.check_payout_booking() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if not exists (
    select 1
      from ujira.mandate_instances as i
     where i.id = new.mandate_instance_id
       and i.principal_id = new.principal_id
       and i.project_id = new.project_id
       and i.chain = new.chain
       and i.contract_address = new.contract_address
  ) then
    raise exception using
      errcode = '23503',
      message = 'a payout booking names its mandate instance''s own contract';
  end if;
  return null;
end
$$;


ALTER FUNCTION ujira.check_payout_booking() OWNER TO ujira_fn_instances;

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
-- Name: keep_payout_booking(); Type: FUNCTION; Schema: ujira; Owner: ujira_owner
--

CREATE FUNCTION ujira.keep_payout_booking() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if new.principal_id <> old.principal_id or new.project_id <> old.project_id
     or new.mandate_instance_id <> old.mandate_instance_id or new.chain <> old.chain
     or new.contract_address <> old.contract_address or new.payout_id <> old.payout_id then
    raise exception using
      errcode = 'UJ006',
      message = 'a payout booking keeps its tenant, contract and payout';
  end if;
  return new;
end
$$;


ALTER FUNCTION ujira.keep_payout_booking() OWNER TO ujira_owner;

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
-- Name: email_quota_usage; Type: TABLE; Schema: ops; Owner: ujira_owner
--

CREATE TABLE ops.email_quota_usage (
    provider_account text NOT NULL,
    day date NOT NULL,
    kind text NOT NULL,
    sent integer DEFAULT 0 NOT NULL,
    refused integer DEFAULT 0 NOT NULL,
    exhausted boolean DEFAULT false NOT NULL,
    CONSTRAINT email_quota_usage_account_format CHECK ((provider_account ~ '^[A-Za-z0-9_.:-]{1,128}$'::text)),
    CONSTRAINT email_quota_usage_kind CHECK ((kind = ANY (ARRAY['code'::text, 'other'::text]))),
    CONSTRAINT email_quota_usage_refused_range CHECK ((refused >= 0)),
    CONSTRAINT email_quota_usage_sent_range CHECK ((sent >= 0))
);


ALTER TABLE ops.email_quota_usage OWNER TO ujira_owner;

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
-- Name: mandate_registry; Type: TABLE; Schema: ops; Owner: ujira_owner
--

CREATE TABLE ops.mandate_registry (
    network text NOT NULL,
    contract_id text NOT NULL,
    factory_id text NOT NULL,
    tenant_tag bytea NOT NULL,
    tx_hash bytea NOT NULL,
    event_index bigint NOT NULL,
    ledger bigint NOT NULL,
    flagged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mandate_registry_contract_length CHECK (((char_length(contract_id) >= 1) AND (char_length(contract_id) <= 128))),
    CONSTRAINT mandate_registry_factory_length CHECK (((char_length(factory_id) >= 1) AND (char_length(factory_id) <= 128))),
    CONSTRAINT mandate_registry_index_positive CHECK ((event_index >= 0)),
    CONSTRAINT mandate_registry_ledger_positive CHECK ((ledger >= 0)),
    CONSTRAINT mandate_registry_network_format CHECK ((network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'::text)),
    CONSTRAINT mandate_registry_tag_length CHECK ((octet_length(tenant_tag) = 32)),
    CONSTRAINT mandate_registry_tx_length CHECK ((octet_length(tx_hash) = 32))
);


ALTER TABLE ops.mandate_registry OWNER TO ujira_owner;

--
-- Name: rate_limit_buckets; Type: TABLE; Schema: ops; Owner: ujira_owner
--

CREATE UNLOGGED TABLE ops.rate_limit_buckets (
    bucket_key text NOT NULL,
    tokens numeric(18,6) NOT NULL,
    refilled_at timestamp with time zone NOT NULL,
    CONSTRAINT rate_limit_buckets_key_format CHECK ((bucket_key ~ '^[a-z_]{1,32}:[0-9a-f]{64}$'::text)),
    CONSTRAINT rate_limit_buckets_tokens_not_negative CHECK ((tokens >= (0)::numeric))
);


ALTER TABLE ops.rate_limit_buckets OWNER TO ujira_owner;

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
-- Name: agent_identity_links; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.agent_identity_links (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    network text NOT NULL,
    address text NOT NULL,
    registry text NOT NULL,
    token_id numeric NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    human_backed_until timestamp with time zone,
    display_name text,
    last_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_identity_links_address_length CHECK (((char_length(address) >= 1) AND (char_length(address) <= 128))),
    CONSTRAINT agent_identity_links_display_length CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 200))),
    CONSTRAINT agent_identity_links_network_format CHECK ((network ~ '^[a-z0-9]{1,16}:[-a-z0-9_]{1,32}$'::text)),
    CONSTRAINT agent_identity_links_registry_length CHECK (((char_length(registry) >= 1) AND (char_length(registry) <= 128))),
    CONSTRAINT agent_identity_links_status CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'revoked'::text]))),
    CONSTRAINT agent_identity_links_token_range CHECK ((((token_id >= (0)::numeric) AND (token_id <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric)) AND (scale(token_id) = 0)))
);

ALTER TABLE ONLY ujira.agent_identity_links FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.agent_identity_links OWNER TO ujira_owner;

--
-- Name: api_tokens; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.api_tokens (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    prefix text NOT NULL,
    secret_sha256 ujira.hash32 NOT NULL,
    scopes text[] NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_from_id uuid,
    CONSTRAINT api_tokens_prefix_format CHECK ((prefix ~ '^[A-Za-z0-9_]{8,40}$'::text)),
    CONSTRAINT api_tokens_scopes_known CHECK ((((cardinality(scopes) >= 1) AND (cardinality(scopes) <= 10)) AND (scopes <@ ARRAY['payouts:read'::text, 'payouts:write'::text, 'approvals:write'::text, 'recipients:read'::text, 'recipients:write'::text, 'mandates:read'::text, 'mandates:write'::text, 'receipts:read'::text, 'webhooks:manage'::text, 'corridors:read'::text])))
);

ALTER TABLE ONLY ujira.api_tokens FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.api_tokens OWNER TO ujira_owner;

--
-- Name: attestations; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.attestations (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mandate_instance_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    leg_index smallint NOT NULL,
    recipient_id uuid NOT NULL,
    method_id uuid NOT NULL,
    destination_address text NOT NULL,
    has_tag boolean DEFAULT false NOT NULL,
    destination_tag ujira.u64,
    country_policy_hash ujira.hash32 NOT NULL,
    policy_epoch ujira.u64 NOT NULL,
    valid_until timestamp with time zone NOT NULL,
    attester_key_id text NOT NULL,
    digest ujira.hash32 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    signature bytea,
    failure_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attestations_address_length CHECK (((char_length(destination_address) >= 1) AND (char_length(destination_address) <= 128))),
    CONSTRAINT attestations_failed_has_code CHECK (((status = 'failed'::text) = (failure_code IS NOT NULL))),
    CONSTRAINT attestations_failure_format CHECK ((failure_code ~ '^[A-Z0-9_]{1,64}$'::text)),
    CONSTRAINT attestations_key_id_length CHECK (((char_length(attester_key_id) >= 1) AND (char_length(attester_key_id) <= 128))),
    CONSTRAINT attestations_leg_index_range CHECK (((leg_index >= 0) AND (leg_index <= 255))),
    CONSTRAINT attestations_signature_length CHECK ((octet_length(signature) = 64)),
    CONSTRAINT attestations_signed_has_signature CHECK (((status = 'signed'::text) = (signature IS NOT NULL))),
    CONSTRAINT attestations_status CHECK ((status = ANY (ARRAY['pending'::text, 'signed'::text, 'failed'::text]))),
    CONSTRAINT attestations_tag_canonical CHECK ((has_tag = (destination_tag IS NOT NULL)))
);

ALTER TABLE ONLY ujira.attestations FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.attestations OWNER TO ujira_owner;

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
-- Name: destination_verifications; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.destination_verifications (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    method_id uuid NOT NULL,
    level text NOT NULL,
    chain text NOT NULL,
    destination_address text NOT NULL,
    has_tag boolean DEFAULT false NOT NULL,
    destination_tag ujira.u64,
    scheme text,
    challenge_id uuid,
    signature text,
    signer_key text,
    partner_ref text,
    embed_session_id uuid,
    derived_from uuid,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT destination_verifications_address_length CHECK (((char_length(destination_address) >= 1) AND (char_length(destination_address) <= 128))),
    CONSTRAINT destination_verifications_derived_is_forwarder CHECK (((derived_from IS NULL) OR (level = 'forwarder_derived'::text))),
    CONSTRAINT destination_verifications_level CHECK ((level = ANY (ARRAY['wallet_signature'::text, 'wallet_session'::text, 'partner_confirmed'::text, 'forwarder_derived'::text, 'principal_asserted'::text]))),
    CONSTRAINT destination_verifications_partner_length CHECK (((char_length(partner_ref) >= 1) AND (char_length(partner_ref) <= 128))),
    CONSTRAINT destination_verifications_partner_needs_ref CHECK (((level <> 'partner_confirmed'::text) OR (partner_ref IS NOT NULL))),
    CONSTRAINT destination_verifications_scheme CHECK ((scheme = 'sep53'::text)),
    CONSTRAINT destination_verifications_session_is_wallet_session CHECK (((level = 'wallet_session'::text) = (embed_session_id IS NOT NULL))),
    CONSTRAINT destination_verifications_signature_length CHECK ((octet_length(signature) <= 2048)),
    CONSTRAINT destination_verifications_signer_format CHECK ((signer_key ~ '^G[A-Z2-7]{55}$'::text)),
    CONSTRAINT destination_verifications_signer_is_sep53 CHECK (((NOT (scheme IS DISTINCT FROM 'sep53'::text)) = (signer_key IS NOT NULL))),
    CONSTRAINT destination_verifications_tag_canonical CHECK ((has_tag = (destination_tag IS NOT NULL)))
);

ALTER TABLE ONLY ujira.destination_verifications FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.destination_verifications OWNER TO ujira_owner;

--
-- Name: embed_sessions; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.embed_sessions (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash ujira.hash32 NOT NULL,
    token_prefix text NOT NULL,
    recipient_id uuid NOT NULL,
    purpose text NOT NULL,
    allowed_origins text[] NOT NULL,
    created_by_token uuid,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT embed_sessions_origins_count CHECK (((cardinality(allowed_origins) >= 1) AND (cardinality(allowed_origins) <= 10))),
    CONSTRAINT embed_sessions_prefix_format CHECK ((token_prefix ~ '^ujes_(live|test)_[A-Za-z0-9]{8}$'::text)),
    CONSTRAINT embed_sessions_purpose CHECK ((purpose = ANY (ARRAY['onboarding'::text, 'method_change'::text, 'identity'::text])))
);

ALTER TABLE ONLY ujira.embed_sessions FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.embed_sessions OWNER TO ujira_owner;

--
-- Name: funding_account_sources; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.funding_account_sources (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    funding_account_id uuid NOT NULL,
    funding_source_id uuid NOT NULL,
    mandate_instance_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY ujira.funding_account_sources FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.funding_account_sources OWNER TO ujira_owner;

--
-- Name: funding_accounts; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.funding_accounts (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    network text NOT NULL,
    address text NOT NULL,
    sponsor text NOT NULL,
    sponsor_tx_hash ujira.hash32 NOT NULL,
    status text NOT NULL,
    faults text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT funding_accounts_address_length CHECK (((char_length(address) >= 1) AND (char_length(address) <= 128))),
    CONSTRAINT funding_accounts_network_length CHECK (((char_length(network) >= 1) AND (char_length(network) <= 64))),
    CONSTRAINT funding_accounts_sponsor_length CHECK (((char_length(sponsor) >= 1) AND (char_length(sponsor) <= 128))),
    CONSTRAINT funding_accounts_status CHECK ((status = ANY (ARRAY['active'::text, 'rejected'::text]))),
    CONSTRAINT funding_accounts_status_matches_faults CHECK (((status = 'active'::text) = (cardinality(faults) = 0)))
);

ALTER TABLE ONLY ujira.funding_accounts FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.funding_accounts OWNER TO ujira_owner;

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
    CONSTRAINT ledger_accounts_kind CHECK ((kind = ANY (ARRAY['balance'::text, 'pending'::text, 'committed'::text, 'spent'::text, 'external'::text])))
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
            sum((a_1.balance)::numeric) FILTER (WHERE (a_1.kind = 'spent'::text)) AS spent
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
    (((l.balance)::numeric = COALESCE(a.balance, (0)::numeric)) AND ((l.pending)::numeric = COALESCE(a.pending, (0)::numeric)) AND ((l.committed)::numeric = COALESCE(a.committed, (0)::numeric)) AND ((l.spent)::numeric = COALESCE(a.spent, (0)::numeric))) AS matches
   FROM (latest l
     LEFT JOIN accounts a ON ((a.mandate_instance_id = l.mandate_instance_id)));


ALTER VIEW ujira.ledger_reconciliation OWNER TO ujira_owner;

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
    CONSTRAINT mandate_instances_address_length CHECK (((char_length(contract_address) >= 1) AND (char_length(contract_address) <= 128))),
    CONSTRAINT mandate_instances_attester_key_length CHECK ((octet_length(attester_public_key) = 32)),
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
-- Name: payout_bookings; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.payout_bookings (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mandate_instance_id uuid NOT NULL,
    chain text NOT NULL,
    contract_address text NOT NULL,
    payout_id ujira.hash32 NOT NULL,
    last_event_id uuid NOT NULL,
    last_event_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_bookings_type_length CHECK (((char_length(last_event_type) >= 1) AND (char_length(last_event_type) <= 64)))
);

ALTER TABLE ONLY ujira.payout_bookings FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.payout_bookings OWNER TO ujira_owner;

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
    CONSTRAINT projects_chain_fallback CHECK ((chain_fallback = ANY (ARRAY['off'::text, 'verified_methods'::text]))),
    CONSTRAINT projects_funding_hold_range CHECK (((funding_hold_max_seconds >= 3600) AND (funding_hold_max_seconds <= 2592000))),
    CONSTRAINT projects_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200)))
);

ALTER TABLE ONLY ujira.projects FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.projects OWNER TO ujira_owner;

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
-- Name: wallet_proof_challenges; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.wallet_proof_challenges (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    method_id uuid,
    purpose text NOT NULL,
    network text NOT NULL,
    address text NOT NULL,
    has_tag boolean DEFAULT false NOT NULL,
    tag ujira.u64,
    recipient_ref ujira.hash32 NOT NULL,
    request_id uuid NOT NULL,
    nonce_hash ujira.hash32 NOT NULL,
    message_hash ujira.hash32 NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_proof_challenges_address_length CHECK (((char_length(address) >= 1) AND (char_length(address) <= 128))),
    CONSTRAINT wallet_proof_challenges_expiry_after_issue CHECK ((expires_at > issued_at)),
    CONSTRAINT wallet_proof_challenges_network_format CHECK ((network ~ '^[a-z0-9]{1,16}:[-a-z0-9_]{1,32}$'::text)),
    CONSTRAINT wallet_proof_challenges_purpose CHECK ((purpose = ANY (ARRAY['payout_destination'::text, 'member_wallet'::text, 'agent_link'::text]))),
    CONSTRAINT wallet_proof_challenges_tag_canonical CHECK ((has_tag = (tag IS NOT NULL)))
);

ALTER TABLE ONLY ujira.wallet_proof_challenges FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.wallet_proof_challenges OWNER TO ujira_owner;

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
-- Name: email_quota_usage email_quota_usage_pkey; Type: CONSTRAINT; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ONLY ops.email_quota_usage
    ADD CONSTRAINT email_quota_usage_pkey PRIMARY KEY (provider_account, day, kind);


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
-- Name: mandate_registry mandate_registry_pkey; Type: CONSTRAINT; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ONLY ops.mandate_registry
    ADD CONSTRAINT mandate_registry_pkey PRIMARY KEY (network, contract_id);


--
-- Name: rate_limit_buckets rate_limit_buckets_pkey; Type: CONSTRAINT; Schema: ops; Owner: ujira_owner
--

ALTER TABLE ONLY ops.rate_limit_buckets
    ADD CONSTRAINT rate_limit_buckets_pkey PRIMARY KEY (bucket_key);


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
-- Name: agent_identity_links agent_identity_links_per_wallet; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.agent_identity_links
    ADD CONSTRAINT agent_identity_links_per_wallet UNIQUE (principal_id, project_id, network, address, registry);


--
-- Name: agent_identity_links agent_identity_links_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.agent_identity_links
    ADD CONSTRAINT agent_identity_links_pkey PRIMARY KEY (id);


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
-- Name: attestations attestations_digest_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.attestations
    ADD CONSTRAINT attestations_digest_key UNIQUE (digest, attester_key_id);


--
-- Name: attestations attestations_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.attestations
    ADD CONSTRAINT attestations_pkey PRIMARY KEY (id);


--
-- Name: attestations attestations_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.attestations
    ADD CONSTRAINT attestations_tenant_key UNIQUE (principal_id, project_id, id);


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
-- Name: destination_verifications destination_verifications_one_per_challenge; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.destination_verifications
    ADD CONSTRAINT destination_verifications_one_per_challenge UNIQUE (challenge_id);


--
-- Name: destination_verifications destination_verifications_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.destination_verifications
    ADD CONSTRAINT destination_verifications_pkey PRIMARY KEY (id);


--
-- Name: destination_verifications destination_verifications_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.destination_verifications
    ADD CONSTRAINT destination_verifications_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: embed_sessions embed_sessions_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.embed_sessions
    ADD CONSTRAINT embed_sessions_pkey PRIMARY KEY (id);


--
-- Name: embed_sessions embed_sessions_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.embed_sessions
    ADD CONSTRAINT embed_sessions_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: embed_sessions embed_sessions_token_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.embed_sessions
    ADD CONSTRAINT embed_sessions_token_key UNIQUE (token_hash);


--
-- Name: funding_account_sources funding_account_sources_one_per_instance; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_account_sources
    ADD CONSTRAINT funding_account_sources_one_per_instance UNIQUE (mandate_instance_id);


--
-- Name: funding_account_sources funding_account_sources_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_account_sources
    ADD CONSTRAINT funding_account_sources_pkey PRIMARY KEY (id);


--
-- Name: funding_account_sources funding_account_sources_source_once; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_account_sources
    ADD CONSTRAINT funding_account_sources_source_once UNIQUE (funding_source_id);


--
-- Name: funding_account_sources funding_account_sources_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_account_sources
    ADD CONSTRAINT funding_account_sources_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: funding_accounts funding_accounts_address_once; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_accounts
    ADD CONSTRAINT funding_accounts_address_once UNIQUE (network, address);


--
-- Name: funding_accounts funding_accounts_one_per_principal; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_accounts
    ADD CONSTRAINT funding_accounts_one_per_principal UNIQUE (principal_id, network);


--
-- Name: funding_accounts funding_accounts_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_accounts
    ADD CONSTRAINT funding_accounts_pkey PRIMARY KEY (id);


--
-- Name: funding_accounts funding_accounts_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_accounts
    ADD CONSTRAINT funding_accounts_tenant_key UNIQUE (principal_id, project_id, id);


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
-- Name: payout_bookings payout_bookings_once; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_bookings
    ADD CONSTRAINT payout_bookings_once UNIQUE (chain, contract_address, payout_id);


--
-- Name: payout_bookings payout_bookings_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_bookings
    ADD CONSTRAINT payout_bookings_pkey PRIMARY KEY (id);


--
-- Name: payout_bookings payout_bookings_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_bookings
    ADD CONSTRAINT payout_bookings_tenant_key UNIQUE (principal_id, project_id, id);


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
-- Name: wallet_proof_challenges wallet_proof_challenges_nonce_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.wallet_proof_challenges
    ADD CONSTRAINT wallet_proof_challenges_nonce_key UNIQUE (nonce_hash);


--
-- Name: wallet_proof_challenges wallet_proof_challenges_pkey; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.wallet_proof_challenges
    ADD CONSTRAINT wallet_proof_challenges_pkey PRIMARY KEY (id);


--
-- Name: wallet_proof_challenges wallet_proof_challenges_tenant_key; Type: CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.wallet_proof_challenges
    ADD CONSTRAINT wallet_proof_challenges_tenant_key UNIQUE (principal_id, project_id, id);


--
-- Name: signing_keys_one_active; Type: INDEX; Schema: ops; Owner: ujira_owner
--

CREATE UNIQUE INDEX signing_keys_one_active ON ops.signing_keys USING btree (purpose, COALESCE(network, ''::text), COALESCE(anchor_id, ''::text), key_ref) WHERE (status = 'active'::text);


--
-- Name: attestations_by_attempt; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX attestations_by_attempt ON ujira.attestations USING btree (principal_id, project_id, attempt_id, leg_index);


--
-- Name: chain_events_by_instance; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX chain_events_by_instance ON ujira.chain_events USING btree (principal_id, project_id, mandate_instance_id, ledger, event_index);


--
-- Name: deposits_by_instance; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX deposits_by_instance ON ujira.deposits USING btree (principal_id, project_id, mandate_instance_id, created_at);


--
-- Name: destination_verifications_latest; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX destination_verifications_latest ON ujira.destination_verifications USING btree (principal_id, project_id, method_id, recorded_at DESC);


--
-- Name: destination_verifications_one_session; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE UNIQUE INDEX destination_verifications_one_session ON ujira.destination_verifications USING btree (principal_id, project_id, method_id) WHERE (level = 'wallet_session'::text);


--
-- Name: funding_account_sources_by_account; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX funding_account_sources_by_account ON ujira.funding_account_sources USING btree (principal_id, project_id, funding_account_id);


--
-- Name: funding_sweeps_by_instance; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX funding_sweeps_by_instance ON ujira.funding_sweeps USING btree (principal_id, project_id, mandate_instance_id, created_at);


--
-- Name: ledger_entries_by_journal; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX ledger_entries_by_journal ON ujira.ledger_entries USING btree (principal_id, project_id, journal_id);


--
-- Name: managed_signers_one_active; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE UNIQUE INDEX managed_signers_one_active ON ujira.managed_signers USING btree (principal_id, project_id, agent_id, network) WHERE (status = 'active'::text);


--
-- Name: payout_bookings_by_instance; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX payout_bookings_by_instance ON ujira.payout_bookings USING btree (principal_id, project_id, mandate_instance_id, id);


--
-- Name: payout_methods_by_recipient; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE INDEX payout_methods_by_recipient ON ujira.payout_methods USING btree (principal_id, project_id, recipient_id);


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
-- Name: agent_identity_links agent_identity_links_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER agent_identity_links_touch BEFORE UPDATE ON ujira.agent_identity_links FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: api_tokens api_tokens_keep_revoked; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER api_tokens_keep_revoked BEFORE UPDATE ON ujira.api_tokens FOR EACH ROW EXECUTE FUNCTION ujira.keep_token_revoked();


--
-- Name: attestations attestation_status_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER attestation_status_only BEFORE UPDATE ON ujira.attestations FOR EACH ROW EXECUTE FUNCTION ujira.attestation_status_only();


--
-- Name: attestations attestations_no_delete; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER attestations_no_delete BEFORE DELETE ON ujira.attestations FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: attestations attestations_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER attestations_no_truncate BEFORE TRUNCATE ON ujira.attestations FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


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
-- Name: deposits deposits_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER deposits_append_only BEFORE DELETE OR UPDATE ON ujira.deposits FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: deposits deposits_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER deposits_no_truncate BEFORE TRUNCATE ON ujira.deposits FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: destination_verifications destination_verifications_append_only; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER destination_verifications_append_only BEFORE DELETE OR UPDATE ON ujira.destination_verifications FOR EACH ROW EXECUTE FUNCTION ujira.forbid_mutation();


--
-- Name: destination_verifications destination_verifications_no_truncate; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER destination_verifications_no_truncate BEFORE TRUNCATE ON ujira.destination_verifications FOR EACH STATEMENT EXECUTE FUNCTION ujira.forbid_mutation();


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
-- Name: payout_bookings payout_bookings_check_new; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_bookings_check_new AFTER INSERT ON ujira.payout_bookings FOR EACH ROW EXECUTE FUNCTION ujira.check_payout_booking();


--
-- Name: payout_bookings payout_bookings_keep; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_bookings_keep BEFORE UPDATE ON ujira.payout_bookings FOR EACH ROW EXECUTE FUNCTION ujira.keep_payout_booking();


--
-- Name: payout_bookings payout_bookings_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_bookings_touch BEFORE UPDATE ON ujira.payout_bookings FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: payout_methods payout_methods_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER payout_methods_touch BEFORE UPDATE ON ujira.payout_methods FOR EACH ROW EXECUTE FUNCTION ujira.touch();


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
-- Name: projects projects_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER projects_touch BEFORE UPDATE ON ujira.projects FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: recipient_identities recipient_identities_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER recipient_identities_touch BEFORE UPDATE ON ujira.recipient_identities FOR EACH ROW EXECUTE FUNCTION ujira.touch();


--
-- Name: recipient_pii recipient_pii_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER recipient_pii_touch BEFORE UPDATE ON ujira.recipient_pii FOR EACH ROW EXECUTE FUNCTION ujira.touch();


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
-- Name: agent_identity_links agent_identity_links_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.agent_identity_links
    ADD CONSTRAINT agent_identity_links_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


--
-- Name: api_tokens api_tokens_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.api_tokens
    ADD CONSTRAINT api_tokens_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


--
-- Name: api_tokens api_tokens_rotated_from_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.api_tokens
    ADD CONSTRAINT api_tokens_rotated_from_fkey FOREIGN KEY (principal_id, project_id, rotated_from_id) REFERENCES ujira.api_tokens(principal_id, project_id, id);


--
-- Name: attestations attestations_principal_id_project_id_mandate_instance_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.attestations
    ADD CONSTRAINT attestations_principal_id_project_id_mandate_instance_id_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id) REFERENCES ujira.mandate_instances(principal_id, project_id, id);


--
-- Name: attestations attestations_principal_id_project_id_method_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.attestations
    ADD CONSTRAINT attestations_principal_id_project_id_method_id_fkey FOREIGN KEY (principal_id, project_id, method_id) REFERENCES ujira.payout_methods(principal_id, project_id, id);


--
-- Name: attestations attestations_principal_id_project_id_recipient_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.attestations
    ADD CONSTRAINT attestations_principal_id_project_id_recipient_id_fkey FOREIGN KEY (principal_id, project_id, recipient_id) REFERENCES ujira.recipients(principal_id, project_id, id);


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
-- Name: destination_verifications destination_verifications_chain_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.destination_verifications
    ADD CONSTRAINT destination_verifications_chain_fkey FOREIGN KEY (chain) REFERENCES ujira.chains(code);


--
-- Name: destination_verifications destination_verifications_principal_id_project_id_challeng_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.destination_verifications
    ADD CONSTRAINT destination_verifications_principal_id_project_id_challeng_fkey FOREIGN KEY (principal_id, project_id, challenge_id) REFERENCES ujira.wallet_proof_challenges(principal_id, project_id, id);


--
-- Name: destination_verifications destination_verifications_principal_id_project_id_derived__fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.destination_verifications
    ADD CONSTRAINT destination_verifications_principal_id_project_id_derived__fkey FOREIGN KEY (principal_id, project_id, derived_from) REFERENCES ujira.destination_verifications(principal_id, project_id, id);


--
-- Name: destination_verifications destination_verifications_principal_id_project_id_embed_se_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.destination_verifications
    ADD CONSTRAINT destination_verifications_principal_id_project_id_embed_se_fkey FOREIGN KEY (principal_id, project_id, embed_session_id) REFERENCES ujira.embed_sessions(principal_id, project_id, id);


--
-- Name: destination_verifications destination_verifications_principal_id_project_id_method_i_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.destination_verifications
    ADD CONSTRAINT destination_verifications_principal_id_project_id_method_i_fkey FOREIGN KEY (principal_id, project_id, method_id) REFERENCES ujira.payout_methods(principal_id, project_id, id);


--
-- Name: embed_sessions embed_sessions_principal_id_project_id_created_by_token_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.embed_sessions
    ADD CONSTRAINT embed_sessions_principal_id_project_id_created_by_token_fkey FOREIGN KEY (principal_id, project_id, created_by_token) REFERENCES ujira.api_tokens(principal_id, project_id, id);


--
-- Name: embed_sessions embed_sessions_principal_id_project_id_recipient_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.embed_sessions
    ADD CONSTRAINT embed_sessions_principal_id_project_id_recipient_id_fkey FOREIGN KEY (principal_id, project_id, recipient_id) REFERENCES ujira.recipients(principal_id, project_id, id);


--
-- Name: funding_account_sources funding_account_sources_principal_id_project_id_funding_ac_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_account_sources
    ADD CONSTRAINT funding_account_sources_principal_id_project_id_funding_ac_fkey FOREIGN KEY (principal_id, project_id, funding_account_id) REFERENCES ujira.funding_accounts(principal_id, project_id, id);


--
-- Name: funding_account_sources funding_account_sources_principal_id_project_id_funding_so_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_account_sources
    ADD CONSTRAINT funding_account_sources_principal_id_project_id_funding_so_fkey FOREIGN KEY (principal_id, project_id, funding_source_id) REFERENCES ujira.funding_sources(principal_id, project_id, id);


--
-- Name: funding_account_sources funding_account_sources_principal_id_project_id_mandate_in_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_account_sources
    ADD CONSTRAINT funding_account_sources_principal_id_project_id_mandate_in_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id) REFERENCES ujira.mandate_instances(principal_id, project_id, id);


--
-- Name: funding_accounts funding_accounts_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_accounts
    ADD CONSTRAINT funding_accounts_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


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
-- Name: payout_bookings payout_bookings_principal_id_project_id_last_event_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_bookings
    ADD CONSTRAINT payout_bookings_principal_id_project_id_last_event_id_fkey FOREIGN KEY (principal_id, project_id, last_event_id) REFERENCES ujira.chain_events(principal_id, project_id, id);


--
-- Name: payout_bookings payout_bookings_principal_id_project_id_mandate_instance_i_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.payout_bookings
    ADD CONSTRAINT payout_bookings_principal_id_project_id_mandate_instance_i_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id, chain) REFERENCES ujira.mandate_instances(principal_id, project_id, id, chain);


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
-- Name: principal_members principal_members_principal_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.principal_members
    ADD CONSTRAINT principal_members_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES ujira.principals(id);


--
-- Name: projects projects_principal_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.projects
    ADD CONSTRAINT projects_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES ujira.principals(id);


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
-- Name: wallet_proof_challenges wallet_proof_challenges_principal_id_project_id_method_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.wallet_proof_challenges
    ADD CONSTRAINT wallet_proof_challenges_principal_id_project_id_method_id_fkey FOREIGN KEY (principal_id, project_id, method_id) REFERENCES ujira.payout_methods(principal_id, project_id, id);


--
-- Name: agent_identity_links; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.agent_identity_links ENABLE ROW LEVEL SECURITY;

--
-- Name: api_tokens; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.api_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: attestations; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.attestations ENABLE ROW LEVEL SECURITY;

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
-- Name: deposits; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.deposits ENABLE ROW LEVEL SECURITY;

--
-- Name: destination_verifications; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.destination_verifications ENABLE ROW LEVEL SECURITY;

--
-- Name: embed_sessions; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.embed_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: funding_account_sources; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.funding_account_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: funding_accounts; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.funding_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: funding_sources; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.funding_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: funding_sweeps; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.funding_sweeps ENABLE ROW LEVEL SECURITY;

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
-- Name: payout_bookings indexer_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_insert ON ujira.payout_bookings FOR INSERT TO ujira_indexer WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


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
-- Name: payout_bookings indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.payout_bookings FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instance_roles indexer_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_update ON ujira.mandate_instance_roles FOR UPDATE TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_bookings indexer_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_update ON ujira.payout_bookings FOR UPDATE TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


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
-- Name: agent_identity_links owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.agent_identity_links TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: api_tokens owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.api_tokens TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: attestations owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.attestations TO ujira_owner USING (true) WITH CHECK (true);


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
-- Name: deposits owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.deposits TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: destination_verifications owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.destination_verifications TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: embed_sessions owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.embed_sessions TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: funding_account_sources owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.funding_account_sources TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: funding_accounts owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.funding_accounts TO ujira_owner USING (true) WITH CHECK (true);


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
-- Name: payout_bookings owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.payout_bookings TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: payout_methods owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.payout_methods TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: principal_members owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.principal_members TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: principals owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.principals TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: projects owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.projects TO ujira_owner USING (true) WITH CHECK (true);


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
-- Name: wallet_proof_challenges owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.wallet_proof_challenges TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: payout_bookings; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.payout_bookings ENABLE ROW LEVEL SECURITY;

--
-- Name: payout_methods; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.payout_methods ENABLE ROW LEVEL SECURITY;

--
-- Name: principal_members; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.principal_members ENABLE ROW LEVEL SECURITY;

--
-- Name: principals; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.principals ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.projects ENABLE ROW LEVEL SECURITY;

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
-- Name: attestations signer_pending; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY signer_pending ON ujira.attestations FOR SELECT TO ujira_signer_read USING (true);


--
-- Name: agent_identity_links tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.agent_identity_links FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: api_tokens tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.api_tokens FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: attestations tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.attestations FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: audit_log tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.audit_log FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: chain_events tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.chain_events FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: deposits tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.deposits FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: destination_verifications tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.destination_verifications FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: embed_sessions tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.embed_sessions FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: funding_account_sources tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.funding_account_sources FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: funding_accounts tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.funding_accounts FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


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
-- Name: payout_bookings tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.payout_bookings FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_methods tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.payout_methods FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: principal_members tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.principal_members FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all())));


--
-- Name: projects tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.projects FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all())));


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
-- Name: wallet_proof_challenges tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.wallet_proof_challenges FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: agent_identity_links tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.agent_identity_links FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: api_tokens tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.api_tokens FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: attestations tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.attestations FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


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
-- Name: deposits tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.deposits FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: destination_verifications tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.destination_verifications FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: embed_sessions tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.embed_sessions FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: funding_account_sources tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.funding_account_sources FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: funding_accounts tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.funding_accounts FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


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
-- Name: payout_bookings tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.payout_bookings FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: payout_methods tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.payout_methods FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: principal_members tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.principal_members FOR SELECT TO ujira_app, ujira_reader USING ((principal_id = ujira.current_principal_id()));


--
-- Name: principals tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.principals FOR SELECT TO ujira_app, ujira_reader USING ((id = ujira.current_principal_id()));


--
-- Name: projects tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.projects FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (id = ujira.current_project_id()))));


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
-- Name: wallet_proof_challenges tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.wallet_proof_challenges FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: agent_identity_links tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.agent_identity_links FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: api_tokens tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.api_tokens FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: attestations tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.attestations FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: audit_log tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.audit_log FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: chain_events tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.chain_events FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: deposits tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.deposits FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: destination_verifications tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.destination_verifications FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: embed_sessions tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.embed_sessions FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: funding_account_sources tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.funding_account_sources FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: funding_accounts tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.funding_accounts FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


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
-- Name: payout_bookings tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.payout_bookings FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: payout_methods tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.payout_methods FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: principal_members tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.principal_members FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all())));


--
-- Name: principals tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.principals FOR UPDATE TO ujira_app USING (((id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all()))) WITH CHECK (((id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all())));


--
-- Name: projects tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.projects FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (id = ujira.current_project_id())));


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
-- Name: wallet_proof_challenges tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.wallet_proof_challenges FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: wallet_proof_challenges; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.wallet_proof_challenges ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA ops; Type: ACL; Schema: -; Owner: ujira_owner
--

GRANT USAGE ON SCHEMA ops TO ujira_ops;
GRANT USAGE ON SCHEMA ops TO ujira_app;
GRANT USAGE ON SCHEMA ops TO ujira_indexer;


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
-- Name: FUNCTION advance_chain_cursor(target_network text, next_cursor text); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.advance_chain_cursor(target_network text, next_cursor text) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.advance_chain_cursor(target_network text, next_cursor text) TO ujira_indexer;


--
-- Name: FUNCTION chain_cursor(target_network text); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.chain_cursor(target_network text) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.chain_cursor(target_network text) TO ujira_indexer;


--
-- Name: FUNCTION email_quota_take(p_provider_account text, p_kind text, p_cap integer, p_code_reserve integer); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.email_quota_take(p_provider_account text, p_kind text, p_cap integer, p_code_reserve integer) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.email_quota_take(p_provider_account text, p_kind text, p_cap integer, p_code_reserve integer) TO ujira_app;


--
-- Name: FUNCTION flag_mandate(target_network text, contract text); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.flag_mandate(target_network text, contract text) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.flag_mandate(target_network text, contract text) TO ujira_indexer;


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
-- Name: FUNCTION register_mandate(target_network text, contract text, factory text, tag bytea, tx bytea, event_at bigint, at_ledger bigint); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.register_mandate(target_network text, contract text, factory text, tag bytea, tx bytea, event_at bigint, at_ledger bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.register_mandate(target_network text, contract text, factory text, tag bytea, tx bytea, event_at bigint, at_ledger bigint) TO ujira_indexer;


--
-- Name: FUNCTION registered_mandate(target_network text, contract text); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.registered_mandate(target_network text, contract text) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.registered_mandate(target_network text, contract text) TO ujira_app;
GRANT ALL ON FUNCTION ops.registered_mandate(target_network text, contract text) TO ujira_indexer;


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
-- Name: FUNCTION attestation_status_only(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.attestation_status_only() FROM PUBLIC;


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
-- Name: FUNCTION check_payout_booking(); Type: ACL; Schema: ujira; Owner: ujira_fn_instances
--

REVOKE ALL ON FUNCTION ujira.check_payout_booking() FROM PUBLIC;


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


--
-- Name: FUNCTION current_project_id(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.current_project_id() FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.current_project_id() TO ujira_app;
GRANT ALL ON FUNCTION ujira.current_project_id() TO ujira_reader;
GRANT ALL ON FUNCTION ujira.current_project_id() TO ujira_retention;
GRANT ALL ON FUNCTION ujira.current_project_id() TO ujira_auth;
GRANT ALL ON FUNCTION ujira.current_project_id() TO ujira_indexer;


--
-- Name: FUNCTION forbid_mutation(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.forbid_mutation() FROM PUBLIC;


--
-- Name: FUNCTION keep_funding_sweep(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.keep_funding_sweep() FROM PUBLIC;


--
-- Name: FUNCTION keep_managed_signer(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.keep_managed_signer() FROM PUBLIC;


--
-- Name: FUNCTION keep_payout_booking(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.keep_payout_booking() FROM PUBLIC;


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
-- Name: FUNCTION project_scope_all(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.project_scope_all() FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.project_scope_all() TO ujira_app;
GRANT ALL ON FUNCTION ujira.project_scope_all() TO ujira_reader;
GRANT ALL ON FUNCTION ujira.project_scope_all() TO ujira_retention;
GRANT ALL ON FUNCTION ujira.project_scope_all() TO ujira_auth;
GRANT ALL ON FUNCTION ujira.project_scope_all() TO ujira_indexer;


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
-- Name: TABLE email_quota_usage; Type: ACL; Schema: ops; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ops.email_quota_usage TO ujira_ops;


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
-- Name: TABLE mandate_registry; Type: ACL; Schema: ops; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ops.mandate_registry TO ujira_ops;


--
-- Name: TABLE rate_limit_buckets; Type: ACL; Schema: ops; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ops.rate_limit_buckets TO ujira_ops;


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
-- Name: TABLE agent_identity_links; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.agent_identity_links TO ujira_app;
GRANT SELECT ON TABLE ujira.agent_identity_links TO ujira_reader;


--
-- Name: TABLE api_tokens; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.api_tokens TO ujira_app;
GRANT SELECT ON TABLE ujira.api_tokens TO ujira_reader;
GRANT SELECT ON TABLE ujira.api_tokens TO ujira_fn_tokens;


--
-- Name: TABLE attestations; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.attestations TO ujira_app;
GRANT SELECT ON TABLE ujira.attestations TO ujira_reader;


--
-- Name: COLUMN attestations.principal_id; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT(principal_id) ON TABLE ujira.attestations TO ujira_signer_read;


--
-- Name: COLUMN attestations.project_id; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT(project_id) ON TABLE ujira.attestations TO ujira_signer_read;


--
-- Name: COLUMN attestations.id; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT(id) ON TABLE ujira.attestations TO ujira_signer_read;


--
-- Name: COLUMN attestations.digest; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT(digest) ON TABLE ujira.attestations TO ujira_signer_read;


--
-- Name: COLUMN attestations.status; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT(status) ON TABLE ujira.attestations TO ujira_signer_read;


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
-- Name: TABLE deposits; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.deposits TO ujira_app;
GRANT SELECT ON TABLE ujira.deposits TO ujira_reader;
GRANT SELECT,INSERT ON TABLE ujira.deposits TO ujira_indexer;


--
-- Name: TABLE destination_verifications; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.destination_verifications TO ujira_app;
GRANT SELECT ON TABLE ujira.destination_verifications TO ujira_reader;


--
-- Name: TABLE embed_sessions; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.embed_sessions TO ujira_app;


--
-- Name: TABLE funding_account_sources; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.funding_account_sources TO ujira_app;
GRANT SELECT ON TABLE ujira.funding_account_sources TO ujira_reader;


--
-- Name: TABLE funding_accounts; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.funding_accounts TO ujira_app;
GRANT SELECT ON TABLE ujira.funding_accounts TO ujira_reader;


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
-- Name: TABLE mandates; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.mandates TO ujira_app;
GRANT SELECT ON TABLE ujira.mandates TO ujira_reader;


--
-- Name: TABLE payout_bookings; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT ON TABLE ujira.payout_bookings TO ujira_app;
GRANT SELECT ON TABLE ujira.payout_bookings TO ujira_reader;
GRANT SELECT,INSERT,UPDATE ON TABLE ujira.payout_bookings TO ujira_indexer;


--
-- Name: TABLE payout_methods; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.payout_methods TO ujira_app;
GRANT SELECT ON TABLE ujira.payout_methods TO ujira_reader;


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
-- Name: TABLE projects; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.projects TO ujira_app;
GRANT SELECT ON TABLE ujira.projects TO ujira_reader;
GRANT INSERT ON TABLE ujira.projects TO ujira_fn_principals;


--
-- Name: TABLE recipient_identities; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.recipient_identities TO ujira_app;
GRANT SELECT ON TABLE ujira.recipient_identities TO ujira_reader;


--
-- Name: TABLE recipient_pii; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.recipient_pii TO ujira_app;


--
-- Name: TABLE recipients; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.recipients TO ujira_app;
GRANT SELECT ON TABLE ujira.recipients TO ujira_reader;


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
-- Name: TABLE wallet_proof_challenges; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.wallet_proof_challenges TO ujira_app;


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

