-- expand
-- What serializes every new promise on a mandate's balance. An attempt is checked
-- against the instance's free balance while its row is locked, so of any number of jobs
-- racing for the same funds, each sees what the one before it promised.
--
-- The app holds no other update right on this table, and a row lock takes one. So this
-- column is that right, and all it can do is say when the balance was last checked.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.mandate_instances add column balance_checked_at timestamptz;

grant update (balance_checked_at) on ujira.mandate_instances to ujira_app;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

revoke update (balance_checked_at) on ujira.mandate_instances from ujira_app;
alter table ujira.mandate_instances drop column balance_checked_at;

reset role;
