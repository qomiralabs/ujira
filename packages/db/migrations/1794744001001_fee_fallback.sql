-- expand
-- What the zero fee fallback records. No key UJIRA holds may cancel on chain, so a failed
-- attempt is left to lapse and sent again with no fee, and the fee is invoiced instead.
-- The decision and the invoice item are money records, so they are never edited, and a
-- unique constraint on each is what stops a rerun from doing either twice.
--
-- The alarm is about UJIRA's own fee address, which belongs to no tenant, so it lives in
-- ops and a tenant session cannot reach it.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ujira.fee_resend_decisions (
  principal_id uuid not null,
  project_id uuid not null,
  attempt_id uuid not null,
  decided_at timestamptz not null default now(),
  primary key (principal_id, project_id, attempt_id),
  foreign key (principal_id, project_id, attempt_id)
    references ujira.payout_attempts (principal_id, project_id, id)
);

create table ujira.unpaid_fee_items (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null,
  -- The attempt whose fee the chain did not take.
  attempt_id uuid not null,
  chain text not null,
  asset text not null,
  scale ujira.scale not null,
  amount ujira.amount not null
    constraint unpaid_fee_items_amount_positive check (amount > 0),
  created_at timestamptz not null default now(),
  -- A payout owes one fee, however many of its attempts failed on it.
  constraint unpaid_fee_items_per_payout unique (principal_id, project_id, payout_id),
  foreign key (principal_id, project_id, payout_id)
    references ujira.payouts (principal_id, project_id, id),
  foreign key (principal_id, project_id, attempt_id)
    references ujira.payout_attempts (principal_id, project_id, id)
);

create index unpaid_fee_items_by_attempt
  on ujira.unpaid_fee_items (principal_id, project_id, attempt_id);

create trigger fee_resend_decisions_append_only before update or delete
  on ujira.fee_resend_decisions
  for each row execute function ujira.forbid_mutation();
create trigger fee_resend_decisions_no_truncate before truncate on ujira.fee_resend_decisions
  for each statement execute function ujira.forbid_mutation();
create trigger unpaid_fee_items_append_only before update or delete on ujira.unpaid_fee_items
  for each row execute function ujira.forbid_mutation();
create trigger unpaid_fee_items_no_truncate before truncate on ujira.unpaid_fee_items
  for each statement execute function ujira.forbid_mutation();

select ujira.apply_tenant_policies('ujira.fee_resend_decisions');
select ujira.apply_tenant_policies('ujira.unpaid_fee_items');

grant select, insert on ujira.fee_resend_decisions to ujira_app;
grant select, insert on ujira.unpaid_fee_items to ujira_app;
grant select on ujira.fee_resend_decisions, ujira.unpaid_fee_items to ujira_reader;

create table ops.fee_address_alarms (
  network text primary key,
  reason text not null
    constraint fee_address_alarms_reason check (
      reason in (
        'ACCOUNT_NOT_FOUND',
        'DESTINATION_IS_ISSUER',
        'NO_TRUSTLINE',
        'TRUSTLINE_NOT_AUTHORIZED',
        'TRUSTLINE_LIMIT'
      )
    ),
  raised_at timestamptz not null default now()
);

grant select, insert, delete on ops.fee_address_alarms to ujira_ops;

-- True only for the call that raised it. Two callers cannot both see true, because the
-- second one's insert waits for the first and then conflicts.
create function ops.raise_fee_address_alarm(target_network text, alarm_reason text)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  raised integer;
begin
  insert into ops.fee_address_alarms (network, reason)
  values (target_network, alarm_reason)
  on conflict (network) do nothing;
  get diagnostics raised = row_count;
  return raised > 0;
end
$fn$;

create function ops.clear_fee_address_alarm(target_network text)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  cleared integer;
begin
  delete from ops.fee_address_alarms as a where a.network = target_network;
  get diagnostics cleared = row_count;
  return cleared > 0;
end
$fn$;

revoke execute on function
  ops.raise_fee_address_alarm(text, text),
  ops.clear_fee_address_alarm(text)
  from public;

grant execute on function
  ops.raise_fee_address_alarm(text, text),
  ops.clear_fee_address_alarm(text)
  to ujira_indexer;

grant create on schema ops to ujira_ops;
alter function ops.raise_fee_address_alarm(text, text) owner to ujira_ops;
alter function ops.clear_fee_address_alarm(text) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ops.clear_fee_address_alarm(text);
drop function ops.raise_fee_address_alarm(text, text);
drop table ops.fee_address_alarms;
drop table ujira.unpaid_fee_items;
drop table ujira.fee_resend_decisions;

reset role;
