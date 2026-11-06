-- expand
-- The key is now one account per project. What limits reserves per principal is the
-- sponsor's own budget, which counts them whichever project asked.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- The code still running during a deploy checks for an account before it makes one,
-- so it never makes a principal's second, and nothing it relies on goes away before
-- it is replaced. The key on the project, from the last migration, holds from here.
-- squawk-ignore ban-drop-constraint
alter table ujira.funding_accounts drop constraint funding_accounts_one_per_principal;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- This fails once any principal holds an account in a second project, and rightly: which
-- of the two to give up is a decision for a person.
alter table ujira.funding_accounts
  add constraint funding_accounts_one_per_principal unique (principal_id, network);

reset role;
