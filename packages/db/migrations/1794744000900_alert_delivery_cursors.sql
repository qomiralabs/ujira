-- expand
-- Where telling operations of flagged mandates has reached, one position per sink, so
-- a restart picks up where the last delivery stopped and a new sink starts from the
-- first alert. As with the chain cursors, the indexer's login gets two functions and
-- never the table, and the app gets neither.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ops.alert_delivery_cursors (
  sink text primary key
    constraint alert_delivery_cursors_sink_format check (sink ~ '^[a-z][a-z0-9_]{0,63}$'),
  last_alert_id bigint not null
    constraint alert_delivery_cursors_last_alert_id check (last_alert_id >= 0),
  updated_at timestamptz not null default now()
);

grant select, insert, update on ops.alert_delivery_cursors to ujira_ops;

-- Zero before the sink's first delivery, which is before every alert.
create function ops.alert_delivery_cursor(target_sink text) returns bigint
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select coalesce(
    (select c.last_alert_id from ops.alert_delivery_cursors as c where c.sink = target_sink),
    0
  )
$fn$;

-- Only forward. A delivery that ran twice, or a slow one finishing after a later one,
-- must never move the position back and tell operations again.
create function ops.advance_alert_delivery_cursor(target_sink text, delivered_id bigint)
  returns void
  language sql
  security definer
  set search_path = pg_catalog
as $fn$
  insert into ops.alert_delivery_cursors as c (sink, last_alert_id)
  values (target_sink, delivered_id)
  on conflict (sink) do update
    set last_alert_id = greatest(c.last_alert_id, excluded.last_alert_id),
        updated_at = now()
$fn$;

revoke execute on function
  ops.alert_delivery_cursor(text),
  ops.advance_alert_delivery_cursor(text, bigint)
  from public;

grant execute on function
  ops.alert_delivery_cursor(text),
  ops.advance_alert_delivery_cursor(text, bigint)
  to ujira_indexer;

grant create on schema ops to ujira_ops;
alter function ops.alert_delivery_cursor(text) owner to ujira_ops;
alter function ops.advance_alert_delivery_cursor(text, bigint) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ops.advance_alert_delivery_cursor(text, bigint);
drop function ops.alert_delivery_cursor(text);
drop table ops.alert_delivery_cursors;

reset role;
