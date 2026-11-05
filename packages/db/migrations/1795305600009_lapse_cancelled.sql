-- expand
-- What is left to clear up after a lapse. An attempt proven dead because it lapsed still
-- holds its funds on chain until someone cancels it, so each records when that was done.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.payout_attempts add column lapse_cancelled_at timestamptz;

grant update (lapse_cancelled_at) on ujira.payout_attempts to ujira_app;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

revoke update (lapse_cancelled_at) on ujira.payout_attempts from ujira_app;
alter table ujira.payout_attempts drop column lapse_cancelled_at;

reset role;
