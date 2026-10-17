-- Runs once per database as the platform admin, before any migration. Roles
-- are created by the test with generated passwords.
revoke create on schema public from public;
grant create on database ujira to ujira_owner;
-- graphile-worker runs "create schema if not exists" on every install, which
-- needs CREATE on the database even when the schema is already there.
grant create on database ujira to ujira_worker;
create schema graphile_worker authorization ujira_worker;
create schema ujira_jobs authorization ujira_worker;
-- Functions are executable by PUBLIC by default. Upgrades add new worker
-- functions, so the revoke has to be a default and not a one off.
alter default privileges for role ujira_worker revoke execute on functions from public;
