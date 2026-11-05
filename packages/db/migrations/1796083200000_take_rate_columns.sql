-- expand
-- The take rate is paid on chain as a fee on top of each payout. The database records
-- it where it happens, on the attempt, and holds the contract's own rules: charged is
-- total plus fee, the fee is never above the cap, and a mandate's fee cap can only go
-- down.
--
-- charged_amount is null only on a row written by code from before this migration,
-- which cannot know it. The checks are added not valid, so they bind new rows at once
-- without scanning the table, and a later migration validates them.
--
-- A new column of a domain with a check rewrites the table on PostgreSQL 17, under this
-- migration's lock, even when it is nullable. That is acceptable here only because no
-- release has written payout_attempts or receipts yet, so there is nothing to rewrite.
-- Do not copy it for a table that holds rows.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.payout_attempts
  add column fee_amount ujira.amount not null default 0,
  add column fee_bps_applied bigint not null default 0,
  add column fee_terms_id uuid,
  add column charged_amount ujira.amount;

alter table ujira.payout_attempts
  add constraint payout_attempts_fee_not_negative check (fee_amount >= 0) not valid,
  add constraint payout_attempts_fee_bps_range check (fee_bps_applied between 0 and 100) not valid,
  add constraint payout_attempts_charged_positive
    check (charged_amount is null or charged_amount > 0) not valid,
  add constraint payout_attempts_charged_is_total_plus_fee
    check (charged_amount is null or charged_amount = total_amount + fee_amount) not valid,
  -- The contract's overflow free cap, which rounds down. It must agree with the
  -- contract at every total, so it is written the contract's way, not as a percentage.
  add constraint payout_attempts_fee_within_cap check (
    fee_amount <= div(total_amount, 10000) * fee_bps_applied
      + div(mod(total_amount, 10000) * fee_bps_applied, 10000)
  ) not valid,
  add constraint payout_attempts_fee_has_terms
    check (fee_amount = 0 or fee_terms_id is not null) not valid;

-- Null until the instance reports them, because a default would be a promise the
-- contract never made, and with only lowering allowed it could never be corrected up.
alter table ujira.mandate_instances
  add column max_fee_bps bigint,
  add column fee_address text;

alter table ujira.mandate_instances
  add constraint mandate_instances_max_fee_bps_range
    check (max_fee_bps between 0 and 100) not valid,
  add constraint mandate_instances_fee_address_length
    check (char_length(fee_address) between 1 and 128) not valid;

create function ujira.fee_cap_only_lowers() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if old.max_fee_bps is not null
     and (new.max_fee_bps is null or new.max_fee_bps > old.max_fee_bps) then
    raise exception using
      errcode = 'UJ007',
      message = 'a fee cap can only go down';
  end if;
  if old.fee_address is not null and new.fee_address is distinct from old.fee_address then
    raise exception using
      errcode = 'UJ007',
      message = 'a fee address cannot change';
  end if;
  return new;
end
$fn$;

create trigger mandate_instances_fee_cap_only_lowers
  before update of max_fee_bps, fee_address on ujira.mandate_instances
  for each row execute function ujira.fee_cap_only_lowers();

-- The contract holds these and the indexer mirrors them, so the indexer alone may
-- change them. An API request never decides what a principal's cap is.
grant update (max_fee_bps, fee_address) on ujira.mandate_instances to ujira_indexer;
create policy indexer_fee_cap on ujira.mandate_instances for update to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id())
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());

-- The fee leaves the mandate alongside the payout, so the contract's spent figure holds
-- both. The books keep them apart.
--
-- The drop is safe because the next statement puts back a wider check, in the same
-- transaction, so no writer sees the table unguarded.
-- squawk-ignore ban-drop-constraint
alter table ujira.ledger_accounts drop constraint ledger_accounts_kind;
alter table ujira.ledger_accounts
  add constraint ledger_accounts_kind
    check (kind in ('balance', 'pending', 'committed', 'spent', 'external', 'fee')) not valid;

create or replace view ujira.ledger_reconciliation with (security_invoker = true) as
  with latest as (
    select distinct on (s.mandate_instance_id) s.*
      from ujira.mandate_state_snapshots as s
     order by s.mandate_instance_id, s.ledger desc
  ),
  accounts as (
    select a.mandate_instance_id,
           sum(a.balance) filter (where a.kind = 'balance') as balance,
           sum(a.balance) filter (where a.kind = 'pending') as pending,
           sum(a.balance) filter (where a.kind = 'committed') as committed,
           sum(a.balance) filter (where a.kind = 'spent') as spent,
           sum(a.balance) filter (where a.kind = 'fee') as fee
      from ujira.ledger_accounts as a
     group by a.mandate_instance_id
  )
  select l.principal_id,
         l.project_id,
         l.mandate_instance_id,
         l.ledger,
         l.taken_at,
         l.balance as state_balance,
         coalesce(a.balance, 0) as ledger_balance,
         l.pending as state_pending,
         coalesce(a.pending, 0) as ledger_pending,
         l.committed as state_committed,
         coalesce(a.committed, 0) as ledger_committed,
         l.spent as state_spent,
         coalesce(a.spent, 0) as ledger_spent,
         (l.balance = coalesce(a.balance, 0)
           and l.pending = coalesce(a.pending, 0)
           and l.committed = coalesce(a.committed, 0)
           and l.spent = coalesce(a.spent, 0) + coalesce(a.fee, 0)) as matches,
         coalesce(a.fee, 0) as ledger_fee
    from latest as l
    left join accounts as a on a.mandate_instance_id = l.mandate_instance_id;

-- The take rate is a line of its own on a receipt, never folded into a leg's fee.
alter table ujira.receipts
  add column take_rate_amount ujira.amount not null default 0,
  add column take_rate_bps bigint not null default 0,
  add column take_rate_refunded_amount ujira.amount not null default 0,
  add column charged_amount ujira.amount;

alter table ujira.receipts
  add constraint receipts_take_rate_not_negative check (take_rate_amount >= 0) not valid,
  add constraint receipts_take_rate_bps_range check (take_rate_bps between 0 and 100) not valid,
  add constraint receipts_take_rate_refund_within
    check (take_rate_refunded_amount between 0 and take_rate_amount) not valid,
  add constraint receipts_charged_is_settlement_plus_take
    check (charged_amount is null or charged_amount = settlement_amount + take_rate_amount) not valid;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.receipts
  drop column charged_amount,
  drop column take_rate_refunded_amount,
  drop column take_rate_bps,
  drop column take_rate_amount;

drop view ujira.ledger_reconciliation;
create view ujira.ledger_reconciliation with (security_invoker = true) as
  with latest as (
    select distinct on (s.mandate_instance_id) s.*
      from ujira.mandate_state_snapshots as s
     order by s.mandate_instance_id, s.ledger desc
  ),
  accounts as (
    select a.mandate_instance_id,
           sum(a.balance) filter (where a.kind = 'balance') as balance,
           sum(a.balance) filter (where a.kind = 'pending') as pending,
           sum(a.balance) filter (where a.kind = 'committed') as committed,
           sum(a.balance) filter (where a.kind = 'spent') as spent
      from ujira.ledger_accounts as a
     group by a.mandate_instance_id
  )
  select l.principal_id,
         l.project_id,
         l.mandate_instance_id,
         l.ledger,
         l.taken_at,
         l.balance as state_balance,
         coalesce(a.balance, 0) as ledger_balance,
         l.pending as state_pending,
         coalesce(a.pending, 0) as ledger_pending,
         l.committed as state_committed,
         coalesce(a.committed, 0) as ledger_committed,
         l.spent as state_spent,
         coalesce(a.spent, 0) as ledger_spent,
         (l.balance = coalesce(a.balance, 0)
           and l.pending = coalesce(a.pending, 0)
           and l.committed = coalesce(a.committed, 0)
           and l.spent = coalesce(a.spent, 0)) as matches
    from latest as l
    left join accounts as a on a.mandate_instance_id = l.mandate_instance_id;
grant select on ujira.ledger_reconciliation to ujira_app, ujira_reader, ujira_indexer;

-- squawk-ignore ban-drop-constraint
alter table ujira.ledger_accounts drop constraint ledger_accounts_kind;
alter table ujira.ledger_accounts
  add constraint ledger_accounts_kind
    check (kind in ('balance', 'pending', 'committed', 'spent', 'external'));

drop policy indexer_fee_cap on ujira.mandate_instances;
revoke update (max_fee_bps, fee_address) on ujira.mandate_instances from ujira_indexer;
drop trigger mandate_instances_fee_cap_only_lowers on ujira.mandate_instances;
drop function ujira.fee_cap_only_lowers();
alter table ujira.mandate_instances
  drop column fee_address,
  drop column max_fee_bps;

alter table ujira.payout_attempts
  drop column charged_amount,
  drop column fee_terms_id,
  drop column fee_bps_applied,
  drop column fee_amount;

reset role;
