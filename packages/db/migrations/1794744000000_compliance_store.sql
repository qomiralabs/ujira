-- expand
-- Compliance: a mandate instance UJIRA stops serving until it complies again, the jobs
-- parked on it, and the notices owed to its principal. A mark is current state, so a clear
-- removes it; the notices are the history, and they are never edited.
--
-- A resumed job keeps its row as `resumed` for whatever re-enqueues it.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ujira.compliance_marks (
  principal_id uuid not null,
  project_id uuid not null,
  mandate_instance_id uuid not null,
  reason text not null
    constraint compliance_marks_reason check (reason in ('principal_key_risk')),
  since timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (principal_id, project_id, mandate_instance_id),
  foreign key (principal_id, project_id, mandate_instance_id)
    references ujira.mandate_instances (principal_id, project_id, id)
);

create table ujira.compliance_parked_jobs (
  principal_id uuid not null,
  project_id uuid not null,
  mandate_instance_id uuid not null,
  job_id text not null
    constraint compliance_parked_jobs_job_id_length check (char_length(job_id) between 1 and 200),
  status text not null default 'parked'
    constraint compliance_parked_jobs_status check (status in ('parked', 'resumed')),
  parked_at timestamptz not null default now(),
  resumed_at timestamptz,
  constraint compliance_parked_jobs_resumed_when
    check ((status = 'resumed') = (resumed_at is not null)),
  -- Parking a job twice keeps one row.
  primary key (principal_id, project_id, mandate_instance_id, job_id),
  foreign key (principal_id, project_id, mandate_instance_id)
    references ujira.mandate_instances (principal_id, project_id, id)
);

create index compliance_parked_jobs_waiting
  on ujira.compliance_parked_jobs (principal_id, project_id, mandate_instance_id)
  where status = 'parked';

create table ujira.compliance_notices (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_instance_id uuid not null,
  transition text not null
    constraint compliance_notices_transition check (transition in ('noncompliant', 'compliant')),
  noticed_at timestamptz not null,
  fixes jsonb not null default '[]'::jsonb
    constraint compliance_notices_fixes_array check (jsonb_typeof(fixes) = 'array'),
  created_at timestamptz not null default now(),
  foreign key (principal_id, project_id, mandate_instance_id)
    references ujira.mandate_instances (principal_id, project_id, id)
);

create index compliance_notices_by_instance
  on ujira.compliance_notices (principal_id, project_id, mandate_instance_id, created_at);

create trigger compliance_notices_append_only before update or delete on ujira.compliance_notices
  for each row execute function ujira.forbid_mutation();
create trigger compliance_notices_no_truncate before truncate on ujira.compliance_notices
  for each statement execute function ujira.forbid_mutation();

select ujira.apply_tenant_policies('ujira.compliance_marks');
select ujira.apply_tenant_policies('ujira.compliance_parked_jobs');
select ujira.apply_tenant_policies('ujira.compliance_notices');

create policy tenant_delete on ujira.compliance_marks for delete to ujira_app
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());

grant select, insert, delete on ujira.compliance_marks to ujira_app;
grant select, insert on ujira.compliance_parked_jobs to ujira_app;
grant update (status, parked_at, resumed_at) on ujira.compliance_parked_jobs to ujira_app;
grant select, insert on ujira.compliance_notices to ujira_app;
grant select on ujira.compliance_marks, ujira.compliance_parked_jobs, ujira.compliance_notices
  to ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.compliance_notices;
drop table ujira.compliance_parked_jobs;
drop table ujira.compliance_marks;

reset role;
