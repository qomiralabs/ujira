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
-- Name: api_tokens api_tokens_keep_revoked; Type: TRIGGER; Schema: ujira; Owner: ujira_owner
--

CREATE TRIGGER api_tokens_keep_revoked BEFORE UPDATE ON ujira.api_tokens FOR EACH ROW EXECUTE FUNCTION ujira.keep_token_revoked();


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
-- Name: api_tokens api_tokens_principal_id_project_id_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.api_tokens
    ADD CONSTRAINT api_tokens_principal_id_project_id_fkey FOREIGN KEY (principal_id, project_id) REFERENCES ujira.projects(principal_id, id);


--
-- Name: currency_scales currency_scales_currency_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.currency_scales
    ADD CONSTRAINT currency_scales_currency_fkey FOREIGN KEY (currency) REFERENCES ujira.currencies(code);


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
-- Name: api_tokens owner_all; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY owner_all ON ujira.api_tokens TO ujira_owner USING (true) WITH CHECK (true);


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
-- Name: api_tokens tenant_insert; Type: POLICY; Schema: ujira; Owner: ujira_owner
--

CREATE POLICY tenant_insert ON ujira.api_tokens FOR INSERT TO ujira_app WITH CHECK (((principal_id = ujira.current_principal_id()) AND (project_id = ujira.current_project_id())));


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
-- Name: SCHEMA ujira; Type: ACL; Schema: -; Owner: ujira_owner
--

GRANT USAGE ON SCHEMA ujira TO ujira_app;
GRANT USAGE ON SCHEMA ujira TO ujira_reader;
GRANT USAGE ON SCHEMA ujira TO ujira_retention;
GRANT USAGE ON SCHEMA ujira TO ujira_auth;
GRANT USAGE ON SCHEMA ujira TO ujira_indexer;
GRANT USAGE ON SCHEMA ujira TO ujira_fn_principals;
GRANT USAGE ON SCHEMA ujira TO ujira_fn_tokens;


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
-- Name: FUNCTION apply_tenant_policies(target regclass); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.apply_tenant_policies(target regclass) FROM PUBLIC;


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
-- Name: FUNCTION touch(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.touch() FROM PUBLIC;


--
-- Name: TABLE api_tokens; Type: ACL; Schema: ujira; Owner: ujira_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE ujira.api_tokens TO ujira_app;
GRANT SELECT ON TABLE ujira.api_tokens TO ujira_reader;
GRANT SELECT ON TABLE ujira.api_tokens TO ujira_fn_tokens;


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

