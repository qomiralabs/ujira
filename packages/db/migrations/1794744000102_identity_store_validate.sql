-- contract
-- no-transaction
-- Checks the rows already in ujira.mandate_instances and ujira.projects against the
-- checks the expand half added, in a transaction of its own, so the scan takes only
-- a lock that lets traffic through.
--
-- One block because a no-transaction migration sends one statement, and the role
-- and timeouts have to be set inside it.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.mandate_instances validate constraint mandate_instances_status;
  alter table ujira.projects validate constraint projects_identity_settings_object;
end
$validate$;

-- Down Migration
do $unvalidate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.projects drop constraint projects_identity_settings_object;
  alter table ujira.projects
    add constraint projects_identity_settings_object
      check (identity_settings is null or jsonb_typeof(identity_settings) = 'object')
      not valid;
  alter table ujira.mandate_instances drop constraint mandate_instances_status;
  alter table ujira.mandate_instances
    add constraint mandate_instances_status
      check (status in ('deploying', 'active', 'paused', 'revoked', 'expired', 'deploy_failed'))
      not valid;
end
$unvalidate$;
