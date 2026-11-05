-- expand
-- bootstrap
-- Hardening the job queue and the tenant settings.
--
-- A tenant setting must come from the transaction that uses it. ujira.txid
-- already refuses one left over from an earlier transaction. What it cannot see
-- is a value supplied by a role or database default, which every new session
-- starts with: a transaction that set only ujira.txid would run under it.
-- Postgres does not report where a custom setting came from, since pg_settings
-- leaves custom settings out, so the defaults themselves are read instead, and
-- any default for a ujira setting is refused.
--
-- A SET and a SET LOCAL made inside the transaction cannot be told apart from
-- SQL. A session level SET is still refused in the transactions after it, by the
-- ujira.txid binding, and the repository refuses to send one at all.
--
-- Also here: enqueue refuses run times that are infinite or more than a year
-- away, ujira_worker loses CREATE on the database, which the install step grants
-- for the install only, and the app login's search_path is pinned, so a schema
-- created later cannot shadow anything it resolves.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The pin is written out rather than left to the default "$user", public, so
-- nothing can be put in front of what the app resolves. Every query here names
-- its schema. Like the role's timeouts, it stays in place on the way down,
-- because roles belong to the server.
-- squawk-ignore ban-alter-role-options
alter role ujira_app set search_path = pg_catalog, pg_temp;

set local role ujira_owner;

-- The defaults are read once per transaction. The check sits under every
-- policy, so it is kept off the per row path.
create or replace function ujira.current_principal_id() returns uuid
  language plpgsql
  stable
  set search_path = pg_catalog
as $fn$
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
  if current_setting('ujira.defaults_checked', true) is distinct from bound then
    if exists (
      select 1
        from pg_db_role_setting as s
       where s.setrole in (0, (select r.oid from pg_roles as r where r.rolname = session_user))
         and s.setdatabase in (0, (select d.oid from pg_database as d where d.datname = current_database()))
         and exists (select 1 from unnest(s.setconfig) as c (setting) where c.setting like 'ujira.%')
    ) then
      raise exception using
        errcode = 'UJ001',
        message = 'no tenant context: a role or database default sets a ujira setting, and only a transaction may';
    end if;
    perform set_config('ujira.defaults_checked', bound, true);
  end if;
  return principal::uuid;
end
$fn$;

reset role;

-- CREATE on the database is granted only for the install, by the platform admin.
-- An installed worker pool never needs it: it creates its schema only when the
-- schema has no migrations table. A role that can create schemas could put one
-- in front of what another role resolves.
create or replace function ujira.bootstrap_worker_roles() returns void
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

  -- Left over from an install that stopped before taking it back.
  execute format('revoke create on database %I from ujira_worker', current_database());
end
$fn$;

select ujira.bootstrap_worker_roles();

set local role ujira_worker;

create or replace function ujira_jobs.enqueue(
  p_task         text,
  p_ids          jsonb,
  p_job_key      text default '-',
  p_queue        text default '-',
  -- Jobs are claimed by (priority, run_at) with no tie break, and now() is the
  -- same for every job of a transaction, so now() would leave a queue's order to
  -- the heap. This keeps jobs of one transaction in the order they were added.
  p_run_at       timestamptz default clock_timestamp(),
  p_max_attempts integer default 5,
  p_key_mode     text default 'replace',
  p_scope        text default 'project'
) returns bigint
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_principal text := current_setting('ujira.principal_id', true);
  v_project   text := current_setting('ujira.project_id', true);
  v_txid      text := current_setting('ujira.txid', true);
  v_tenant_scope text := current_setting('ujira.scope', true);
  v_prefix    text;
  v_job_id    bigint;
begin
  if p_task is null then
    raise exception using errcode = '22004', message = 'p_task must not be null';
  end if;
  if p_ids is null then
    raise exception using errcode = '22004', message = 'p_ids must not be null';
  end if;
  if p_job_key is null then
    raise exception using errcode = '22004', message = 'p_job_key must not be null: omit it instead';
  end if;
  if p_queue is null then
    raise exception using errcode = '22004', message = 'p_queue must not be null: omit it instead';
  end if;
  if p_run_at is null then
    raise exception using errcode = '22004', message = 'p_run_at must not be null: omit it instead';
  end if;
  if p_max_attempts is null then
    raise exception using errcode = '22004', message = 'p_max_attempts must not be null: omit it instead';
  end if;
  if p_key_mode is null then
    raise exception using errcode = '22004', message = 'p_key_mode must not be null: omit it instead';
  end if;
  if p_scope is null then
    raise exception using errcode = '22004', message = 'p_scope must not be null: omit it instead';
  end if;

  -- The context functions live in schema ujira, which this role cannot reach, so
  -- their rules are repeated here: the settings must belong to this transaction.
  if v_principal is null or v_principal = '' or v_project is null or v_project = '' then
    raise exception using errcode = 'UJ001', message = 'no tenant context: this transaction did not set one';
  end if;
  if v_txid is distinct from txid_current()::text then
    raise exception using errcode = 'UJ001', message = 'no tenant context: the settings belong to another transaction';
  end if;
  -- A default would hand every session a tenant before any transaction set one.
  if exists (
    select 1
      from pg_db_role_setting as s
     where s.setrole in (0, (select r.oid from pg_roles as r where r.rolname = session_user))
       and s.setdatabase in (0, (select d.oid from pg_database as d where d.datname = current_database()))
       and exists (select 1 from unnest(s.setconfig) as c (setting) where c.setting like 'ujira.%')
  ) then
    raise exception using errcode = 'UJ001', message = 'no tenant context: a role or database default sets a ujira setting, and only a transaction may';
  end if;
  if v_tenant_scope is distinct from 'project' then
    raise exception using errcode = 'UJ001', message = 'a job needs one project: scope all cannot enqueue';
  end if;
  -- One spelling for the prefix and the payload, so a handler comparing ids as
  -- strings never misses, and two spellings of a tenant are one tenant here.
  begin
    v_principal := v_principal::uuid::text;
    v_project := v_project::uuid::text;
  exception when invalid_text_representation then
    raise exception using errcode = 'UJ001', message = 'tenant context is not a uuid';
  end;

  -- Colons, not dots: the crontab parser rejects dots in task names.
  if p_task !~ '^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)+$' or length(p_task) > 64 then
    raise exception using errcode = '22023', message = 'invalid task name: use colons, as in payout:advance';
  end if;
  -- Ids only, as strings. The tenant is added below, never taken from the caller.
  if jsonb_typeof(p_ids) <> 'object'
     or p_ids ? 'principalId' or p_ids ? 'projectId'
     or exists (select 1 from jsonb_each(p_ids) as e where jsonb_typeof(e.value) <> 'string') then
    raise exception using errcode = '22023', message = 'job ids must be strings, without principalId or projectId';
  end if;
  -- unsafe_dedupe can drop a state change, so it is never offered.
  if p_key_mode not in ('replace', 'preserve_run_at') then
    raise exception using errcode = '22023', message = 'unsupported job key mode';
  end if;
  if p_scope not in ('project', 'principal') then
    raise exception using errcode = '22023', message = 'unsupported job scope';
  end if;
  -- The worker's own limit on a queue name is 128, and the prefix takes 74. An
  -- empty name would collapse to the bare prefix and be shared by every such job.
  if p_job_key <> '-' and (p_job_key !~ '^[A-Za-z0-9][A-Za-z0-9:_.-]*$' or length(p_job_key) > 400) then
    raise exception using errcode = '22023', message = 'invalid job key';
  end if;
  if p_queue <> '-' and (p_queue !~ '^[A-Za-z0-9][A-Za-z0-9:_.-]*$' or length(p_queue) > 54) then
    raise exception using errcode = '22023', message = 'invalid queue name';
  end if;
  if p_max_attempts not between 1 and 100 then
    raise exception using errcode = '22023', message = 'max attempts must be from 1 to 100';
  end if;
  -- A run time no job could mean: never, the start of time, or further away than
  -- any schedule here reaches. Such a job would sit in the queue or jump it.
  if not isfinite(p_run_at) then
    raise exception using errcode = '22023', message = 'run at must be a finite time';
  end if;
  if p_run_at not between clock_timestamp() - interval '1 year' and clock_timestamp() + interval '1 year' then
    raise exception using errcode = '22023', message = 'run at must be within a year of now';
  end if;

  v_prefix := v_principal || ':' || case p_scope when 'project' then v_project else '*' end || ':';

  select j.id into v_job_id
    from graphile_worker.add_job(
      identifier   => p_task,
      payload      => (p_ids || jsonb_build_object('principalId', v_principal, 'projectId', v_project))::json,
      queue_name   => case when p_queue = '-' then null else v_prefix || p_queue end,
      run_at       => p_run_at,
      max_attempts => p_max_attempts,
      job_key      => case when p_job_key = '-' then null else v_prefix || p_job_key end,
      job_key_mode => p_key_mode
    ) as j;
  return v_job_id;
end
$fn$;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_worker;

create or replace function ujira_jobs.enqueue(
  p_task         text,
  p_ids          jsonb,
  p_job_key      text default '-',
  p_queue        text default '-',
  -- Jobs are claimed by (priority, run_at) with no tie break, and now() is the
  -- same for every job of a transaction, so now() would leave a queue's order to
  -- the heap. This keeps jobs of one transaction in the order they were added.
  p_run_at       timestamptz default clock_timestamp(),
  p_max_attempts integer default 5,
  p_key_mode     text default 'replace',
  p_scope        text default 'project'
) returns bigint
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_principal text := current_setting('ujira.principal_id', true);
  v_project   text := current_setting('ujira.project_id', true);
  v_txid      text := current_setting('ujira.txid', true);
  v_tenant_scope text := current_setting('ujira.scope', true);
  v_prefix    text;
  v_job_id    bigint;
begin
  if p_task is null then
    raise exception using errcode = '22004', message = 'p_task must not be null';
  end if;
  if p_ids is null then
    raise exception using errcode = '22004', message = 'p_ids must not be null';
  end if;
  if p_job_key is null then
    raise exception using errcode = '22004', message = 'p_job_key must not be null: omit it instead';
  end if;
  if p_queue is null then
    raise exception using errcode = '22004', message = 'p_queue must not be null: omit it instead';
  end if;
  if p_run_at is null then
    raise exception using errcode = '22004', message = 'p_run_at must not be null: omit it instead';
  end if;
  if p_max_attempts is null then
    raise exception using errcode = '22004', message = 'p_max_attempts must not be null: omit it instead';
  end if;
  if p_key_mode is null then
    raise exception using errcode = '22004', message = 'p_key_mode must not be null: omit it instead';
  end if;
  if p_scope is null then
    raise exception using errcode = '22004', message = 'p_scope must not be null: omit it instead';
  end if;

  -- The context functions live in schema ujira, which this role cannot reach, so
  -- their rules are repeated here: the settings must belong to this transaction.
  if v_principal is null or v_principal = '' or v_project is null or v_project = '' then
    raise exception using errcode = 'UJ001', message = 'no tenant context: this transaction did not set one';
  end if;
  if v_txid is distinct from txid_current()::text then
    raise exception using errcode = 'UJ001', message = 'no tenant context: the settings belong to another transaction';
  end if;
  if v_tenant_scope is distinct from 'project' then
    raise exception using errcode = 'UJ001', message = 'a job needs one project: scope all cannot enqueue';
  end if;
  -- One spelling for the prefix and the payload, so a handler comparing ids as
  -- strings never misses, and two spellings of a tenant are one tenant here.
  begin
    v_principal := v_principal::uuid::text;
    v_project := v_project::uuid::text;
  exception when invalid_text_representation then
    raise exception using errcode = 'UJ001', message = 'tenant context is not a uuid';
  end;

  -- Colons, not dots: the crontab parser rejects dots in task names.
  if p_task !~ '^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)+$' or length(p_task) > 64 then
    raise exception using errcode = '22023', message = 'invalid task name: use colons, as in payout:advance';
  end if;
  -- Ids only, as strings. The tenant is added below, never taken from the caller.
  if jsonb_typeof(p_ids) <> 'object'
     or p_ids ? 'principalId' or p_ids ? 'projectId'
     or exists (select 1 from jsonb_each(p_ids) as e where jsonb_typeof(e.value) <> 'string') then
    raise exception using errcode = '22023', message = 'job ids must be strings, without principalId or projectId';
  end if;
  -- unsafe_dedupe can drop a state change, so it is never offered.
  if p_key_mode not in ('replace', 'preserve_run_at') then
    raise exception using errcode = '22023', message = 'unsupported job key mode';
  end if;
  if p_scope not in ('project', 'principal') then
    raise exception using errcode = '22023', message = 'unsupported job scope';
  end if;
  -- The worker's own limit on a queue name is 128, and the prefix takes 74. An
  -- empty name would collapse to the bare prefix and be shared by every such job.
  if p_job_key <> '-' and (p_job_key !~ '^[A-Za-z0-9][A-Za-z0-9:_.-]*$' or length(p_job_key) > 400) then
    raise exception using errcode = '22023', message = 'invalid job key';
  end if;
  if p_queue <> '-' and (p_queue !~ '^[A-Za-z0-9][A-Za-z0-9:_.-]*$' or length(p_queue) > 54) then
    raise exception using errcode = '22023', message = 'invalid queue name';
  end if;
  if p_max_attempts not between 1 and 100 then
    raise exception using errcode = '22023', message = 'max attempts must be from 1 to 100';
  end if;

  v_prefix := v_principal || ':' || case p_scope when 'project' then v_project else '*' end || ':';

  select j.id into v_job_id
    from graphile_worker.add_job(
      identifier   => p_task,
      payload      => (p_ids || jsonb_build_object('principalId', v_principal, 'projectId', v_project))::json,
      queue_name   => case when p_queue = '-' then null else v_prefix || p_queue end,
      run_at       => p_run_at,
      max_attempts => p_max_attempts,
      job_key      => case when p_job_key = '-' then null else v_prefix || p_job_key end,
      job_key_mode => p_key_mode
    ) as j;
  return v_job_id;
end
$fn$;

reset role;

create or replace function ujira.bootstrap_worker_roles() returns void
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

select ujira.bootstrap_worker_roles();

set local role ujira_owner;

create or replace function ujira.current_principal_id() returns uuid
  language plpgsql
  stable
  set search_path = pg_catalog
as $fn$
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
$fn$;

reset role;
