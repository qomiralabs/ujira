-- expand
-- The job queue's two roles, so the queue cannot become a path around tenant
-- isolation.
--
-- ujira_worker logs in, owns the queue schemas and holds nothing in schema
-- ujira. A job that needs tenant data opens a tenant transaction on the app
-- login, under the same policies as a request, so a bug in a queue query can
-- never read a tenant's rows.
--
-- ujira_scheduler never logs in. It owns the few functions that fan out
-- cross-tenant work, and can read only the columns those functions return,
-- through one policy per table.
--
-- This migration needs the platform admin, as every migration that creates a
-- role does. graphile_worker's tables are not created here: the deploy step
-- installs the pinned version as ujira_worker, after this has run.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- Everything the worker install needs that a database dump does not carry, or
-- that a restore can leave behind. It lives in a function so a restore can run
-- it again with one statement, and it holds to one rule: running it on a
-- database that already has all of this changes nothing.
create function ujira.bootstrap_worker_roles() returns void
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  -- Roles are shared by the server, so these are created only when missing and
  -- the down section never drops them. The password is set outside migrations.
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_worker') then
    create role ujira_worker login noinherit nobypassrls;
  end if;
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_scheduler') then
    create role ujira_scheduler nologin noinherit nobypassrls;
  end if;
  alter role ujira_worker nobypassrls;
  alter role ujira_scheduler nobypassrls;

  -- The owner hands functions to these two, which needs it to be able to act
  -- as them. Neither can act as the owner. A second grant from another role
  -- would add a second membership row, so a role already a member is left alone.
  if not pg_catalog.pg_has_role('ujira_owner', 'ujira_worker', 'member') then
    grant ujira_worker to ujira_owner;
  end if;
  if not pg_catalog.pg_has_role('ujira_owner', 'ujira_scheduler', 'member') then
    grant ujira_scheduler to ujira_owner;
  end if;

  create schema if not exists graphile_worker authorization ujira_worker;
  create schema if not exists ujira_jobs authorization ujira_worker;
  alter schema graphile_worker owner to ujira_worker;
  alter schema ujira_jobs owner to ujira_worker;

  -- A new schema starts with nothing granted, so these only matter on a
  -- database someone changed by hand, and that is when they matter.
  revoke all on schema graphile_worker from public, ujira_app;
  revoke all on schema ujira_jobs from public;
  revoke all on schema ujira from ujira_worker;

  -- Postgres makes every new function executable, and every new type usable,
  -- by PUBLIC. A later worker version adds functions of its own, so this has to
  -- be a default and not a one off, and it has to run before the install.
  alter default privileges for role ujira_worker revoke execute on functions from public;
  alter default privileges for role ujira_worker revoke usage on types from public;

  -- The installer runs `create schema if not exists` even when the schema is
  -- there, which needs CREATE on the database. A database grant is not in a
  -- dump, so a restore loses it, which is one reason this function exists.
  execute format('grant create on database %I to ujira_worker', current_database());
end
$fn$;

-- What a table migration calls to let the cron functions read it: one policy
-- that names only the scheduler, and a grant on only the columns those functions
-- return. The scheduler is reached only through its own definer functions, so
-- the policy matching every row is what makes a cross-tenant cron possible, and
-- the column grant is what keeps it to ids.
create function ujira.apply_scheduler_read(target regclass, readable_columns text[]) returns void
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  execute format(
    'create policy scheduler_read on %s for select to ujira_scheduler using (true)',
    target
  );
  execute format(
    'grant select (%s) on %s to ujira_scheduler',
    (select string_agg(quote_ident(name), ', ') from unnest(readable_columns) as name),
    target
  );
end
$fn$;

reset role;

select ujira.bootstrap_worker_roles();

set local role ujira_owner;

grant usage on schema ujira to ujira_scheduler;

select ujira.apply_scheduler_read(
  'ujira.mandate_instances',
  array['principal_id', 'project_id', 'id']
);

-- payout_attempts and fee_refunds land in migrations of their own. One that
-- sorts before this file is picked up here, and one that sorts after it calls
-- apply_scheduler_read itself, so each table gets its policy exactly once.
do $tables$
begin
  if to_regclass('ujira.payout_attempts') is not null then
    perform ujira.apply_scheduler_read(
      'ujira.payout_attempts',
      array['principal_id', 'project_id', 'id', 'deadline', 'status']
    );
  end if;
  if to_regclass('ujira.fee_refunds') is not null then
    perform ujira.apply_scheduler_read(
      'ujira.fee_refunds',
      array['principal_id', 'project_id', 'id', 'due_at', 'status']
    );
  end if;
end
$tables$;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

do $tables$
begin
  if to_regclass('ujira.fee_refunds') is not null then
    drop policy scheduler_read on ujira.fee_refunds;
    revoke select (principal_id, project_id, id, due_at, status)
      on ujira.fee_refunds from ujira_scheduler;
  end if;
  if to_regclass('ujira.payout_attempts') is not null then
    drop policy scheduler_read on ujira.payout_attempts;
    revoke select (principal_id, project_id, id, deadline, status)
      on ujira.payout_attempts from ujira_scheduler;
  end if;
end
$tables$;

drop policy scheduler_read on ujira.mandate_instances;
revoke select (principal_id, project_id, id) on ujira.mandate_instances from ujira_scheduler;
revoke usage on schema ujira from ujira_scheduler;

drop function ujira.apply_scheduler_read(regclass, text[]);
drop function ujira.bootstrap_worker_roles();

reset role;

-- Refused if the worker schema is installed, which is the right answer: rolling
-- this back must not quietly destroy a queue with jobs in it.
drop schema ujira_jobs;
drop schema graphile_worker;

alter default privileges for role ujira_worker grant execute on functions to public;
alter default privileges for role ujira_worker grant usage on types to public;

do $grant$
begin
  execute format('revoke create on database %I from ujira_worker', current_database());
end
$grant$;

-- The owner keeps its membership of both roles. A membership belongs to the
-- server, so revoking it here would reach into every other database on it, and
-- going up again finds it already there.
