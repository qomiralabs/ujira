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
-- Name: ujira; Type: SCHEMA; Schema: -; Owner: test
--

CREATE SCHEMA ujira;


ALTER SCHEMA ujira OWNER TO test;

--
-- Name: amount; Type: DOMAIN; Schema: ujira; Owner: test
--

CREATE DOMAIN ujira.amount AS numeric
	CONSTRAINT amount_is_i128_integer CHECK ((((VALUE >= '-170141183460469231731687303715884105728'::numeric) AND (VALUE <= '170141183460469231731687303715884105727'::numeric)) AND (scale(VALUE) = 0)));


ALTER DOMAIN ujira.amount OWNER TO test;

--
-- Name: hash32; Type: DOMAIN; Schema: ujira; Owner: test
--

CREATE DOMAIN ujira.hash32 AS bytea
	CONSTRAINT hash32_is_32_bytes CHECK ((octet_length(VALUE) = 32));


ALTER DOMAIN ujira.hash32 OWNER TO test;

--
-- Name: scale; Type: DOMAIN; Schema: ujira; Owner: test
--

CREATE DOMAIN ujira.scale AS smallint
	CONSTRAINT scale_in_range CHECK (((VALUE >= 0) AND (VALUE <= 18)));


ALTER DOMAIN ujira.scale OWNER TO test;

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
-- Name: chains; Type: TABLE; Schema: ujira; Owner: test
--

CREATE TABLE ujira.chains (
    code text NOT NULL,
    CONSTRAINT chains_code_format CHECK ((code ~ '^[a-z][a-z0-9_]{0,31}$'::text))
);


ALTER TABLE ujira.chains OWNER TO test;

--
-- Name: currencies; Type: TABLE; Schema: ujira; Owner: test
--

CREATE TABLE ujira.currencies (
    code text NOT NULL,
    minor_units ujira.scale NOT NULL,
    CONSTRAINT currencies_code_format CHECK ((code ~ '^[A-Z]{3}$'::text))
);


ALTER TABLE ujira.currencies OWNER TO test;

--
-- Name: currency_scales; Type: TABLE; Schema: ujira; Owner: test
--

CREATE TABLE ujira.currency_scales (
    currency text NOT NULL,
    scale ujira.scale NOT NULL
);


ALTER TABLE ujira.currency_scales OWNER TO test;

--
-- Name: settlement_tokens; Type: TABLE; Schema: ujira; Owner: test
--

CREATE TABLE ujira.settlement_tokens (
    asset text NOT NULL,
    chain text NOT NULL,
    token_scale ujira.scale NOT NULL,
    display_scale ujira.scale NOT NULL,
    CONSTRAINT settlement_tokens_asset_format CHECK ((asset ~ '^[A-Z][A-Z0-9]{1,11}$'::text))
);


ALTER TABLE ujira.settlement_tokens OWNER TO test;

--
-- Name: status_transitions; Type: TABLE; Schema: ujira; Owner: test
--

CREATE TABLE ujira.status_transitions (
    machine text NOT NULL,
    from_status text NOT NULL,
    to_status text NOT NULL,
    CONSTRAINT status_transitions_machine_format CHECK ((machine ~ '^[a-z][a-z0-9_]*$'::text))
);


ALTER TABLE ujira.status_transitions OWNER TO test;

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
-- Name: chains chains_pkey; Type: CONSTRAINT; Schema: ujira; Owner: test
--

ALTER TABLE ONLY ujira.chains
    ADD CONSTRAINT chains_pkey PRIMARY KEY (code);


--
-- Name: currencies currencies_pkey; Type: CONSTRAINT; Schema: ujira; Owner: test
--

ALTER TABLE ONLY ujira.currencies
    ADD CONSTRAINT currencies_pkey PRIMARY KEY (code);


--
-- Name: currency_scales currency_scales_pkey; Type: CONSTRAINT; Schema: ujira; Owner: test
--

ALTER TABLE ONLY ujira.currency_scales
    ADD CONSTRAINT currency_scales_pkey PRIMARY KEY (currency, scale);


--
-- Name: settlement_tokens settlement_tokens_pkey; Type: CONSTRAINT; Schema: ujira; Owner: test
--

ALTER TABLE ONLY ujira.settlement_tokens
    ADD CONSTRAINT settlement_tokens_pkey PRIMARY KEY (asset, chain);


--
-- Name: settlement_tokens settlement_tokens_scale_key; Type: CONSTRAINT; Schema: ujira; Owner: test
--

ALTER TABLE ONLY ujira.settlement_tokens
    ADD CONSTRAINT settlement_tokens_scale_key UNIQUE (asset, chain, token_scale);


--
-- Name: status_transitions status_transitions_pkey; Type: CONSTRAINT; Schema: ujira; Owner: test
--

ALTER TABLE ONLY ujira.status_transitions
    ADD CONSTRAINT status_transitions_pkey PRIMARY KEY (machine, from_status, to_status);


--
-- Name: currency_scales currency_scales_currency_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: test
--

ALTER TABLE ONLY ujira.currency_scales
    ADD CONSTRAINT currency_scales_currency_fkey FOREIGN KEY (currency) REFERENCES ujira.currencies(code);


--
-- Name: settlement_tokens settlement_tokens_chain_fkey; Type: FK CONSTRAINT; Schema: ujira; Owner: test
--

ALTER TABLE ONLY ujira.settlement_tokens
    ADD CONSTRAINT settlement_tokens_chain_fkey FOREIGN KEY (chain) REFERENCES ujira.chains(code);


--
-- PostgreSQL database dump complete
--

\unrestrict ujira

