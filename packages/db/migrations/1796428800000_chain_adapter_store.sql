-- expand
-- bootstrap
-- What the chain adapter keeps. A write ahead record of every transaction before it is
-- broadcast, so a crash after broadcast can always be reconciled. Fencing on executor
-- leases, so two jobs never share a sequence. One record of each off chain delivery
-- step, sponsorship reservation and signing request.
--
-- These tables name no chain beyond the network identifier, and delivery records hold
-- nothing specific to one kind of rail.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is never
-- dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_fn_chain') then
    create role ujira_fn_chain nologin noinherit nobypassrls;
  end if;
  alter role ujira_fn_chain nobypassrls;
end
$roles$;

grant ujira_fn_chain to ujira_owner;

set local role ujira_owner;

insert into ujira.status_transitions (machine, from_status, to_status) values
  ('chain_submission', 'built', 'broadcast'),
  ('chain_submission', 'broadcast', 'landed'),
  ('chain_submission', 'broadcast', 'failed'),
  ('chain_submission', 'broadcast', 'unknown'),
  ('chain_submission', 'broadcast', 'expired'),
  ('chain_submission', 'broadcast', 'replaced'),
  ('chain_submission', 'unknown', 'landed'),
  ('chain_submission', 'unknown', 'failed'),
  ('chain_submission', 'unknown', 'expired'),
  ('sponsorship', 'reserved', 'settled'),
  ('sponsorship', 'reserved', 'released');

-- A mutable table's other columns are its record, so they are refused for everyone, and
-- not only for the roles without a column grant. The arguments name what may change.
create function ujira.only_columns_change() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if (to_jsonb(new) - tg_argv) is distinct from (to_jsonb(old) - tg_argv) then
    raise exception using
      errcode = 'UJ002',
      message = format('%s allows changes to %s only', tg_table_name, array_to_string(tg_argv, ', '));
  end if;
  return new;
end
$fn$;

-- check_transition reads a status column. These tables keep the adapter's own word,
-- state, so that the store and the port read the same.
create function ujira.check_state_transition() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if new.state is distinct from old.state and not exists (
    select 1
      from ujira.status_transitions as t
     where t.machine = tg_argv[0]
       and t.from_status = old.state
       and t.to_status = new.state
  ) then
    raise exception using
      errcode = 'UJ004',
      message = format('%s cannot move from %s to %s', tg_argv[0], old.state, new.state);
  end if;
  return new;
end
$fn$;

create table ujira.chain_submissions (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  network ujira.network_id not null,
  tx_hash text not null
    constraint chain_submissions_hash_format check (tx_hash ~ '^[0-9a-f]{64}$'),
  op text not null
    constraint chain_submissions_op check (op in (
      'request', 'request_batch', 'approve', 'reject', 'cancel', 'cancel_batch', 'execute',
      'execute_batch', 'pause', 'resume', 'revoke', 'withdraw', 'sweep', 'recover_token',
      'update_limits', 'add_role', 'remove_role', 'set_approvals_required',
      'set_recovery_threshold', 'allow_recipients', 'disallow_recipients',
      'set_attestation_policy', 'propose_principal', 'accept_principal',
      'cancel_principal_proposal', 'lower_fee_cap', 'recovery_revoke', 'recovery_rotate_agent',
      'fund', 'create_funding_account', 'funding_sweep', 'trustline', 'ttl_extend', 'restore'
    )),
  -- The mandate as the chain writes it. Not a key to mandate_instances, because this is
  -- recorded before anything has landed, and some steps touch no mandate at all.
  mandate text
    constraint chain_submissions_mandate_length check (char_length(mandate) between 1 and 128),
  payout_id text
    constraint chain_submissions_payout_format check (payout_id ~ '^0x[0-9a-f]{64}$'),
  attempt bigint
    constraint chain_submissions_attempt_range check (attempt between 1 and 1000000),
  signer_address text not null
    constraint chain_submissions_signer_length check (char_length(signer_address) between 1 and 128),
  sequence_or_nonce ujira.u64 not null,
  max_time timestamptz,
  state text not null default 'built'
    constraint chain_submissions_state check (
      state in ('built', 'broadcast', 'unknown', 'landed', 'failed', 'expired', 'replaced')
    ),
  landed_at_height bigint
    constraint chain_submissions_height_positive check (landed_at_height >= 0),
  error_code text
    constraint chain_submissions_error_length check (char_length(error_code) between 1 and 64),
  spec_code bigint,
  replaces_tx_hash text
    constraint chain_submissions_replaces_format check (replaces_tx_hash ~ '^[0-9a-f]{64}$'),
  submitted_at_ledger bigint
    constraint chain_submissions_ledger_positive check (submitted_at_ledger >= 0),
  reservation_id text
    constraint chain_submissions_reservation_length check (char_length(reservation_id) between 1 and 128),
  correlation_id text not null
    constraint chain_submissions_correlation_length check (char_length(correlation_id) between 1 and 128),
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  -- Across tenants, because one hash on a network is one transaction whoever records it.
  constraint chain_submissions_once unique (network, tx_hash),
  constraint chain_submissions_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

-- At most one live submission for a payout step, and one for an administrative step,
-- however many jobs race. A second broadcast of the same step could pay twice.
create unique index chain_submissions_one_live_payout
  on ujira.chain_submissions (network, mandate, payout_id, op)
  where state in ('built', 'broadcast', 'unknown') and payout_id is not null and mandate is not null;
create unique index chain_submissions_one_live_admin
  on ujira.chain_submissions (network, mandate, op)
  where state in ('built', 'broadcast', 'unknown') and payout_id is null and mandate is not null;
-- The reconciliation sweep reads across tenants, oldest first.
create index chain_submissions_unresolved on ujira.chain_submissions (network, created_at, id)
  where state in ('built', 'broadcast', 'unknown');
create index chain_submissions_by_payout
  on ujira.chain_submissions (principal_id, project_id, network, mandate, payout_id);

create table ujira.chain_submission_events (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  -- The order of the moves. Several moves in one transaction share one now(), so the time
  -- cannot say which came first.
  seq bigint generated always as identity,
  submission_id uuid not null,
  from_state text,
  to_state text not null,
  occurred_at timestamptz not null default now(),
  foreign key (principal_id, project_id, submission_id)
    references ujira.chain_submissions (principal_id, project_id, id)
);

create index chain_submission_events_by_submission
  on ujira.chain_submission_events (principal_id, project_id, submission_id);

-- A trigger rather than something a writer remembers, so a state cannot move without
-- its record. Its own role, because nobody else may write this table.
create function ujira.chain_submission_event() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
begin
  if tg_op = 'INSERT' or new.state is distinct from old.state then
    insert into ujira.chain_submission_events
      (principal_id, project_id, submission_id, from_state, to_state)
    values (
      new.principal_id, new.project_id, new.id,
      case when tg_op = 'INSERT' then null else old.state end,
      new.state
    );
  end if;
  return null;
end
$fn$;

-- Recorded before broadcast, so anything else would be a record of something that was
-- never written ahead.
create function ujira.chain_submission_starts_built() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if new.state <> 'built' then
    raise exception using
      errcode = 'UJ004',
      message = format('a chain submission starts built, not %s', new.state);
  end if;
  return new;
end
$fn$;

create trigger chain_submissions_starts_built before insert on ujira.chain_submissions
  for each row execute function ujira.chain_submission_starts_built();
create trigger chain_submissions_transition before update of state on ujira.chain_submissions
  for each row execute function ujira.check_state_transition('chain_submission');
create trigger chain_submissions_touch before update on ujira.chain_submissions
  for each row execute function ujira.touch();
create trigger chain_submissions_state_columns before update on ujira.chain_submissions
  for each row execute function ujira.only_columns_change(
    'state', 'landed_at_height', 'error_code', 'spec_code', 'updated_at'
  );
create trigger chain_submissions_record_event after insert or update on ujira.chain_submissions
  for each row execute function ujira.chain_submission_event();
create trigger chain_submissions_no_delete before delete on ujira.chain_submissions
  for each row execute function ujira.forbid_mutation();
create trigger chain_submissions_no_truncate before truncate on ujira.chain_submissions
  for each statement execute function ujira.forbid_mutation();
create trigger chain_submission_events_append_only before update or delete
  on ujira.chain_submission_events
  for each row execute function ujira.forbid_mutation();
create trigger chain_submission_events_no_truncate before truncate on ujira.chain_submission_events
  for each statement execute function ujira.forbid_mutation();

-- Executor accounts are UJIRA's own and hold no tenant data. A fresh lease_id on every
-- lease is the fence: a job that outlived its lease cannot write a stale sequence over
-- the job that holds the account now. The holder takes the same value, so the older
-- functions and their check keep working during a deploy.
alter table ops.executor_accounts
  add column lease_id uuid,
  add column key_id text,
  add column active boolean not null default true;

create function ops.lease_executor_fenced(target_network text, lease_seconds integer)
  returns table (
    account_ref text,
    key_id text,
    next_sequence bigint,
    lease_id uuid,
    lease_expires_at timestamptz
  )
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  fresh uuid := gen_random_uuid();
begin
  if lease_seconds is null or lease_seconds < 1 or lease_seconds > 3600 then
    raise exception using
      errcode = '22023',
      message = 'a lease lasts from 1 to 3600 seconds';
  end if;
  return query
    update ops.executor_accounts as e
       set lease_id = fresh,
           lease_holder = fresh::text,
           lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds)
     where (e.network, e.account_ref) = (
       select c.network, c.account_ref
         from ops.executor_accounts as c
        where c.network = target_network
          and c.active
          and c.key_id is not null
          and (c.lease_expires_at is null or c.lease_expires_at <= clock_timestamp())
        order by c.account_ref
        limit 1
        for update skip locked
     )
    returning e.account_ref, e.key_id, e.next_sequence, e.lease_id, e.lease_expires_at;
end
$fn$;

-- True when this lease was still current. A lease that was taken over changes nothing,
-- and neither does a sequence that would move backwards.
create function ops.release_executor_fenced(
  target_network text,
  account text,
  current_lease uuid,
  sequence_reached bigint
) returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  released integer;
begin
  update ops.executor_accounts as e
     set lease_id = null,
         lease_holder = null,
         lease_expires_at = null,
         next_sequence = sequence_reached
   where e.network = target_network
     and e.account_ref = account
     and e.lease_id = current_lease
     and e.lease_holder = current_lease::text
     and e.next_sequence <= sequence_reached;
  get diagnostics released = row_count;
  return released > 0;
end
$fn$;

grant execute on function
  ops.lease_executor_fenced(text, integer),
  ops.release_executor_fenced(text, text, uuid, bigint)
  to ujira_app;

grant create on schema ops to ujira_ops;
alter function ops.lease_executor_fenced(text, integer) owner to ujira_ops;
alter function ops.release_executor_fenced(text, text, uuid, bigint) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

create table ujira.leg_deliveries (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  leg_key text not null
    constraint leg_deliveries_key_format check (leg_key ~ '^0x[0-9a-f]{66}$'),
  network ujira.network_id not null,
  rail text not null
    constraint leg_deliveries_rail_format check (rail ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  provider text not null
    constraint leg_deliveries_provider_length check (char_length(provider) between 1 and 128),
  provider_ref text
    constraint leg_deliveries_ref_length check (char_length(provider_ref) between 1 and 256),
  destination_address text not null
    constraint leg_deliveries_address_length check (char_length(destination_address) between 1 and 128),
  destination_tag ujira.u64,
  quote_id text
    constraint leg_deliveries_quote_length check (char_length(quote_id) between 1 and 128),
  state text not null
    constraint leg_deliveries_state check (state in (
      'not_applicable', 'awaiting_settlement', 'in_transit', 'action_required', 'delivered',
      'failed', 'refunded', 'expired'
    )),
  -- Scrubbed by the adapter and kept for support, then cleared after 90 days.
  raw_status text
    constraint leg_deliveries_raw_status_length check (char_length(raw_status) between 1 and 1024),
  raw_status_at timestamptz,
  live boolean not null default true,
  expires_at timestamptz,
  updated_at timestamptz not null,
  constraint leg_deliveries_raw_status_dated check ((raw_status is null) or (raw_status_at is not null)),
  -- Across tenants: a leg key hashes its tenant in, so a clash is a bug or an attack, and
  -- must not become a second row.
  constraint leg_deliveries_once unique nulls not distinct (leg_key, provider, provider_ref),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

create unique index leg_deliveries_one_live on ujira.leg_deliveries (leg_key, provider)
  where live;
create index leg_deliveries_by_leg on ujira.leg_deliveries (principal_id, project_id, leg_key);
create index leg_deliveries_raw_status_due on ujira.leg_deliveries (raw_status_at)
  where raw_status is not null;

create trigger leg_deliveries_state_columns before update on ujira.leg_deliveries
  for each row execute function ujira.only_columns_change(
    'state', 'raw_status', 'raw_status_at', 'live', 'expires_at', 'quote_id', 'updated_at'
  );
create trigger leg_deliveries_no_delete before delete on ujira.leg_deliveries
  for each row execute function ujira.forbid_mutation();
create trigger leg_deliveries_no_truncate before truncate on ujira.leg_deliveries
  for each statement execute function ujira.forbid_mutation();

create table ujira.sponsorship_ledger (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  reservation_id text not null
    constraint sponsorship_ledger_reservation_length check (char_length(reservation_id) between 1 and 128),
  network ujira.network_id not null,
  intent text not null
    constraint sponsorship_ledger_intent check (intent in (
      'fund', 'create_funding_account', 'create_mandate', 'pause', 'resume', 'revoke', 'approve',
      'reject', 'cancel', 'withdraw', 'admin', 'trustline', 'recipient_activation', 'executor'
    )),
  -- In the network's native gas units, at an explicit scale.
  native_asset text not null
    constraint sponsorship_ledger_asset_length check (char_length(native_asset) between 1 and 16),
  scale ujira.scale not null,
  max_fee_native ujira.amount not null
    constraint sponsorship_ledger_max_fee_positive check (max_fee_native > 0),
  actual_fee_native ujira.amount
    constraint sponsorship_ledger_actual_not_negative check (actual_fee_native >= 0),
  state text not null default 'reserved'
    constraint sponsorship_ledger_state check (state in ('reserved', 'settled', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sponsorship_ledger_settled_has_fee
    check ((state = 'settled') = (actual_fee_native is not null)),
  constraint sponsorship_ledger_once unique (principal_id, project_id, reservation_id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

create trigger sponsorship_ledger_transition before update of state on ujira.sponsorship_ledger
  for each row execute function ujira.check_state_transition('sponsorship');
create trigger sponsorship_ledger_touch before update on ujira.sponsorship_ledger
  for each row execute function ujira.touch();
create trigger sponsorship_ledger_state_columns before update on ujira.sponsorship_ledger
  for each row execute function ujira.only_columns_change('state', 'actual_fee_native', 'updated_at');
create trigger sponsorship_ledger_no_delete before delete on ujira.sponsorship_ledger
  for each row execute function ujira.forbid_mutation();
create trigger sponsorship_ledger_no_truncate before truncate on ujira.sponsorship_ledger
  for each statement execute function ujira.forbid_mutation();

create table ujira.signing_requests (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  request_id text not null
    constraint signing_requests_request_length check (char_length(request_id) between 1 and 128),
  network ujira.network_id not null,
  signer text not null
    constraint signing_requests_signer_length check (char_length(signer) between 1 and 128),
  -- What the wallet was asked to sign, reloaded on submission and deleted 7 days after it
  -- can no longer be signed.
  request jsonb not null
    constraint signing_requests_request_object check (jsonb_typeof(request) = 'object'),
  valid_until timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint signing_requests_once unique (principal_id, project_id, request_id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

create index signing_requests_due on ujira.signing_requests (valid_until);

-- Set once, so one signed request can never be submitted twice.
create function ujira.signing_request_consumed_once() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception using
      errcode = 'UJ002',
      message = 'a signing request is consumed once';
  end if;
  return new;
end
$fn$;

create trigger signing_requests_consumed_once before update on ujira.signing_requests
  for each row execute function ujira.signing_request_consumed_once();
create trigger signing_requests_state_columns before update on ujira.signing_requests
  for each row execute function ujira.only_columns_change('consumed_at');

-- The reconciliation sweep reads every tenant on purpose, and each row carries its own
-- tenant for the calls that follow. Oldest first, so nothing is starved.
create function ujira.unresolved_chain_submissions(
  p_network text,
  p_before timestamptz,
  p_limit integer
) returns setof ujira.chain_submissions
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'limit must be from 1 to 1000';
  end if;
  return query
    select s.*
      from ujira.chain_submissions as s
     where s.network = p_network
       and s.state in ('built', 'broadcast', 'unknown')
       and s.created_at <= p_before
     order by s.created_at, s.id
     limit p_limit;
end
$fn$;

-- Bounded, so a long backlog clears in many short runs rather than one long lock. Each
-- returns how many it did, and 0 means there is nothing left to do.
create function ujira.clear_stale_delivery_status(p_limit integer) returns bigint
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  cleared bigint;
begin
  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'limit must be from 1 to 10000';
  end if;
  update ujira.leg_deliveries as d
     set raw_status = null, raw_status_at = null
   where d.id in (
     select c.id
       from ujira.leg_deliveries as c
      where c.raw_status is not null
        and c.raw_status_at < clock_timestamp() - interval '90 days'
      order by c.raw_status_at
      limit p_limit
   );
  get diagnostics cleared = row_count;
  return cleared;
end
$fn$;

create function ujira.delete_stale_signing_requests(p_limit integer) returns bigint
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  deleted bigint;
begin
  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'limit must be from 1 to 10000';
  end if;
  delete from ujira.signing_requests as r
   where r.id in (
     select c.id
       from ujira.signing_requests as c
      where c.valid_until < clock_timestamp() - interval '7 days'
      order by c.valid_until
      limit p_limit
   );
  get diagnostics deleted = row_count;
  return deleted;
end
$fn$;

select ujira.apply_tenant_policies('ujira.chain_submissions');
select ujira.apply_tenant_policies('ujira.chain_submission_events');
select ujira.apply_tenant_policies('ujira.leg_deliveries');
select ujira.apply_tenant_policies('ujira.sponsorship_ledger');
select ujira.apply_tenant_policies('ujira.signing_requests');

create policy chain_events_write on ujira.chain_submission_events for insert to ujira_fn_chain
  with check (true);
create policy chain_unresolved_read on ujira.chain_submissions for select to ujira_fn_chain
  using (true);
create policy chain_retention_all on ujira.leg_deliveries for all to ujira_fn_chain
  using (true) with check (true);
create policy chain_retention_all on ujira.signing_requests for all to ujira_fn_chain
  using (true) with check (true);

grant select, insert on ujira.chain_submissions to ujira_app;
grant update (state, landed_at_height, error_code, spec_code) on ujira.chain_submissions to ujira_app;
grant select on ujira.chain_submissions to ujira_reader;
grant select on ujira.chain_submission_events to ujira_app, ujira_reader;
grant select, insert on ujira.leg_deliveries to ujira_app;
grant update (state, raw_status, raw_status_at, live, expires_at, quote_id, updated_at)
  on ujira.leg_deliveries to ujira_app;
grant select on ujira.leg_deliveries to ujira_reader;
grant select, insert on ujira.sponsorship_ledger to ujira_app;
grant update (state, actual_fee_native) on ujira.sponsorship_ledger to ujira_app;
grant select on ujira.sponsorship_ledger to ujira_reader;
grant select, insert on ujira.signing_requests to ujira_app;
grant update (consumed_at) on ujira.signing_requests to ujira_app;

grant usage on schema ujira to ujira_fn_chain;
grant insert on ujira.chain_submission_events to ujira_fn_chain;
grant select on ujira.chain_submissions to ujira_fn_chain;
grant select, update (raw_status, raw_status_at) on ujira.leg_deliveries to ujira_fn_chain;
grant select, delete on ujira.signing_requests to ujira_fn_chain;

grant execute on function ujira.unresolved_chain_submissions(text, timestamptz, integer) to ujira_app;
grant execute on function
  ujira.clear_stale_delivery_status(integer),
  ujira.delete_stale_signing_requests(integer)
  to ujira_retention;

grant create on schema ujira to ujira_fn_chain;
alter function ujira.chain_submission_event() owner to ujira_fn_chain;
alter function ujira.unresolved_chain_submissions(text, timestamptz, integer) owner to ujira_fn_chain;
alter function ujira.clear_stale_delivery_status(integer) owner to ujira_fn_chain;
alter function ujira.delete_stale_signing_requests(integer) owner to ujira_fn_chain;
revoke create on schema ujira from ujira_fn_chain;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.delete_stale_signing_requests(integer);
drop function ujira.clear_stale_delivery_status(integer);
drop function ujira.unresolved_chain_submissions(text, timestamptz, integer);
drop table ujira.signing_requests;
drop function ujira.signing_request_consumed_once();
drop table ujira.sponsorship_ledger;
drop table ujira.leg_deliveries;
drop function ops.release_executor_fenced(text, text, uuid, bigint);
drop function ops.lease_executor_fenced(text, integer);
alter table ops.executor_accounts
  drop column active,
  drop column key_id,
  drop column lease_id;
drop table ujira.chain_submission_events;
drop table ujira.chain_submissions;
drop function ujira.chain_submission_starts_built();
drop function ujira.chain_submission_event();
drop function ujira.check_state_transition();
drop function ujira.only_columns_change();
revoke usage on schema ujira from ujira_fn_chain;
delete from ujira.status_transitions where machine in ('chain_submission', 'sponsorship');

reset role;
