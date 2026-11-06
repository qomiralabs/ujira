-- expand
-- bootstrap
-- The role that will own the one function able to say whose a recipient identity
-- is. A provider's callback names only the identity, so the service has to find the
-- tenant from it, and no login should be able to read every tenant's rows to do so.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is never
-- dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_fn_identities') then
    create role ujira_fn_identities nologin noinherit nobypassrls;
  end if;
  alter role ujira_fn_identities nobypassrls;
end
$roles$;

grant ujira_fn_identities to ujira_owner;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke ujira_fn_identities from ujira_owner;
