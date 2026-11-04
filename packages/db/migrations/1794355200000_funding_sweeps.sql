-- expand
-- A principal-owned funding account is a funding source, and every deposit to
-- it is swept into the mandate by a transfer the principal signs. The chain's
-- id for the deposit operation is the sweep's permanent idempotency key, so a
-- deposit is swept at most once, however often the work is retried.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.funding_sources
  add column config jsonb not null default '{}';

-- Not valid here and validated by the next migration: every migration in a run
-- shares one transaction, and scanning the table inside it would hold this
-- table's lock until the whole run commits. New rows are checked from now on.
-- The drop is safe because the next statement puts back a wider check, in the
-- same transaction, so no writer sees the table unguarded.
-- squawk-ignore ban-drop-constraint
alter table ujira.funding_sources drop constraint funding_sources_kind;
alter table ujira.funding_sources
  add constraint funding_sources_kind
    check (kind in ('stablecoin_deposit', 'stellar_funding_account')) not valid;

-- The transaction that sponsored the account's reserves, as lower case hex. It
-- has to be text inside JSON, and nothing else may sit beside it, so this column
-- cannot quietly become somewhere to keep other data. coalesce, because a check
-- that evaluates to null passes, and a missing key evaluates to null.
alter table ujira.funding_sources
  add constraint funding_sources_config_shape check (
    case
      when kind <> 'stellar_funding_account' then config = '{}'::jsonb
      when jsonb_typeof(config) <> 'object' then false
      else coalesce(
        config - 'sponsored_reserves' - 'sponsor_tx_hash' = '{}'::jsonb
          and config -> 'sponsored_reserves' = 'true'::jsonb
          and jsonb_typeof(config -> 'sponsor_tx_hash') = 'string'
          and config ->> 'sponsor_tx_hash' ~ '^[0-9a-f]{64}$',
        false
      )
    end
  ) not valid;

-- Failed means the network can no longer apply the transaction. Only then may
-- the sweep go round again, and on the same row, because the key below allows no
-- second one. A sweep that was never sent has nothing to fail: it stays awaiting
-- its signature or is cancelled, so every failed row names what was sent.
-- Cancelled is the principal's decision and final; the money stays in the
-- account they own.
insert into ujira.status_transitions (machine, from_status, to_status) values
  ('funding_sweep', 'awaiting_signature', 'submitted'),
  ('funding_sweep', 'awaiting_signature', 'cancelled'),
  ('funding_sweep', 'submitted', 'settled'),
  ('funding_sweep', 'submitted', 'failed'),
  ('funding_sweep', 'failed', 'awaiting_signature');

create table ujira.funding_sweeps (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  funding_source_id uuid not null,
  mandate_instance_id uuid not null,
  chain text not null,
  asset text not null,
  scale ujira.scale not null,
  deposit_operation_id text not null
    constraint funding_sweeps_operation_length
      check (char_length(deposit_operation_id) between 1 and 128),
  amount ujira.amount not null
    constraint funding_sweeps_amount_positive check (amount > 0),
  status text not null default 'awaiting_signature'
    constraint funding_sweeps_status check (
      status in ('awaiting_signature', 'submitted', 'settled', 'failed', 'cancelled')
    ),
  sweep_tx_hash ujira.hash32,
  -- The last moment the sent transaction can be applied, from its time bounds.
  sweep_valid_until timestamptz,
  -- The ledger that applied the transaction and recorded its failure.
  failed_ledger bigint
    constraint funding_sweeps_failed_ledger_positive check (failed_ledger >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Global, not per tenant: an operation happened once on its chain, so no
  -- tenant may sweep what another already has.
  constraint funding_sweeps_once unique (chain, deposit_operation_id),
  constraint funding_sweeps_tenant_key unique (principal_id, project_id, id),
  constraint funding_sweeps_attempt_by_status check (
    case
      when status in ('submitted', 'settled') then
        sweep_tx_hash is not null and sweep_valid_until is not null and failed_ledger is null
      when status = 'failed' then
        sweep_tx_hash is not null and sweep_valid_until is not null
      else
        sweep_tx_hash is null and sweep_valid_until is null and failed_ledger is null
    end
  ),
  foreign key (principal_id, project_id, funding_source_id)
    references ujira.funding_sources (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id, chain, asset, scale)
    references ujira.mandate_instances (principal_id, project_id, id, chain, asset, scale),
  foreign key (asset, chain, scale)
    references ujira.settlement_tokens (asset, chain, token_scale)
);

create index funding_sweeps_by_instance
  on ujira.funding_sweeps (principal_id, project_id, mandate_instance_id, created_at);

-- A foreign key cannot say what kind of source this is, and a source never
-- changes its instance or kind, so this check cannot go stale. After the row,
-- so a row the constraints refuse reports that rather than this.
create function ujira.check_new_funding_sweep() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if new.status <> 'awaiting_signature' then
    raise exception using
      errcode = 'UJ004',
      message = format('a funding sweep starts awaiting a signature, not %s', new.status);
  end if;
  if not exists (
    select 1
      from ujira.funding_sources as s
     where s.id = new.funding_source_id
       and s.mandate_instance_id = new.mandate_instance_id
       and s.kind = 'stellar_funding_account'
  ) then
    raise exception using
      errcode = '23503',
      message = 'a funding sweep comes from a funding account on its own mandate instance';
  end if;
  return null;
end
$fn$;

-- What a sweep moves never changes, only how far along it is. Its transaction
-- arrives on submission and stays, so a settled row names what was sent. Going
-- round again after a failure is the one way to give it up.
--
-- A sent transaction that might still land must never be followed by another,
-- so a sweep can fail only with a ledger that recorded the failure, or once the
-- time bounds have passed. The five minutes cover the gap between this clock and
-- the network's, whose ledgers could still accept a transaction this clock calls
-- expired. This holds a worker to saying which it saw; that it really saw it
-- is the worker's duty.
create function ujira.keep_funding_sweep() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if new.principal_id <> old.principal_id or new.project_id <> old.project_id
     or new.funding_source_id <> old.funding_source_id
     or new.mandate_instance_id <> old.mandate_instance_id
     or new.chain <> old.chain or new.asset <> old.asset or new.scale <> old.scale
     or new.deposit_operation_id <> old.deposit_operation_id
     or new.amount <> old.amount then
    raise exception using
      errcode = 'UJ006',
      message = 'a funding sweep keeps its tenant, source, operation and amount';
  end if;
  if (new.sweep_tx_hash is distinct from old.sweep_tx_hash
      or new.sweep_valid_until is distinct from old.sweep_valid_until)
     and not (old.status = 'awaiting_signature' and new.status = 'submitted')
     and not (old.status = 'failed' and new.status = 'awaiting_signature') then
    raise exception using
      errcode = 'UJ006',
      message = 'a funding sweep takes its transaction on submission and drops it only to try again';
  end if;
  if new.failed_ledger is distinct from old.failed_ledger
     and not (old.status = 'submitted' and new.status = 'failed')
     and not (old.status = 'failed' and new.status = 'awaiting_signature') then
    raise exception using
      errcode = 'UJ006',
      message = 'a funding sweep takes its failed ledger only when it fails';
  end if;
  if old.status = 'awaiting_signature' and new.status = 'submitted'
     and new.sweep_valid_until <= now() then
    raise exception using
      errcode = 'UJ004',
      message = 'a funding sweep cannot be submitted with time bounds already past';
  end if;
  if old.status = 'submitted' and new.status = 'failed' and new.failed_ledger is null
     and now() < old.sweep_valid_until + interval '5 minutes' then
    raise exception using
      errcode = 'UJ004',
      message = 'a funding sweep cannot fail while its transaction might still land';
  end if;
  return new;
end
$fn$;

create trigger funding_sweeps_check_new after insert on ujira.funding_sweeps
  for each row execute function ujira.check_new_funding_sweep();
create trigger funding_sweeps_keep before update on ujira.funding_sweeps
  for each row execute function ujira.keep_funding_sweep();
create trigger funding_sweeps_transition before update on ujira.funding_sweeps
  for each row execute function ujira.check_transition('funding_sweep');
create trigger funding_sweeps_touch before update on ujira.funding_sweeps
  for each row execute function ujira.touch();

select ujira.apply_tenant_policies('ujira.funding_sweeps');
grant select, insert, update on ujira.funding_sweeps to ujira_app;
grant select on ujira.funding_sweeps to ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.funding_sweeps;
drop function ujira.keep_funding_sweep();
drop function ujira.check_new_funding_sweep();
delete from ujira.status_transitions where machine = 'funding_sweep';
alter table ujira.funding_sources drop constraint funding_sources_config_shape;
alter table ujira.funding_sources drop constraint funding_sources_kind;
alter table ujira.funding_sources
  add constraint funding_sources_kind check (kind in ('stablecoin_deposit'));
alter table ujira.funding_sources drop column config;

reset role;
