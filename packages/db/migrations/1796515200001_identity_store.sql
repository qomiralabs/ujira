-- expand
-- What the identity service reads that had nowhere to live.
--
-- A mandate instance's lifecycle: eligibility refuses to pay under an instance that
-- is not active, and until now nothing recorded whether it was. A new row starts as
-- deploying, so an instance nobody has marked active pays no one.
--
-- A project's identity settings, as the principal saved them. Null means the
-- service's default, and the service validates what it reads, so the column only
-- has to be an object.
--
-- And the one lookup a provider's callback needs: whose an identity row is, by its
-- id alone, answered for one exact id at a time.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.mandate_instances
  add column status text not null default 'deploying';

-- Checked here for new rows and validated in a later migration for the old ones,
-- which all hold the default.
alter table ujira.mandate_instances
  add constraint mandate_instances_status
    check (status in ('deploying', 'active', 'paused', 'revoked', 'expired', 'deploy_failed'))
    not valid;

grant update (status) on ujira.mandate_instances to ujira_app;

alter table ujira.projects
  add column identity_settings jsonb;

alter table ujira.projects
  add constraint projects_identity_settings_object
    check (identity_settings is null or jsonb_typeof(identity_settings) = 'object')
    not valid;

create policy identity_scope on ujira.recipient_identities for select to ujira_fn_identities
  using (true);

grant usage on schema ujira to ujira_fn_identities;
grant select (id, principal_id, project_id) on ujira.recipient_identities to ujira_fn_identities;

-- No row when the id is no identity of ours. It cannot list anything, and an id is a
-- random uuid the provider was given for this one row.
create function ujira.recipient_identity_scope(target_id uuid)
  returns table (principal_id uuid, project_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select i.principal_id, i.project_id
    from ujira.recipient_identities as i
   where i.id = target_id
$fn$;

revoke execute on function ujira.recipient_identity_scope(uuid) from public;
grant execute on function ujira.recipient_identity_scope(uuid) to ujira_app;

grant create on schema ujira to ujira_fn_identities;
alter function ujira.recipient_identity_scope(uuid) owner to ujira_fn_identities;
revoke create on schema ujira from ujira_fn_identities;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.recipient_identity_scope(uuid);
revoke select (id, principal_id, project_id) on ujira.recipient_identities from ujira_fn_identities;
revoke usage on schema ujira from ujira_fn_identities;
drop policy identity_scope on ujira.recipient_identities;
alter table ujira.projects drop constraint projects_identity_settings_object;
alter table ujira.projects drop column identity_settings;
revoke update (status) on ujira.mandate_instances from ujira_app;
alter table ujira.mandate_instances drop constraint mandate_instances_status;
alter table ujira.mandate_instances drop column status;

reset role;
