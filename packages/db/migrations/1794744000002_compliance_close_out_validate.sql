-- expand
-- Validates the checks the previous migration added as not valid, in their own step, so
-- adding them never held a lock while the table was scanned.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.compliance_parked_jobs validate constraint compliance_parked_jobs_close_reason;
alter table ujira.compliance_parked_jobs validate constraint compliance_parked_jobs_closed_when;
alter table ujira.compliance_parked_jobs validate constraint compliance_parked_jobs_status;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.compliance_parked_jobs
  drop constraint compliance_parked_jobs_status,
  add constraint compliance_parked_jobs_status
    check (status in ('parked', 'resumed', 'closed')) not valid,
  drop constraint compliance_parked_jobs_closed_when,
  add constraint compliance_parked_jobs_closed_when
    check ((status = 'closed') = (closed_at is not null and close_reason is not null)) not valid,
  drop constraint compliance_parked_jobs_close_reason,
  add constraint compliance_parked_jobs_close_reason
    check (close_reason in ('mandate_revoked', 'mandate_expired')) not valid;

reset role;
