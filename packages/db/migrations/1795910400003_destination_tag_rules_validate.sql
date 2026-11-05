-- expand
-- no-transaction
-- Checks existing rows against the tag rules, outside the transaction that added
-- them, so the scan does not hold that migration's lock.
--
-- One block because a no-transaction migration sends one statement, and the role and
-- timeouts have to be set inside it.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.payout_legs validate constraint payout_legs_tag_chain;
  alter table ujira.receipt_legs validate constraint receipt_legs_tag_chain;
end
$validate$;

-- Down Migration
-- A validated check cannot be marked unvalidated again, so each is put back as the
-- first of these migrations left it.
do $unvalidate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.payout_legs drop constraint payout_legs_tag_chain;
  alter table ujira.payout_legs
    add constraint payout_legs_tag_chain check (destination_tag is null or chain = 'stellar') not valid;
  alter table ujira.receipt_legs drop constraint receipt_legs_tag_chain;
  alter table ujira.receipt_legs
    add constraint receipt_legs_tag_chain check (destination_tag is null or chain = 'stellar') not valid;
end
$unvalidate$;
