-- expand
-- A failed sweep rolls back without using its authorization entry's nonce, so the
-- principal's signed entry stays usable until its own expiry and could carry a
-- second transfer. The worker waits that out before asking for a new signature.
-- Until now it had to carry the expiry in its job payload, and a lost payload could
-- not be told from an entry that never existed. It belongs on the row.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.funding_sweeps
  add column auth_expires_ledger bigint
    constraint funding_sweeps_auth_expires_ledger_positive check (auth_expires_ledger >= 0);

-- As before, with the entry's expiry held to the same rule as the transaction it
-- came with: it arrives on submission and goes only when the sweep tries again.
create or replace function ujira.keep_funding_sweep() returns trigger
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
      or new.sweep_valid_until is distinct from old.sweep_valid_until
      or new.auth_expires_ledger is distinct from old.auth_expires_ledger)
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

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create or replace function ujira.keep_funding_sweep() returns trigger
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

alter table ujira.funding_sweeps drop column auth_expires_ledger;

reset role;
