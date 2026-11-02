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
-- Name: currency_scales currency_scales_currency_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.currency_scales
    ADD CONSTRAINT currency_scales_currency_fkey FOREIGN KEY (currency) REFERENCES ujira.currencies(code);


--
-- Name: settlement_tokens settlement_tokens_chain_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: ujira_owner
--

ALTER TABLE ONLY ujira.settlement_tokens
    ADD CONSTRAINT settlement_tokens_chain_fkey FOREIGN KEY (chain) REFERENCES ujira.chains(code);


--
-- Name: SCHEMA ujira; Type: ACL; Schema: -; Owner: ujira_owner
--

GRANT USAGE ON SCHEMA ujira TO ujira_app;
GRANT USAGE ON SCHEMA ujira TO ujira_reader;
GRANT USAGE ON SCHEMA ujira TO ujira_retention;
GRANT USAGE ON SCHEMA ujira TO ujira_auth;
GRANT USAGE ON SCHEMA ujira TO ujira_indexer;


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
-- Name: FUNCTION check_transition(); Type: ACL; Schema: ujira; Owner: ujira_owner
--

REVOKE ALL ON FUNCTION ujira.check_transition() FROM PUBLIC;


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

