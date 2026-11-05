-- expand
-- Where the indexer has read up to on each network. The table has been there since
-- ops was created, with no way for the indexer's login to reach it, and the login
-- only ever gets the two functions below rather than the table. The app has no
-- reason to read a position, so it gets neither.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- Null before the first scan of the network.
create function ops.chain_cursor(target_network text) returns text
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select c.cursor from ops.chain_cursors as c where c.network = target_network
$fn$;

-- A position can move back, so a scan can be run again over a range. Intake's writes
-- are keyed, so reading a range twice changes nothing.
create function ops.advance_chain_cursor(target_network text, next_cursor text) returns void
  language sql
  security definer
  set search_path = pg_catalog
as $fn$
  insert into ops.chain_cursors (network, cursor)
  values (target_network, next_cursor)
  on conflict (network) do update set cursor = excluded.cursor
$fn$;

revoke execute on function
  ops.chain_cursor(text),
  ops.advance_chain_cursor(text, text)
  from public;

grant execute on function
  ops.chain_cursor(text),
  ops.advance_chain_cursor(text, text)
  to ujira_indexer;

grant create on schema ops to ujira_ops;
alter function ops.chain_cursor(text) owner to ujira_ops;
alter function ops.advance_chain_cursor(text, text) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function ops.advance_chain_cursor(text, text);
drop function ops.chain_cursor(text);
