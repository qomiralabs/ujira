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
-- Name: ujira_migrations id; Type: DEFAULT; Schema: public; Owner: test
--

ALTER TABLE ONLY public.ujira_migrations ALTER COLUMN id SET DEFAULT nextval('public.ujira_migrations_id_seq'::regclass);


--
-- Name: ujira_migrations ujira_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: test
--

ALTER TABLE ONLY public.ujira_migrations
    ADD CONSTRAINT ujira_migrations_pkey PRIMARY KEY (id);


--
-- PostgreSQL database dump complete
--

\unrestrict ujira

