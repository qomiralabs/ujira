-- expand
-- Payout legs and approvals. From day one a payout is one or more legs, and the
-- legs of an attempt always sum exactly to its total: checked at commit, so an
-- attempt and its legs can be written in any order within a transaction.
--
-- The check fires on a leg, not on a new attempt, so the release before this one
-- can still write the attempts it knows how to write, with no legs. Nothing pays
-- without a leg, and the repository refuses to create an attempt without one.
--
-- An approval records one approver's signed intent. It is append only, because a
-- signature that was given stays given.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

insert into ujira.status_transitions (machine, from_status, to_status) values
  ('payout_leg', 'planned', 'submitted'),
  ('payout_leg', 'planned', 'cancelled'),
  ('payout_leg', 'planned', 'failed'),
  ('payout_leg', 'submitted', 'settled'),
  ('payout_leg', 'submitted', 'cancelled'),
  ('payout_leg', 'submitted', 'failed'),
  ('payout_leg', 'settled', 'delivering'),
  ('payout_leg', 'settled', 'delivered'),
  ('payout_leg', 'settled', 'failed'),
  ('payout_leg', 'delivering', 'delivered'),
  ('payout_leg', 'delivering', 'failed');

create table ujira.payout_legs (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null,
  attempt_id uuid not null,
  leg_index integer not null
    constraint payout_legs_index_range check (leg_index between 0 and 3),
  payout_method_id uuid not null,
  method text not null
    constraint payout_legs_method
      check (method in ('stellar_wallet', 'bank', 'mobile_money', 'cash_pickup')),
  destination_address text not null
    constraint payout_legs_address_length check (char_length(destination_address) between 1 and 128),
  destination_tag ujira.u64,
  amount ujira.amount not null
    constraint payout_legs_amount_positive check (amount > 0),
  chain text not null,
  asset text not null,
  scale ujira.scale not null,
  -- What the rail charges on this leg. UJIRA's own take is never in here.
  fee_amount ujira.amount not null default 0
    constraint payout_legs_fee_not_negative check (fee_amount >= 0),
  -- Written by payout_leg_stamp whatever a caller passes.
  leg_key text not null default ''
    constraint payout_legs_key_format check (leg_key ~ '^[0-9a-f]{64}$'),
  chain_tx_hash text
    constraint payout_legs_tx_hash_length check (char_length(chain_tx_hash) between 1 and 128),
  status text not null default 'planned'
    constraint payout_legs_status check (
      status in ('planned', 'submitted', 'settled', 'delivering', 'delivered', 'failed', 'cancelled')
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_legs_per_attempt unique (principal_id, project_id, attempt_id, leg_index),
  constraint payout_legs_tenant_key unique (principal_id, project_id, id),
  -- Carries the payout and the unit, so a leg cannot belong to another payout's
  -- attempt or be in a unit its attempt is not.
  foreign key (principal_id, project_id, payout_id, attempt_id, chain, asset, scale)
    references ujira.payout_attempts (principal_id, project_id, payout_id, id, network, asset, scale),
  foreign key (principal_id, project_id, payout_method_id)
    references ujira.payout_methods (principal_id, project_id, id)
);

create index payout_legs_by_key on ujira.payout_legs (principal_id, project_id, leg_key);
create index payout_legs_by_payout on ujira.payout_legs (principal_id, project_id, payout_id);
create index payout_legs_by_method on ujira.payout_legs (principal_id, project_id, payout_method_id);

create table ujira.approvals (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null,
  -- The approver's chain address, which is what the contract knows them by.
  approver text not null
    constraint approvals_approver_length check (char_length(approver) between 1 and 128),
  decision text not null
    constraint approvals_decision check (decision in ('approved', 'rejected')),
  signed_message_hash ujira.hash32 not null,
  signature bytea not null
    constraint approvals_signature_length check (octet_length(signature) between 1 and 512),
  created_at timestamptz not null default now(),
  -- One approver decides once per attempt.
  constraint approvals_per_approver unique (principal_id, project_id, attempt_id, approver),
  foreign key (principal_id, project_id, attempt_id)
    references ujira.payout_attempts (principal_id, project_id, id)
);

-- Derives the key from the payout and the index, so a retry of a leg can never
-- carry a different one, and refuses a leg paid through a method that is not the
-- payout recipient's, or not on this chain or of this kind.
create function ujira.payout_leg_stamp() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if not exists (
    select 1
      from ujira.payouts as p
      join ujira.payout_methods as m
        on m.principal_id = p.principal_id
       and m.project_id = p.project_id
       and m.recipient_id = p.recipient_id
     where p.principal_id = new.principal_id
       and p.project_id = new.project_id
       and p.id = new.payout_id
       and m.id = new.payout_method_id
       and m.chain = new.chain
       and m.method = new.method
  ) then
    raise exception using
      errcode = 'UJ015',
      message = 'the payout method is not one the recipient of this payout has for this leg';
  end if;
  new.leg_key := encode(
    sha256(convert_to('ujira/leg/v1|' || new.payout_id::text || '|' || new.leg_index::text, 'UTF8')),
    'hex'
  );
  return new;
end
$fn$;

-- The argument names the column holding the attempt's id on the firing table.
create function ujira.legs_match_attempt() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
declare
  target uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
  expected numeric;
  actual numeric;
begin
  select a.total_amount into expected
    from ujira.payout_attempts as a
   where a.principal_id = new.principal_id
     and a.project_id = new.project_id
     and a.id = target;
  select coalesce(sum(l.amount), 0) into actual
    from ujira.payout_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.attempt_id = target;
  if actual is distinct from expected then
    raise exception using
      errcode = 'UJ005',
      message = format('the legs of an attempt sum to %s and its total is %s', actual, expected);
  end if;
  return null;
end
$fn$;

create trigger payout_legs_stamp before insert or update of payout_id, leg_index, payout_method_id, chain, method
  on ujira.payout_legs
  for each row execute function ujira.payout_leg_stamp();
create trigger payout_legs_transition before update on ujira.payout_legs
  for each row execute function ujira.check_transition('payout_leg');
create trigger payout_legs_touch before update on ujira.payout_legs
  for each row execute function ujira.touch();
create constraint trigger payout_legs_match_attempt after insert or update of amount, attempt_id
  on ujira.payout_legs
  deferrable initially deferred
  for each row execute function ujira.legs_match_attempt('attempt_id');
create constraint trigger payout_attempts_match_legs after update of total_amount
  on ujira.payout_attempts
  deferrable initially deferred
  for each row execute function ujira.legs_match_attempt('id');
create trigger payout_legs_no_delete before delete on ujira.payout_legs
  for each row execute function ujira.forbid_mutation();
create trigger payout_legs_no_truncate before truncate on ujira.payout_legs
  for each statement execute function ujira.forbid_mutation();
create trigger approvals_append_only before update or delete on ujira.approvals
  for each row execute function ujira.forbid_mutation();
create trigger approvals_no_truncate before truncate on ujira.approvals
  for each statement execute function ujira.forbid_mutation();

select ujira.apply_tenant_policies('ujira.payout_legs');
select ujira.apply_tenant_policies('ujira.approvals');

grant select, insert on ujira.payout_legs to ujira_app;
grant update (status, chain_tx_hash) on ujira.payout_legs to ujira_app;
grant select, insert on ujira.approvals to ujira_app;
grant select on ujira.payout_legs, ujira.approvals to ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop trigger payout_attempts_match_legs on ujira.payout_attempts;
drop table ujira.approvals;
drop table ujira.payout_legs;
drop function ujira.legs_match_attempt();
drop function ujira.payout_leg_stamp();
delete from ujira.status_transitions where machine = 'payout_leg';
