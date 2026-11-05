-- expand
-- A fee names the terms it was charged under, which must be real and the tenant's own.
--
-- This could not land with the terms table. The tests of the release before that one
-- charged fees under terms they made up, and they have to keep passing while a deploy
-- is under way. They use real terms from that release on, so it can land now.
--
-- Not valid here and validated by the next migration, so the scan does not hold this
-- migration's lock. New rows are checked from now on.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.payout_attempts
  add constraint payout_attempts_fee_terms
    foreign key (principal_id, project_id, fee_terms_id)
    references ujira.fee_terms (principal_id, project_id, id)
    not valid;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- squawk-ignore ban-drop-constraint
alter table ujira.payout_attempts drop constraint payout_attempts_fee_terms;

reset role;
