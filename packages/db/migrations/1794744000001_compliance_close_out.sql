-- expand
-- A parked job on a mandate that was revoked or expired can never resume, so it is closed
-- with that reason instead of staying blocked by a policy nobody can fix any more.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- The status check is replaced by a wider one that accepts every row the old one did,
-- so no guarantee a reader relies on is lost.
-- squawk-ignore ban-drop-constraint
alter table ujira.compliance_parked_jobs
  add column closed_at timestamptz,
  add column close_reason text,
  add constraint compliance_parked_jobs_close_reason
    check (close_reason in ('mandate_revoked', 'mandate_expired')) not valid,
  add constraint compliance_parked_jobs_closed_when
    check ((status = 'closed') = (closed_at is not null and close_reason is not null)) not valid,
  drop constraint compliance_parked_jobs_status,
  add constraint compliance_parked_jobs_status
    check (status in ('parked', 'resumed', 'closed')) not valid;

grant update (closed_at, close_reason) on ujira.compliance_parked_jobs to ujira_app;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

revoke update (closed_at, close_reason) on ujira.compliance_parked_jobs from ujira_app;

alter table ujira.compliance_parked_jobs
  drop constraint compliance_parked_jobs_status,
  add constraint compliance_parked_jobs_status check (status in ('parked', 'resumed')),
  drop constraint compliance_parked_jobs_closed_when,
  drop constraint compliance_parked_jobs_close_reason,
  drop column close_reason,
  drop column closed_at;

reset role;
