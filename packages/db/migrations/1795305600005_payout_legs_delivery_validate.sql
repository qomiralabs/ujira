-- contract
-- no-transaction
-- Checks the rows already in ujira.payout_legs against the constraint the last
-- migration added, in a transaction of its own, so the scan takes only a lock that
-- lets traffic through.
--
-- One block because a no-transaction migration sends one statement, and the role
-- and timeouts have to be set inside it.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.payout_legs validate constraint payout_legs_delivery_whole;
end
$validate$;

-- Down Migration
do $unvalidate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.payout_legs drop constraint payout_legs_delivery_whole;
  alter table ujira.payout_legs
    add constraint payout_legs_delivery_whole check (
      num_nonnulls(
        receive_amount, receive_currency, receive_scale, fx_numerator, fx_denominator, cost_bearer,
        quote_id
      ) in (0, 7)
    ) not valid;
end
$unvalidate$;
