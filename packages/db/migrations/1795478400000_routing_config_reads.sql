-- expand
-- The two reads a service makes of the routing configuration. Every service
-- polls the pointer every 30 seconds, so that read must not carry the whole
-- document, and it fetches a version only when the pointer has moved. The app
-- role cannot read schema ops, so like the function beside them these run as
-- ujira_ops. They read only; writing a version stays with ujira_ops itself.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- The live version number, or null before one is activated.
create function ops.active_routing_config_version()
  returns bigint
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select a.version from ops.routing_config_active as a
$fn$;

-- One stored version, or no row for a version that does not exist.
create function ops.routing_config_version(wanted bigint)
  returns table (version bigint, document jsonb, created_by text, created_at timestamptz)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select v.version, v.document, v.created_by, v.created_at
    from ops.routing_config_versions as v
   where v.version = wanted
$fn$;

revoke all on function ops.active_routing_config_version() from public;
revoke all on function ops.routing_config_version(bigint) from public;
grant execute on function
  ops.active_routing_config_version(),
  ops.routing_config_version(bigint)
  to ujira_app;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ops to ujira_ops;
alter function ops.active_routing_config_version() owner to ujira_ops;
alter function ops.routing_config_version(bigint) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function ops.routing_config_version(bigint);
drop function ops.active_routing_config_version();
