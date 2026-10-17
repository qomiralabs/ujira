-- Runs as ujira_worker right after the graphile-worker schema install.
--
-- graphile_worker.add_job is security invoker and the worker tables have row
-- level security on with no policies, so the app role cannot use it even with
-- grants. This definer function is the only way in. It takes the tenant from
-- the transaction context, so a job can never be filed under another tenant,
-- and it prefixes job keys and queue names with the tenant because both are
-- global: a bare key from one tenant would replace another tenant's job.
create function ujira_jobs.enqueue(
  p_task         text,
  p_ids          jsonb,
  p_job_key      text default null,
  p_queue        text default null,
  p_run_at       timestamptz default null,
  p_max_attempts integer default null,
  p_key_mode     text default 'replace'
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_principal text := current_setting('ujira.principal_id', true);
  v_project   text := current_setting('ujira.project_id', true);
  v_prefix    text;
  v_job_id    bigint;
begin
  if v_principal is null or v_principal = '' or v_project is null or v_project = '' then
    raise exception using errcode = 'UJ001', message = 'tenant context missing';
  end if;
  if v_project = 'all' then
    raise exception using errcode = 'UJ001', message = 'jobs need a single project scope';
  end if;
  -- The casts reject anything that is not a uuid before it reaches a key.
  v_prefix := v_principal::uuid::text || ':' || v_project::uuid::text || ':';
  -- Colons, not dots: the crontab parser rejects dots in task names.
  if p_task !~ '^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)*$' or length(p_task) > 64 then
    raise exception using errcode = '22023', message = 'invalid task identifier';
  end if;
  if jsonb_typeof(p_ids) <> 'object'
     or p_ids ? 'principalId' or p_ids ? 'projectId'
     or exists (select 1 from jsonb_each(p_ids) e where jsonb_typeof(e.value) <> 'string') then
    raise exception using errcode = '22023', message = 'job payload must be string ids without tenant ids';
  end if;
  -- unsafe_dedupe can drop a state change, so it is never offered.
  if p_key_mode not in ('replace', 'preserve_run_at') then
    raise exception using errcode = '22023', message = 'unsupported job key mode';
  end if;
  select j.id into v_job_id
  from graphile_worker.add_job(
    identifier   => p_task,
    payload      => (p_ids || jsonb_build_object('principalId', v_principal, 'projectId', v_project))::json,
    queue_name   => case when p_queue is null then null else v_prefix || p_queue end,
    -- Jobs are claimed by (priority, run_at) with no tie break, and now() is
    -- the same for every job of a transaction, so without this a queue's order
    -- would follow the heap and change after any update to a job row.
    run_at       => coalesce(p_run_at, clock_timestamp()),
    max_attempts => p_max_attempts,
    job_key      => case when p_job_key is null then null else v_prefix || p_job_key end,
    job_key_mode => p_key_mode
  ) as j;
  return v_job_id;
end $$;

revoke all on function ujira_jobs.enqueue(text, jsonb, text, text, timestamptz, integer, text) from public;
grant usage on schema ujira_jobs to ujira_app;
grant execute on function ujira_jobs.enqueue(text, jsonb, text, text, timestamptz, integer, text) to ujira_app;
