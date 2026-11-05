-- expand
-- no-transaction
-- Checks existing attempts against the terms key, outside the transaction that added it,
-- so the scan does not hold that migration's lock.
--
-- One block because a no-transaction migration sends one statement, and the role and
-- timeouts have to be set inside it.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.payout_attempts validate constraint payout_attempts_fee_terms;
end
$validate$;

-- Down Migration
-- A validated key cannot be marked unvalidated again, so it is put back as the first of
-- these migrations left it.
do $unvalidate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.payout_attempts drop constraint payout_attempts_fee_terms;
  alter table ujira.payout_attempts
    add constraint payout_attempts_fee_terms
      foreign key (principal_id, project_id, fee_terms_id)
      references ujira.fee_terms (principal_id, project_id, id)
      not valid;
end
$unvalidate$;
