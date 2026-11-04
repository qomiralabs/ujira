-- expand
-- The one way a job gets created, the pools' heartbeats, and the narrow functions
-- that fan out cross-tenant work.
--
-- A job is created only through ujira_jobs.enqueue, which takes the tenant from
-- the transaction, so a job exists only if the write beside it commits, and one
-- tenant can never overwrite another's job. graphile_worker.add_job cannot serve
-- the app directly: it is security invoker and the worker tables have row level
-- security on with no policies.
--
-- This runs before the deploy step installs the worker schema. A plpgsql body is
-- not resolved until it is called, so that order is fine.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_worker;

-- Which pools are alive. A pool that stops beating has its locks released, which
-- is what frees the mandate queue a crashed job was holding.
create table ujira_jobs.worker_heartbeats (
  worker_id text primary key
    constraint worker_heartbeats_id_length check (char_length(worker_id) between 1 and 128),
  last_seen_at timestamptz not null default now(),
  started_at timestamptz not null default now()
);

-- p_job_key and p_queue default to '-', which is how "not set" reads here. A NULL
-- is refused for every argument, because an IF on NULL is false and a NULL once
-- slipped past the checks and stored a job with no tenant, so not set has to be a
-- value. '-' cannot be a real name: a name starts with a letter or a digit.
--
-- p_scope decides who shares a key or a queue. 'project' is the default. 'principal'
-- is for work that must run one at a time across all of a principal's projects, and
-- its '*' cannot be a project id, so the two can never share a name.
create function ujira_jobs.enqueue(
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

revoke all on function ujira_jobs.enqueue(text, jsonb, text, text, timestamptz, integer, text, text) from public;
grant usage on schema ujira_jobs to ujira_app;
grant execute on function ujira_jobs.enqueue(text, jsonb, text, text, timestamptz, integer, text, text) to ujira_app;

reset role;

set local role ujira_owner;

-- Each of these returns the tenant and one target id, so a cron can open one
-- tenant transaction per row without ever scanning across tenants as the app.
-- They are plpgsql so a NULL or oversized limit raises instead of quietly
-- returning everything or nothing, and so one whose table lands later can exist
-- now: until then it fails with undefined_table, and nothing calls it yet.

-- Keyset paged by instance id: pass the last id of a page to get the next, and no
-- id for the first. mandate_instances has no lifecycle column yet, so every
-- instance is active until it gets one.
create function ujira.reconcile_targets(p_after uuid, p_limit integer)
  returns table (principal_id uuid, project_id uuid, mandate_instance_id uuid)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'limit must be from 1 to 500';
  end if;
  return query
    select i.principal_id, i.project_id, i.id
      from ujira.mandate_instances as i
     where i.id > coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
     order by i.id
     limit p_limit;
end
$fn$;

-- Attempts still able to move whose deadline has passed. Settled, final and dead
-- attempts have nothing left to expire.
create function ujira.due_attempt_deadlines(p_before timestamptz, p_limit integer)
  returns table (principal_id uuid, project_id uuid, attempt_id uuid)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
begin
  if p_before is null then
    raise exception using errcode = '22004', message = 'p_before must not be null';
  end if;
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'limit must be from 1 to 500';
  end if;
  return query
    select a.principal_id, a.project_id, a.id
      from ujira.payout_attempts as a
     where a.deadline < p_before
       and a.status in ('created', 'requested', 'pending_approval', 'approved', 'executing')
     order by a.deadline, a.id
     limit p_limit;
end
$fn$;

-- Fee refunds past their due date that have not reached an end state.
create function ujira.overdue_fee_refunds(p_limit integer)
  returns table (principal_id uuid, project_id uuid, fee_refund_id uuid)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'limit must be from 1 to 500';
  end if;
  return query
    select r.principal_id, r.project_id, r.id
      from ujira.fee_refunds as r
     where r.due_at < clock_timestamp()
       and r.status in ('owed', 'awaiting_signatures', 'failed')
     order by r.due_at, r.id
     limit p_limit;
end
$fn$;

grant execute on function
  ujira.reconcile_targets(uuid, integer),
  ujira.due_attempt_deadlines(timestamptz, integer),
  ujira.overdue_fee_refunds(integer)
  to ujira_app;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ujira to ujira_scheduler;
alter function ujira.reconcile_targets(uuid, integer) owner to ujira_scheduler;
alter function ujira.due_attempt_deadlines(timestamptz, integer) owner to ujira_scheduler;
alter function ujira.overdue_fee_refunds(integer) owner to ujira_scheduler;
revoke create on schema ujira from ujira_scheduler;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.overdue_fee_refunds(integer);
drop function ujira.due_attempt_deadlines(timestamptz, integer);
drop function ujira.reconcile_targets(uuid, integer);

reset role;

set local role ujira_worker;

drop function ujira_jobs.enqueue(text, jsonb, text, text, timestamptz, integer, text, text);
drop table ujira_jobs.worker_heartbeats;
revoke usage on schema ujira_jobs from ujira_app;

reset role;
