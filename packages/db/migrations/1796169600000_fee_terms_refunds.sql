-- expand
-- Every fee traces from the agreed terms to the chain and back: what rate applied, what
-- was paid and received, and, when an anchor refunds a leg, what part of the fee goes
-- back to the principal. The fee here is the take alone. UJIRA's own spend on fees and
-- rent is not recorded here, and nothing here recovers it from a principal.
--
-- Terms, reconciliations and leg refunds are append only. A fee refund is a state
-- machine with a permanent idempotency key.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is never
-- dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_fn_fees') then
    create role ujira_fn_fees nologin noinherit nobypassrls;
  end if;
  alter role ujira_fn_fees nobypassrls;
end
$roles$;

grant ujira_fn_fees to ujira_owner;

set local role ujira_owner;

insert into ujira.status_transitions (machine, from_status, to_status) values
  ('fee_refund', 'owed', 'awaiting_signatures'),
  ('fee_refund', 'awaiting_signatures', 'submitted'),
  ('fee_refund', 'awaiting_signatures', 'failed'),
  ('fee_refund', 'submitted', 'settled'),
  ('fee_refund', 'submitted', 'failed'),
  ('fee_refund', 'failed', 'awaiting_signatures');

create table ujira.fee_terms (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  rate_bps bigint not null
    constraint fee_terms_rate_range check (rate_bps between 0 and 100),
  basis text not null
    constraint fee_terms_basis
      check (basis in ('standard', 'committed_volume', 'negotiated', 'internal_at_cost')),
  valid_from timestamptz not null,
  -- A pointer to the contract, never its text.
  contract_reference text
    constraint fee_terms_contract_reference_length
      check (char_length(contract_reference) between 1 and 128),
  created_at timestamptz not null default now(),
  constraint fee_terms_per_instant unique (principal_id, project_id, valid_from),
  constraint fee_terms_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

create table ujira.fee_reconciliations (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null,
  attempt_id uuid not null,
  revision bigint not null
    constraint fee_reconciliations_revision_range check (revision between 1 and 1000000),
  chain text not null,
  asset text not null,
  scale ujira.scale not null,
  expected_fee_amount ujira.amount not null
    constraint fee_reconciliations_expected_not_negative check (expected_fee_amount >= 0),
  on_chain_fee_amount ujira.amount not null
    constraint fee_reconciliations_on_chain_not_negative check (on_chain_fee_amount >= 0),
  received_fee_amount ujira.amount not null
    constraint fee_reconciliations_received_not_negative check (received_fee_amount >= 0),
  shortfall_amount ujira.amount not null,
  outcome text not null
    constraint fee_reconciliations_outcome check (outcome in ('matched', 'underpaid', 'mismatch')),
  resolution text not null default 'none'
    constraint fee_reconciliations_resolution check (resolution in ('none', 'invoiced', 'waived')),
  invoice_reference text
    constraint fee_reconciliations_invoice_length check (char_length(invoice_reference) between 1 and 128),
  created_at timestamptz not null default now(),
  constraint fee_reconciliations_shortfall_is_missing
    check (shortfall_amount = greatest(expected_fee_amount - received_fee_amount, 0)),
  constraint fee_reconciliations_outcome_follows check (
    outcome = case
      when expected_fee_amount = on_chain_fee_amount
        and on_chain_fee_amount = received_fee_amount then 'matched'
      when received_fee_amount < expected_fee_amount then 'underpaid'
      else 'mismatch'
    end
  ),
  constraint fee_reconciliations_invoice_when_invoiced
    check ((resolution = 'invoiced') = (invoice_reference is not null)),
  constraint fee_reconciliations_matched_needs_nothing
    check (outcome <> 'matched' or resolution = 'none'),
  constraint fee_reconciliations_per_revision unique (principal_id, project_id, attempt_id, revision),
  foreign key (principal_id, project_id, payout_id, attempt_id, chain, asset, scale)
    references ujira.payout_attempts (principal_id, project_id, payout_id, id, chain, asset, scale)
);

create index fee_reconciliations_by_payout
  on ujira.fee_reconciliations (principal_id, project_id, payout_id);
create index fee_reconciliations_by_attempt_unit
  on ujira.fee_reconciliations (principal_id, project_id, payout_id, attempt_id, chain, asset, scale);

create table ujira.leg_refunds (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  payout_leg_id uuid not null,
  -- Written by leg_refunds_stamp from the leg, whatever a caller passes.
  payout_id uuid not null,
  attempt_id uuid not null,
  chain text not null,
  asset text not null,
  scale ujira.scale not null,
  amount ujira.amount not null
    constraint leg_refunds_amount_positive check (amount > 0),
  -- The principal's own address, so a chain address and not personal data.
  refund_to_address text not null
    constraint leg_refunds_address_length check (char_length(refund_to_address) between 1 and 128),
  tx_hash ujira.hash32 not null,
  event_index bigint not null
    constraint leg_refunds_index_positive check (event_index >= 0),
  created_at timestamptz not null default now(),
  -- Across tenants, because one event on a chain can only ever be one refund.
  constraint leg_refunds_once unique (chain, tx_hash, event_index),
  constraint leg_refunds_tenant_key unique (principal_id, project_id, id),
  -- Carries the attempt and the unit, so a fee refund cannot name another attempt's.
  constraint leg_refunds_fee_key
    unique (principal_id, project_id, id, payout_id, attempt_id, chain, asset, scale),
  foreign key (principal_id, project_id, payout_leg_id)
    references ujira.payout_legs (principal_id, project_id, id),
  foreign key (principal_id, project_id, payout_id, attempt_id, chain, asset, scale)
    references ujira.payout_attempts (principal_id, project_id, payout_id, id, chain, asset, scale)
);

create index leg_refunds_by_leg on ujira.leg_refunds (principal_id, project_id, payout_leg_id);
create index leg_refunds_by_attempt
  on ujira.leg_refunds (principal_id, project_id, payout_id, attempt_id, chain, asset, scale);

create table ujira.fee_refunds (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  leg_refund_id uuid not null,
  payout_id uuid not null,
  attempt_id uuid not null,
  chain text not null,
  asset text not null,
  scale ujira.scale not null,
  amount ujira.amount not null
    constraint fee_refunds_amount_not_negative check (amount >= 0),
  -- Null only when nothing is owed, where no money moves. Otherwise the fee address.
  from_address text
    constraint fee_refunds_from_length check (char_length(from_address) between 1 and 128),
  to_address text not null
    constraint fee_refunds_to_length check (char_length(to_address) between 1 and 128),
  status text not null default 'owed'
    constraint fee_refunds_status check (
      status in ('owed', 'awaiting_signatures', 'submitted', 'settled', 'failed', 'not_owed')
    ),
  idempotency_key ujira.hash32 not null,
  due_at timestamptz not null,
  tx_hash ujira.hash32,
  -- A short code, so it cannot carry free text about anyone.
  failure_reason text
    constraint fee_refunds_failure_format check (failure_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fee_refunds_key_is_derived check (
    idempotency_key = sha256(convert_to('ujira/fee-refund/v1' || leg_refund_id::text, 'UTF8'))
  ),
  -- Nothing leads to not_owed: a row starts that way or never. So a fee owed cannot be
  -- forgiven by moving its status, and not_owed only ever means nothing to send.
  constraint fee_refunds_not_owed_is_nothing check ((status = 'not_owed') = (amount = 0)),
  constraint fee_refunds_has_a_source check (status = 'not_owed' or from_address is not null),
  constraint fee_refunds_submitted_has_hash
    check (status not in ('submitted', 'settled') or tx_hash is not null),
  constraint fee_refunds_one_per_leg_refund unique (principal_id, project_id, leg_refund_id),
  constraint fee_refunds_once unique (principal_id, project_id, idempotency_key),
  foreign key (principal_id, project_id, leg_refund_id, payout_id, attempt_id, chain, asset, scale)
    references ujira.leg_refunds (principal_id, project_id, id, payout_id, attempt_id, chain, asset, scale)
);

create index fee_refunds_by_attempt on ujira.fee_refunds (principal_id, project_id, attempt_id);
-- The overdue job reads across tenants in this order.
create index fee_refunds_open_by_due on ujira.fee_refunds (due_at, id)
  where status in ('owed', 'awaiting_signatures', 'failed');

create function ujira.fee_reconciliation_needs_execution() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if not exists (
    select 1
      from ujira.payout_attempts as a
     where a.principal_id = new.principal_id
       and a.project_id = new.project_id
       and a.id = new.attempt_id
       and a.status in ('settled', 'final')
  ) then
    raise exception using
      errcode = 'UJ019',
      message = 'a fee can only be reconciled on an executed attempt';
  end if;
  return new;
end
$fn$;

create function ujira.leg_refund_stamp() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  select l.payout_id, l.attempt_id, l.chain, l.asset, l.scale
    into new.payout_id, new.attempt_id, new.chain, new.asset, new.scale
    from ujira.payout_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.id = new.payout_leg_id;
  return new;
end
$fn$;

-- Deferred triggers see only what is committed and their own writes, so two refunds
-- that each fit could both pass. The lock makes the second wait for the first to commit,
-- and each statement here then reads afresh, so the second sees the first. A lock on a
-- hash of the id rather than on the row, because taking a row lock needs a write right
-- on a table these writers have no business changing. A collision only makes two
-- unrelated refunds wait.
create function ujira.leg_refunds_within_leg() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
declare
  paid numeric;
  refunded numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('ujira/leg-refund/' || new.payout_leg_id::text, 0));
  select l.amount into paid
    from ujira.payout_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.id = new.payout_leg_id;
  select coalesce(sum(r.amount), 0) into refunded
    from ujira.leg_refunds as r
   where r.principal_id = new.principal_id
     and r.project_id = new.project_id
     and r.payout_leg_id = new.payout_leg_id;
  if refunded > paid then
    raise exception using
      errcode = 'UJ008',
      message = format('refunds of %s on a leg that paid %s', refunded, paid);
  end if;
  return null;
end
$fn$;

-- As above. planFeeRefund takes this same lock before it works out a share, so racing
-- plans get a smaller share rather than being refused here.
create function ujira.fee_refunds_within_fee() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
declare
  fee numeric;
  refunded numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('ujira/fee-refund/' || new.attempt_id::text, 0));
  select a.fee_amount into fee
    from ujira.payout_attempts as a
   where a.principal_id = new.principal_id
     and a.project_id = new.project_id
     and a.id = new.attempt_id;
  select coalesce(sum(r.amount), 0) into refunded
    from ujira.fee_refunds as r
   where r.principal_id = new.principal_id
     and r.project_id = new.project_id
     and r.attempt_id = new.attempt_id;
  if refunded > fee then
    raise exception using
      errcode = 'UJ009',
      message = format('fee refunds of %s on an attempt that charged %s', refunded, fee);
  end if;
  return null;
end
$fn$;

-- The audited path for terms. The two inserts are one function so neither can happen
-- without the other, and the app has no insert right on the table to go around it.
create function ujira.record_fee_terms(
  p_rate_bps bigint,
  p_basis text,
  p_valid_from timestamptz,
  p_contract_reference text,
  p_actor_kind text,
  p_actor_id uuid
) returns uuid
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  new_id uuid := gen_random_uuid();
begin
  insert into ujira.fee_terms
    (principal_id, project_id, id, rate_bps, basis, valid_from, contract_reference)
  values (
    ujira.current_principal_id(), ujira.current_project_id(), new_id, p_rate_bps, p_basis,
    p_valid_from, p_contract_reference
  );
  -- audit_chain overwrites the sequence and both hashes.
  insert into ujira.audit_log
    (principal_id, project_id, action, actor_kind, actor_id, metadata, seq, prev_hash, row_hash)
  values (
    ujira.current_principal_id(), ujira.current_project_id(), 'fee_terms.recorded', p_actor_kind,
    p_actor_id,
    jsonb_build_object(
      'target_type', 'fee_terms', 'target_id', new_id::text, 'new_value', p_rate_bps::text
    ),
    0, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex')
  );
  return new_id;
end
$fn$;

create trigger fee_terms_append_only before update or delete on ujira.fee_terms
  for each row execute function ujira.forbid_mutation();
create trigger fee_terms_no_truncate before truncate on ujira.fee_terms
  for each statement execute function ujira.forbid_mutation();

create trigger fee_reconciliations_executed_attempt before insert on ujira.fee_reconciliations
  for each row execute function ujira.fee_reconciliation_needs_execution();
create trigger fee_reconciliations_append_only before update or delete on ujira.fee_reconciliations
  for each row execute function ujira.forbid_mutation();
create trigger fee_reconciliations_no_truncate before truncate on ujira.fee_reconciliations
  for each statement execute function ujira.forbid_mutation();

create trigger leg_refunds_stamp before insert on ujira.leg_refunds
  for each row execute function ujira.leg_refund_stamp();
create trigger leg_refunds_append_only before update or delete on ujira.leg_refunds
  for each row execute function ujira.forbid_mutation();
create trigger leg_refunds_no_truncate before truncate on ujira.leg_refunds
  for each statement execute function ujira.forbid_mutation();
create constraint trigger leg_refunds_within_leg after insert on ujira.leg_refunds
  deferrable initially deferred
  for each row execute function ujira.leg_refunds_within_leg();

create trigger fee_refunds_transition before update of status on ujira.fee_refunds
  for each row execute function ujira.check_transition('fee_refund');
create trigger fee_refunds_touch before update on ujira.fee_refunds
  for each row execute function ujira.touch();
create trigger fee_refunds_no_delete before delete on ujira.fee_refunds
  for each row execute function ujira.forbid_mutation();
create trigger fee_refunds_no_truncate before truncate on ujira.fee_refunds
  for each statement execute function ujira.forbid_mutation();
create constraint trigger fee_refunds_within_fee after insert or update of amount
  on ujira.fee_refunds
  deferrable initially deferred
  for each row execute function ujira.fee_refunds_within_fee();

select ujira.apply_tenant_policies('ujira.fee_terms');
select ujira.apply_tenant_policies('ujira.fee_reconciliations');
select ujira.apply_tenant_policies('ujira.leg_refunds');
select ujira.apply_tenant_policies('ujira.fee_refunds');

grant select on ujira.fee_terms to ujira_app, ujira_reader;
grant select, insert on ujira.fee_reconciliations to ujira_app;
grant select on ujira.fee_reconciliations to ujira_reader;
grant select, insert on ujira.leg_refunds to ujira_app;
grant select on ujira.leg_refunds to ujira_reader;
grant select, insert on ujira.fee_refunds to ujira_app;
grant update (status, tx_hash, failure_reason) on ujira.fee_refunds to ujira_app;
grant select on ujira.fee_refunds to ujira_reader;

-- The overdue job reads this table through its own role. That role and its helper
-- arrive with the job queue, whose migration picks this table up if it runs after this
-- one. So each table gets its policy once whichever way round they land.
do $scheduler$
begin
  if to_regprocedure('ujira.apply_scheduler_read(regclass, text[])') is not null then
    perform ujira.apply_scheduler_read(
      'ujira.fee_refunds',
      array['principal_id', 'project_id', 'id', 'due_at', 'status']
    );
  end if;
end
$scheduler$;

create policy fee_terms_record on ujira.fee_terms for insert to ujira_fn_fees
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy fee_terms_audit on ujira.audit_log for insert to ujira_fn_fees
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());

grant usage on schema ujira to ujira_fn_fees;
grant insert on ujira.fee_terms, ujira.audit_log to ujira_fn_fees;
grant execute on function
  ujira.current_principal_id(), ujira.current_project_id(), ujira.project_scope_all()
  to ujira_fn_fees;
grant execute on function ujira.record_fee_terms(bigint, text, timestamptz, text, text, uuid) to ujira_app;

-- Handing a function to another role needs that role to hold CREATE on the schema, so
-- it is granted for the handover only.
grant create on schema ujira to ujira_fn_fees;
alter function ujira.record_fee_terms(bigint, text, timestamptz, text, text, uuid) owner to ujira_fn_fees;
revoke create on schema ujira from ujira_fn_fees;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop policy fee_terms_audit on ujira.audit_log;
revoke insert on ujira.audit_log from ujira_fn_fees;
drop function ujira.record_fee_terms(bigint, text, timestamptz, text, text, uuid);
revoke execute on function
  ujira.current_principal_id(), ujira.current_project_id(), ujira.project_scope_all()
  from ujira_fn_fees;
drop table ujira.fee_refunds;
drop table ujira.leg_refunds;
drop table ujira.fee_reconciliations;
drop table ujira.fee_terms;
revoke usage on schema ujira from ujira_fn_fees;
drop function ujira.fee_refunds_within_fee();
drop function ujira.leg_refunds_within_leg();
drop function ujira.leg_refund_stamp();
drop function ujira.fee_reconciliation_needs_execution();
delete from ujira.status_transitions where machine = 'fee_refund';

reset role;
