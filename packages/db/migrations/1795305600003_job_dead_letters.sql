-- expand
-- Jobs that ran out of tries. A dead letter belongs to a tenant, so it lives with
-- the tenant's data under the usual policies, not in the queue's schemas, which
-- hold no tenant columns. It is written on the app login, inside the tenant's own
-- transaction, and an operator replays it from there.
--
-- Rows carry ids and a code. The job's payload holds ids only, and an error's
-- message could say anything, so no message is kept.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ujira.job_dead_letters (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  -- A job can die after this row commits and run once more, so its id is what
  -- keeps that second run from writing a second row.
  source_job_id bigint not null
    constraint job_dead_letters_source_positive check (source_job_id > 0),
  task text not null
    constraint job_dead_letters_task_format
      check (task ~ '^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)+$' and char_length(task) <= 64),
  -- The tenant ids are on the row itself, so they are never in here as well.
  ids jsonb not null
    constraint job_dead_letters_ids_shape
      check (jsonb_typeof(ids) = 'object' and not (ids ? 'principalId' or ids ? 'projectId')),
  -- A count that stops at 12, or at the worker's limit of 100 attempts.
  -- squawk-ignore prefer-bigint-over-int
  tries integer not null
    constraint job_dead_letters_tries_positive check (tries > 0),
  reason text not null
    constraint job_dead_letters_reason_format check (reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz not null default now(),
  replayed_at timestamptz,
  constraint job_dead_letters_once unique (principal_id, project_id, source_job_id),
  constraint job_dead_letters_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

select ujira.apply_tenant_policies('ujira.job_dead_letters');

grant select, insert on ujira.job_dead_letters to ujira_app;
grant update (replayed_at) on ujira.job_dead_letters to ujira_app;
grant select on ujira.job_dead_letters to ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.job_dead_letters;

reset role;
