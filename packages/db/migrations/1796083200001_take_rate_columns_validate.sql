-- expand
-- no-transaction
-- Checks existing rows against the take rate rules, outside the transaction that added
-- them, so the scans do not hold that migration's locks.
--
-- One block because a no-transaction migration sends one statement, and the role and
-- timeouts have to be set inside it.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.payout_attempts validate constraint payout_attempts_fee_not_negative;
  alter table ujira.payout_attempts validate constraint payout_attempts_fee_bps_range;
  alter table ujira.payout_attempts validate constraint payout_attempts_charged_positive;
  alter table ujira.payout_attempts validate constraint payout_attempts_charged_is_total_plus_fee;
  alter table ujira.payout_attempts validate constraint payout_attempts_fee_within_cap;
  alter table ujira.payout_attempts validate constraint payout_attempts_fee_has_terms;
  alter table ujira.mandate_instances validate constraint mandate_instances_max_fee_bps_range;
  alter table ujira.mandate_instances validate constraint mandate_instances_fee_address_length;
  alter table ujira.ledger_accounts validate constraint ledger_accounts_kind;
  alter table ujira.receipts validate constraint receipts_take_rate_not_negative;
  alter table ujira.receipts validate constraint receipts_take_rate_bps_range;
  alter table ujira.receipts validate constraint receipts_take_rate_refund_within;
  alter table ujira.receipts validate constraint receipts_charged_is_settlement_plus_take;
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
  alter table ujira.payout_attempts drop constraint payout_attempts_fee_not_negative;
  alter table ujira.payout_attempts
    add constraint payout_attempts_fee_not_negative check (fee_amount >= 0) not valid;
  alter table ujira.payout_attempts drop constraint payout_attempts_fee_bps_range;
  alter table ujira.payout_attempts
    add constraint payout_attempts_fee_bps_range check (fee_bps_applied between 0 and 100) not valid;
  alter table ujira.payout_attempts drop constraint payout_attempts_charged_positive;
  alter table ujira.payout_attempts
    add constraint payout_attempts_charged_positive
      check (charged_amount is null or charged_amount > 0) not valid;
  alter table ujira.payout_attempts drop constraint payout_attempts_charged_is_total_plus_fee;
  alter table ujira.payout_attempts
    add constraint payout_attempts_charged_is_total_plus_fee
      check (charged_amount is null or charged_amount = total_amount + fee_amount) not valid;
  alter table ujira.payout_attempts drop constraint payout_attempts_fee_within_cap;
  alter table ujira.payout_attempts
    add constraint payout_attempts_fee_within_cap check (
      fee_amount <= div(total_amount, 10000) * fee_bps_applied
        + div(mod(total_amount, 10000) * fee_bps_applied, 10000)
    ) not valid;
  alter table ujira.payout_attempts drop constraint payout_attempts_fee_has_terms;
  alter table ujira.payout_attempts
    add constraint payout_attempts_fee_has_terms
      check (fee_amount = 0 or fee_terms_id is not null) not valid;
  alter table ujira.mandate_instances drop constraint mandate_instances_max_fee_bps_range;
  alter table ujira.mandate_instances
    add constraint mandate_instances_max_fee_bps_range
      check (max_fee_bps between 0 and 100) not valid;
  alter table ujira.mandate_instances drop constraint mandate_instances_fee_address_length;
  alter table ujira.mandate_instances
    add constraint mandate_instances_fee_address_length
      check (char_length(fee_address) between 1 and 128) not valid;
  alter table ujira.ledger_accounts drop constraint ledger_accounts_kind;
  alter table ujira.ledger_accounts
    add constraint ledger_accounts_kind
      check (kind in ('balance', 'pending', 'committed', 'spent', 'external', 'fee')) not valid;
  alter table ujira.receipts drop constraint receipts_take_rate_not_negative;
  alter table ujira.receipts
    add constraint receipts_take_rate_not_negative check (take_rate_amount >= 0) not valid;
  alter table ujira.receipts drop constraint receipts_take_rate_bps_range;
  alter table ujira.receipts
    add constraint receipts_take_rate_bps_range check (take_rate_bps between 0 and 100) not valid;
  alter table ujira.receipts drop constraint receipts_take_rate_refund_within;
  alter table ujira.receipts
    add constraint receipts_take_rate_refund_within
      check (take_rate_refunded_amount between 0 and take_rate_amount) not valid;
  alter table ujira.receipts drop constraint receipts_charged_is_settlement_plus_take;
  alter table ujira.receipts
    add constraint receipts_charged_is_settlement_plus_take
      check (charged_amount is null or charged_amount = settlement_amount + take_rate_amount) not valid;
end
$unvalidate$;
