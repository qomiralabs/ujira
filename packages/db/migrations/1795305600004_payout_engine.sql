-- expand
-- What the payout advance job records beyond the tables it drives.
--
-- A refusal that will be the same on every try, such as an amount below a minimum,
-- ends a payout before it has an attempt, so a payout can reach rejected from where
-- it was routed, and keeps a code saying why. An execute that never landed can be
-- proven dead like any other step, so settling can go back to routed too. The take
-- is on the attempt, since the same request has to be rebuilt exactly on every
-- retry. Each leg keeps what a cash-out cost it, for the record: the chain knows
-- none of this.
--
-- The release sweep finds who has payouts on hold through one narrow function, as
-- the other crons do, reading only tenant ids and a network.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

insert into ujira.status_transitions (machine, from_status, to_status) values
  ('payout', 'received', 'rejected'),
  ('payout', 'routed', 'rejected'),
  ('payout', 'settling', 'routed');

alter table ujira.payouts
  add column refusal_code text
    constraint payouts_refusal_code_format check (refusal_code ~ '^[A-Z][A-Z0-9_]{0,63}$');

grant update (refusal_code) on ujira.payouts to ujira_app;

alter table ujira.payout_attempts
  add column fee_amount ujira.amount not null default 0
    constraint payout_attempts_fee_not_negative check (fee_amount >= 0);

alter table ujira.payout_legs
  -- The rail the router chose, which a rerun has to send again.
  add column rail text
    constraint payout_legs_rail_length check (char_length(rail) between 1 and 64),
  add column receive_amount ujira.amount
    constraint payout_legs_receive_positive check (receive_amount > 0),
  add column receive_currency text,
  add column receive_scale ujira.scale,
  add column fx_numerator ujira.amount
    constraint payout_legs_fx_numerator_positive check (fx_numerator > 0),
  add column fx_denominator ujira.amount
    constraint payout_legs_fx_denominator_positive check (fx_denominator > 0),
  add column cost_bearer text
    constraint payout_legs_cost_bearer check (cost_bearer in ('recipient', 'principal')),
  -- The firm quote the rate was fixed by, which a retry has to send again.
  add column quote_id text
    constraint payout_legs_quote_id_length check (char_length(quote_id) between 1 and 128),
  add constraint payout_legs_delivery_whole check (
    num_nonnulls(
      receive_amount, receive_currency, receive_scale, fx_numerator, fx_denominator, cost_bearer,
      quote_id
    ) in (0, 7)
  ) not valid;

select ujira.apply_scheduler_read(
  'ujira.payout_funding_holds',
  array['principal_id', 'project_id', 'network']
);

-- One row per project and network with a hold, keyset paged. A release runs per
-- project because the balance it spends is an instance's, and an instance has one
-- project.
create function ujira.funding_hold_targets(
  p_after_principal uuid,
  p_after_project uuid,
  p_after_network text,
  p_limit integer
)
  returns table (principal_id uuid, project_id uuid, network text)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'limit must be from 1 to 500';
  end if;
  return query
    select distinct h.principal_id, h.project_id, h.network::text
      from ujira.payout_funding_holds as h
     where (h.principal_id, h.project_id, h.network::text) > (
             coalesce(p_after_principal, '00000000-0000-0000-0000-000000000000'::uuid),
             coalesce(p_after_project, '00000000-0000-0000-0000-000000000000'::uuid),
             coalesce(p_after_network, '')
           )
     order by 1, 2, 3
     limit p_limit;
end
$fn$;

grant execute on function ujira.funding_hold_targets(uuid, uuid, text, integer) to ujira_app;

grant create on schema ujira to ujira_scheduler;
alter function ujira.funding_hold_targets(uuid, uuid, text, integer) owner to ujira_scheduler;
revoke create on schema ujira from ujira_scheduler;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.funding_hold_targets(uuid, uuid, text, integer);

drop policy scheduler_read on ujira.payout_funding_holds;
revoke select (principal_id, project_id, network)
  on ujira.payout_funding_holds from ujira_scheduler;

alter table ujira.payout_legs
  drop constraint payout_legs_delivery_whole,
  drop column quote_id,
  drop column cost_bearer,
  drop column fx_denominator,
  drop column fx_numerator,
  drop column receive_scale,
  drop column receive_currency,
  drop column receive_amount,
  drop column rail;

alter table ujira.payout_attempts drop column fee_amount;

revoke update (refusal_code) on ujira.payouts from ujira_app;
alter table ujira.payouts drop column refusal_code;

delete from ujira.status_transitions
 where machine = 'payout'
   and to_status = 'rejected'
   and from_status in ('received', 'routed');
delete from ujira.status_transitions
 where machine = 'payout' and from_status = 'settling' and to_status = 'routed';

reset role;
