-- expand
-- Payouts, their batches, and the attempts that try them on a network. A payout
-- is the business record an agent creates, and an attempt is one try on one
-- chain. The database allows one live attempt per payout, and a new one only
-- after the last is dead with a proof, so it cannot submit one payout twice
-- across chains.
--
-- status holds the lifecycle, which has two steps the public API folds into
-- other values: received reads as queued, and routed as submitting. public_status
-- is derived, so the two can never disagree.
--
-- Also here, because they reference payouts or decide how one is created: the
-- funding holds, the project's cash-out bearer and its payout minimums.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- recipient: the amount asked for is USDC, and the recipient bears the cash-out
-- cost. principal: the amount asked for is what the recipient must receive.
alter table ujira.projects
  add column cashout_cost_bearer text not null default 'recipient'
    constraint projects_cashout_cost_bearer check (cashout_cost_bearer in ('recipient', 'principal'));

insert into ujira.audit_metadata_keys (key) values
  ('method'),
  ('currency'),
  ('scale');

insert into ujira.status_transitions (machine, from_status, to_status) values
  ('payout', 'received', 'routed'),
  ('payout', 'received', 'blocked'),
  ('payout', 'received', 'cancelled'),
  ('payout', 'received', 'failed'),
  ('payout', 'routed', 'submitting'),
  ('payout', 'routed', 'received'),
  ('payout', 'routed', 'blocked'),
  ('payout', 'routed', 'cancelled'),
  ('payout', 'routed', 'failed'),
  ('payout', 'submitting', 'pending_approval'),
  ('payout', 'submitting', 'approved'),
  ('payout', 'submitting', 'settling'),
  ('payout', 'submitting', 'routed'),
  ('payout', 'submitting', 'blocked'),
  ('payout', 'submitting', 'rejected'),
  ('payout', 'submitting', 'cancelled'),
  ('payout', 'submitting', 'failed'),
  ('payout', 'pending_approval', 'approved'),
  ('payout', 'pending_approval', 'routed'),
  ('payout', 'pending_approval', 'rejected'),
  ('payout', 'pending_approval', 'cancelled'),
  ('payout', 'pending_approval', 'failed'),
  ('payout', 'approved', 'settling'),
  ('payout', 'approved', 'routed'),
  ('payout', 'approved', 'cancelled'),
  ('payout', 'approved', 'failed'),
  ('payout', 'settling', 'delivering'),
  ('payout', 'settling', 'partly_paid'),
  ('payout', 'settling', 'paid'),
  ('payout', 'settling', 'needs_attention'),
  ('payout', 'settling', 'failed'),
  ('payout', 'delivering', 'partly_paid'),
  ('payout', 'delivering', 'paid'),
  ('payout', 'delivering', 'needs_attention'),
  ('payout', 'delivering', 'failed'),
  ('payout', 'partly_paid', 'delivering'),
  ('payout', 'partly_paid', 'paid'),
  ('payout', 'partly_paid', 'needs_attention'),
  ('payout', 'partly_paid', 'failed'),
  ('payout', 'needs_attention', 'delivering'),
  ('payout', 'needs_attention', 'partly_paid'),
  ('payout', 'needs_attention', 'paid'),
  ('payout', 'needs_attention', 'failed'),
  ('payout_attempt', 'created', 'requested'),
  ('payout_attempt', 'created', 'dead'),
  ('payout_attempt', 'requested', 'pending_approval'),
  ('payout_attempt', 'requested', 'approved'),
  ('payout_attempt', 'requested', 'executing'),
  ('payout_attempt', 'requested', 'dead'),
  ('payout_attempt', 'pending_approval', 'approved'),
  ('payout_attempt', 'pending_approval', 'dead'),
  ('payout_attempt', 'approved', 'executing'),
  ('payout_attempt', 'approved', 'dead'),
  ('payout_attempt', 'executing', 'settled'),
  ('payout_attempt', 'executing', 'final'),
  ('payout_attempt', 'executing', 'dead'),
  ('payout_attempt', 'settled', 'final'),
  ('payout_attempt', 'settled', 'dead');

create table ujira.payout_batches (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null
    constraint payout_batches_key_length check (char_length(idempotency_key) between 1 and 255),
  request_hash ujira.hash32 not null,
  created_at timestamptz not null default now(),
  constraint payout_batches_idempotency unique (principal_id, project_id, idempotency_key),
  constraint payout_batches_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

create table ujira.payouts (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  batch_id uuid,
  -- Retries never double pay: a second create with this key finds the first.
  idempotency_key text not null
    constraint payouts_key_length check (char_length(idempotency_key) between 1 and 255),
  -- What the first create asked for, so the same key with a different body is
  -- told apart from a retry.
  request_hash ujira.hash32 not null,
  recipient_id uuid not null,
  mandate_id uuid not null,
  -- The recipient's main method until routing picks the legs.
  method text not null
    constraint payouts_method
      check (method in ('stellar_wallet', 'bank', 'mobile_money', 'cash_pickup')),
  -- Whoever bore the cash-out cost when this was created. The project's setting
  -- can change afterwards, and this payout must not.
  cashout_cost_bearer text not null
    constraint payouts_cashout_cost_bearer check (cashout_cost_bearer in ('recipient', 'principal')),
  -- What the principal asked for: a token amount in recipient mode, and in
  -- principal mode the local amount the recipient must receive.
  requested_amount ujira.amount not null
    constraint payouts_requested_positive check (requested_amount > 0),
  requested_asset text,
  requested_chain text,
  requested_token_scale ujira.scale,
  requested_currency text,
  requested_currency_scale ujira.scale,
  -- The token total the mandate checks, known once routed.
  total_amount ujira.amount
    constraint payouts_total_positive check (total_amount > 0),
  total_asset text,
  total_chain text,
  total_scale ujira.scale,
  status text not null default 'received'
    constraint payouts_status check (
      status in (
        'received',
        'routed',
        'submitting',
        'pending_approval',
        'approved',
        'settling',
        'delivering',
        'partly_paid',
        'paid',
        'needs_attention',
        'blocked',
        'rejected',
        'cancelled',
        'failed'
      )
    ),
  public_status text not null generated always as (
    case status when 'received' then 'queued' when 'routed' then 'submitting' else status end
  ) stored,
  status_reason text
    constraint payouts_status_reason check (
      status_reason is null
      or (status_reason in ('awaiting_funding', 'network_unavailable') and status = 'received')
      or (status_reason = 'funding_hold_expired' and status = 'failed')
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payouts_requested_unit check (
    (
      cashout_cost_bearer = 'recipient'
      and num_nonnulls(requested_asset, requested_chain, requested_token_scale) = 3
      and num_nonnulls(requested_currency, requested_currency_scale) = 0
    ) or (
      cashout_cost_bearer = 'principal'
      and num_nonnulls(requested_asset, requested_chain, requested_token_scale) = 0
      and num_nonnulls(requested_currency, requested_currency_scale) = 2
    )
  ),
  constraint payouts_total_whole
    check (num_nonnulls(total_amount, total_asset, total_chain, total_scale) in (0, 4)),
  constraint payouts_idempotency unique (principal_id, project_id, idempotency_key),
  constraint payouts_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, batch_id)
    references ujira.payout_batches (principal_id, project_id, id),
  foreign key (principal_id, project_id, recipient_id)
    references ujira.recipients (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_id)
    references ujira.mandates (principal_id, project_id, id),
  foreign key (requested_asset, requested_chain, requested_token_scale)
    references ujira.settlement_tokens (asset, chain, token_scale),
  foreign key (requested_currency, requested_currency_scale)
    references ujira.currency_scales (currency, scale),
  foreign key (total_asset, total_chain, total_scale)
    references ujira.settlement_tokens (asset, chain, token_scale)
);

create index payouts_by_status on ujira.payouts (principal_id, project_id, public_status, id);
create index payouts_by_batch on ujira.payouts (principal_id, project_id, batch_id)
  where batch_id is not null;
create index payouts_by_recipient on ujira.payouts (principal_id, project_id, recipient_id);
create index payouts_by_mandate on ujira.payouts (principal_id, project_id, mandate_id);

create table ujira.payout_attempts (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null,
  attempt_number integer not null
    constraint payout_attempts_number_positive check (attempt_number > 0),
  network text not null,
  mandate_instance_id uuid not null,
  -- The total this attempt carries, in the unit of its network.
  total_amount ujira.amount not null
    constraint payout_attempts_total_positive check (total_amount > 0),
  asset text not null,
  scale ujira.scale not null,
  -- The id the contract knows it by, opaque here. Unknown until derived.
  on_chain_payout_id text
    constraint payout_attempts_chain_id_length check (char_length(on_chain_payout_id) between 1 and 128),
  deadline timestamptz not null,
  -- The adapter's proof, at final, that this attempt can never land. Opaque here.
  dead_proof jsonb,
  status text not null default 'created'
    constraint payout_attempts_status check (
      status in (
        'created',
        'requested',
        'pending_approval',
        'approved',
        'executing',
        'settled',
        'final',
        'dead'
      )
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Dead exactly when proven, so nothing can free the payout for a new attempt
  -- on the strength of a guess.
  constraint payout_attempts_dead_has_proof check ((status = 'dead') = (dead_proof is not null)),
  constraint payout_attempts_proof_object
    check (dead_proof is null or jsonb_typeof(dead_proof) = 'object'),
  constraint payout_attempts_number unique (principal_id, project_id, payout_id, attempt_number),
  constraint payout_attempts_chain_id unique (principal_id, project_id, mandate_instance_id, on_chain_payout_id),
  constraint payout_attempts_tenant_key unique (principal_id, project_id, id),
  -- What a leg's foreign key needs, so a leg can only belong to this attempt's
  -- payout and only be in this attempt's unit.
  constraint payout_attempts_leg_key unique (principal_id, project_id, payout_id, id, network, asset, scale),
  foreign key (principal_id, project_id, payout_id)
    references ujira.payouts (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id, network, asset, scale)
    references ujira.mandate_instances (principal_id, project_id, id, chain, asset, scale)
);

-- The rule this table exists for. A final attempt still counts: its payout is
-- done, and must not be tried again.
create unique index payout_attempts_one_live
  on ujira.payout_attempts (principal_id, project_id, payout_id)
  where status <> 'dead';

create table ujira.payout_funding_holds (
  principal_id uuid not null,
  project_id uuid not null,
  payout_id uuid not null,
  network text not null,
  mandate_instance_id uuid not null,
  needed_amount ujira.amount not null
    constraint payout_funding_holds_needed_positive check (needed_amount > 0),
  asset text not null,
  scale ujira.scale not null,
  held_at timestamptz not null default now(),
  primary key (principal_id, project_id, payout_id, network),
  foreign key (principal_id, project_id, payout_id)
    references ujira.payouts (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id, network, asset, scale)
    references ujira.mandate_instances (principal_id, project_id, id, chain, asset, scale)
);

create index payout_funding_holds_release
  on ujira.payout_funding_holds (principal_id, project_id, network, held_at);

create table ujira.project_payout_minimums (
  principal_id uuid not null,
  project_id uuid not null,
  method text not null
    constraint project_payout_minimums_method
      check (method in ('stellar_wallet', 'bank', 'mobile_money', 'cash_pickup')),
  currency text not null,
  scale ujira.scale not null,
  min_amount ujira.amount not null
    constraint project_payout_minimums_positive check (min_amount > 0),
  set_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (principal_id, project_id, method, currency),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id),
  foreign key (principal_id, set_by) references ujira.principal_members (principal_id, user_id),
  foreign key (currency, scale) references ujira.currency_scales (currency, scale)
);

-- A mandate's money only moves for that mandate's payouts, and the tenant key on
-- the instance cannot say so by itself.
create function ujira.payout_instance_matches() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if not exists (
    select 1
      from ujira.payouts as p
      join ujira.mandate_instances as i
        on i.principal_id = p.principal_id
       and i.project_id = p.project_id
       and i.mandate_id = p.mandate_id
     where p.principal_id = new.principal_id
       and p.project_id = new.project_id
       and p.id = new.payout_id
       and i.id = new.mandate_instance_id
  ) then
    raise exception using
      errcode = 'UJ014',
      message = 'the mandate instance does not belong to the mandate of this payout';
  end if;
  return new;
end
$fn$;

-- Holds exist only while the payout is held. Checked at commit, because a release
-- moves the payout and deletes its holds in one transaction, in either order.
create function ujira.funding_hold_is_held() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if not exists (
    select 1
      from ujira.payouts as p
     where p.principal_id = new.principal_id
       and p.project_id = new.project_id
       and p.id = new.payout_id
       and p.status = 'received'
       and p.status_reason = 'awaiting_funding'
  ) then
    raise exception using
      errcode = 'UJ013',
      message = 'a funding hold needs a payout received and awaiting funding';
  end if;
  return null;
end
$fn$;

create function ujira.payout_left_its_holds() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if exists (
    select 1
      from ujira.payout_funding_holds as h
     where h.principal_id = new.principal_id
       and h.project_id = new.project_id
       and h.payout_id = new.id
  ) and exists (
    select 1
      from ujira.payouts as p
     where p.principal_id = new.principal_id
       and p.project_id = new.project_id
       and p.id = new.id
       and (p.status <> 'received' or p.status_reason is distinct from 'awaiting_funding')
  ) then
    raise exception using
      errcode = 'UJ013',
      message = 'a payout that is no longer held still has funding holds';
  end if;
  return null;
end
$fn$;

create trigger payouts_transition before update on ujira.payouts
  for each row execute function ujira.check_transition('payout');
create trigger payouts_touch before update on ujira.payouts
  for each row execute function ujira.touch();
create trigger payout_attempts_transition before update on ujira.payout_attempts
  for each row execute function ujira.check_transition('payout_attempt');
create trigger payout_attempts_touch before update on ujira.payout_attempts
  for each row execute function ujira.touch();
create trigger payout_attempts_instance before insert on ujira.payout_attempts
  for each row execute function ujira.payout_instance_matches();
create trigger payout_funding_holds_instance before insert on ujira.payout_funding_holds
  for each row execute function ujira.payout_instance_matches();
create constraint trigger payout_funding_holds_held after insert on ujira.payout_funding_holds
  deferrable initially deferred
  for each row execute function ujira.funding_hold_is_held();
create constraint trigger payouts_holds_released after update on ujira.payouts
  deferrable initially deferred
  for each row
  when (new.status <> 'received' or new.status_reason is distinct from 'awaiting_funding')
  execute function ujira.payout_left_its_holds();
create trigger project_payout_minimums_touch before update on ujira.project_payout_minimums
  for each row execute function ujira.touch();

-- Financial records. A payout, its batch and its attempts are never removed;
-- holds are working state and go when the payout moves on.
create trigger payout_batches_no_delete before delete on ujira.payout_batches
  for each row execute function ujira.forbid_mutation();
create trigger payout_batches_no_truncate before truncate on ujira.payout_batches
  for each statement execute function ujira.forbid_mutation();
create trigger payouts_no_delete before delete on ujira.payouts
  for each row execute function ujira.forbid_mutation();
create trigger payouts_no_truncate before truncate on ujira.payouts
  for each statement execute function ujira.forbid_mutation();
create trigger payout_attempts_no_delete before delete on ujira.payout_attempts
  for each row execute function ujira.forbid_mutation();
create trigger payout_attempts_no_truncate before truncate on ujira.payout_attempts
  for each statement execute function ujira.forbid_mutation();

select ujira.apply_tenant_policies('ujira.payout_batches');
select ujira.apply_tenant_policies('ujira.payouts');
select ujira.apply_tenant_policies('ujira.payout_attempts');
select ujira.apply_tenant_policies('ujira.payout_funding_holds');
select ujira.apply_tenant_policies('ujira.project_payout_minimums');

create policy tenant_delete on ujira.payout_funding_holds for delete to ujira_app
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());

grant select, insert on ujira.payout_batches to ujira_app;
grant select, insert on ujira.payouts to ujira_app;
-- What a payout was asked to do stays as it was created, by grant as well as by
-- the repository.
grant update (status, status_reason, total_amount, total_asset, total_chain, total_scale)
  on ujira.payouts to ujira_app;
grant select, insert on ujira.payout_attempts to ujira_app;
grant update (status, on_chain_payout_id, dead_proof) on ujira.payout_attempts to ujira_app;
grant select, insert, delete on ujira.payout_funding_holds to ujira_app;
grant select, insert, update on ujira.project_payout_minimums to ujira_app;
grant select on
  ujira.payout_batches,
  ujira.payouts,
  ujira.payout_attempts,
  ujira.payout_funding_holds,
  ujira.project_payout_minimums
  to ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop table ujira.project_payout_minimums;
drop table ujira.payout_funding_holds;
drop table ujira.payout_attempts;
drop table ujira.payouts;
drop table ujira.payout_batches;
drop function ujira.payout_left_its_holds();
drop function ujira.funding_hold_is_held();
drop function ujira.payout_instance_matches();
delete from ujira.status_transitions where machine in ('payout', 'payout_attempt');
delete from ujira.audit_metadata_keys where key in ('method', 'currency', 'scale');
alter table ujira.projects drop column cashout_cost_bearer;
