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
-- Name: funding_sources; Type: TABLE; Schema: ujira; Owner: ujira_owner
--

CREATE TABLE ujira.funding_sources (
    principal_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mandate_instance_id uuid NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT funding_sources_kind CHECK ((kind = 'stablecoin_deposit'::text))
);

ALTER TABLE ONLY ujira.funding_sources FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.funding_sources OWNER TO ujira_owner;

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
    CONSTRAINT mandate_instances_address_length CHECK (((char_length(contract_address) >= 1) AND (char_length(contract_address) <= 128))),
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
    CONSTRAINT mandates_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200)))
);

ALTER TABLE ONLY ujira.mandates FORCE ROW LEVEL SECURITY;


ALTER TABLE ujira.mandates OWNER TO ujira_owner;

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
-- Name: managed_signers_one_active; Type: INDEX; Schema: ujira; Owner: ujira_owner
--

CREATE UNIQUE INDEX managed_signers_one_active ON ujira.managed_signers USING btree (principal_id, project_id, agent_id, network) WHERE (status = 'active'::text);


--
-- Name: chain_cursors chain_cursors_touch; Type: TRIGGER; Schema: ops; Owner: ujira_owner
--

CREATE TRIGGER chain_cursors_touch BEFORE UPDATE ON ops.chain_cursors FOR EACH ROW EXECUTE FUNCTION ujira.touch();


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
-- Name: mandates mandates_touch; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER mandates_touch BEFORE UPDATE ON ujira.mandates FOR EACH ROW EXECUTE FUNCTION ujira.touch();


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
-- Name: funding_sources funding_sources_principal_id_project_id_mandate_instance_i_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.funding_sources
    ADD CONSTRAINT funding_sources_principal_id_project_id_mandate_instance_i_fkey FOREIGN KEY (principal_id, project_id, mandate_instance_id) REFERENCES ujira.mandate_instances(principal_id, project_id, id);


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
-- Name: mandates mandates_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.mandates
    ADD CONSTRAINT mandates_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


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
-- Name: settlement_tokens settlement_tokens_chain_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.settlement_tokens
    ADD CONSTRAINT settlement_tokens_chain_fkey FOREIGN KEY (chain) REFERENCES ujira.chains(code);


--
-- Name: api_tokens; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.api_tokens ENABLE ROW LEVEL SECURITY;

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
-- Name: funding_sources; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.funding_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: chain_events indexer_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_insert ON ujira.chain_events FOR INSERT TO ujira_indexer WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: deposits indexer_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_insert ON ujira.deposits FOR INSERT TO ujira_indexer WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instance_roles indexer_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_insert ON ujira.mandate_instance_roles FOR INSERT TO ujira_indexer WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: chain_events indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.chain_events FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: deposits indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.deposits FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instance_roles indexer_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_read ON ujira.mandate_instance_roles FOR SELECT TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: mandate_instance_roles indexer_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY indexer_update ON ujira.mandate_instance_roles FOR UPDATE TO ujira_indexer USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


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
-- Name: mandates; Type: ROW SECURITY; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ujira.mandates ENABLE ROW LEVEL SECURITY;

--
-- Name: api_tokens owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.api_tokens TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: chain_events owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.chain_events TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: deposits owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.deposits TO ujira_owner USING (true) WITH CHECK (true);


--
-- Name: funding_sources owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.funding_sources TO ujira_owner USING (true) WITH CHECK (true);


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
-- Name: mandates owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.mandates TO ujira_owner USING (true) WITH CHECK (true);


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
-- Name: mandate_instances resolve_instance; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY resolve_instance ON ujira.mandate_instances FOR SELECT TO ujira_fn_instances USING (true);


--
-- Name: api_tokens tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.api_tokens FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: chain_events tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.chain_events FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: deposits tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.deposits FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: funding_sources tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.funding_sources FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


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
-- Name: mandates tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.mandates FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: principal_members tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.principal_members FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all())));


--
-- Name: projects tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.projects FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (NOT ujira.project_scope_all())));


--
-- Name: api_tokens tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.api_tokens FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: chain_events tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.chain_events FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: deposits tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.deposits FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


--
-- Name: funding_sources tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.funding_sources FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


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
-- Name: mandates tenant_read; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_read ON ujira.mandates FOR SELECT TO ujira_app, ujira_reader USING (((principal_id = ujira.current_principal_id()) AND (ujira.project_scope_all() OR (project_id = ujira.current_project_id()))));


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
-- Name: api_tokens tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.api_tokens FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: chain_events tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.chain_events FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: deposits tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.deposits FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


--
-- Name: funding_sources tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.funding_sources FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


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
-- Name: mandates tenant_update; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_update ON ujira.mandates FOR UPDATE TO ujira_app USING (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id()))) WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


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


--
-- Name: TYPE amount; Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON TYPE ujira.amount FROM PUBLIC;
GRANT ALL ON TYPE ujira.amount TO ujira_app;
GRANT ALL ON TYPE ujira.amount TO ujira_reader;
GRANT ALL ON TYPE ujira.amount TO ujira_retention;
GRANT ALL ON TYPE ujira.amount TO ujira_auth;
GRANT ALL ON TYPE ujira.amount TO ujira_indexer;


--
-- Name: TYPE hash32; Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON TYPE ujira.hash32 FROM PUBLIC;
GRANT ALL ON TYPE ujira.hash32 TO ujira_app;
GRANT ALL ON TYPE ujira.hash32 TO ujira_reader;
GRANT ALL ON TYPE ujira.hash32 TO ujira_retention;
GRANT ALL ON TYPE ujira.hash32 TO ujira_auth;
GRANT ALL ON TYPE ujira.hash32 TO ujira_indexer;


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
-- Name: FUNCTION keep_signing_key(); Type: ACL; Schema: ops; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ops.keep_signing_key() FROM PUBLIC;


--
-- Name: FUNCTION lease_executor(target_network text, holder text, lease_seconds integer); Type: ACL; Schema: ops; Owner: ujira_ops
--

REVOKE ALL ON FUNCTION ops.lease_executor(target_network text, holder text, lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.lease_executor(target_network text, holder text, lease_seconds integer) TO ujira_app;


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
-- Name: FUNCTION authenticate_token(token_prefix text); Type: ACL; Schema: ujira; Owner: ujira_fn_tokens
--

REVOKE ALL ON FUNCTION ujira.authenticate_token(token_prefix text) FROM PUBLIC;
GRANT ALL ON FUNCTION ujira.authenticate_token(token_prefix text) TO ujira_app;
GRANT ALL ON FUNCTION ujira.authenticate_token(token_prefix text) TO ujira_auth;


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
-- Name: FUNCTION keep_managed_signer(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.keep_managed_signer() FROM PUBLIC;


--
-- Name: FUNCTION keep_token_revoked(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.keep_token_revoked() FROM PUBLIC;


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
-- Name: TABLE executor_accounts; Type: ACL; Schema: ops; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ops.executor_accounts TO ujira_ops;


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
-- Name: TABLE funding_sources; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT ON TABLE ujira.funding_sources TO ujira_app;
GRANT SELECT ON TABLE ujira.funding_sources TO ujira_reader;


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


--
-- Name: TABLE mandates; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.mandates TO ujira_app;
GRANT SELECT ON TABLE ujira.mandates TO ujira_reader;


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

