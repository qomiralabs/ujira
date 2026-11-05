-- expand
-- Standard fee terms. No commitment is needed to start: a project is priced at the
-- standard rate from the moment it exists, and a self-serve principal's rate follows its
-- actual volume. The rate falls as volume rises.
--
-- The first row is written when the project is, by a trigger, so it holds for every path
-- that creates one. A real row is what lets an attempt name the terms it was charged under.
--
-- A month's rate comes from the principal's executed volume in the month before, in UTC.
-- Volume is one row per executed attempt rather than a running counter, so recording never
-- contends and a rerun cannot count twice, and an attempt that later dies stops counting.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is never
-- dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_fn_fee_rates') then
    create role ujira_fn_fee_rates nologin noinherit nobypassrls;
  end if;
  alter role ujira_fn_fee_rates nobypassrls;
end
$roles$;

grant ujira_fn_fee_rates to ujira_owner;

set local role ujira_owner;

-- Changing a rate is a migration, because it is a price change.
create table ops.standard_fee_tiers (
  -- The volume in a month, in raw units of the token, that earns this rate.
  floor_amount ujira.amount primary key
    constraint standard_fee_tiers_floor_not_negative check (floor_amount >= 0),
  rate_bps bigint not null
    constraint standard_fee_tiers_rate_range check (rate_bps between 0 and 100),
  asset text not null,
  scale ujira.scale not null,
  -- One token until there is a second, which would need a way to add them up.
  constraint standard_fee_tiers_one_token check (asset = 'USDC' and scale = 7)
);

insert into ops.standard_fee_tiers (floor_amount, rate_bps, asset, scale) values
  (0, 90, 'USDC', 7),
  (1000000000000, 70, 'USDC', 7),
  (10000000000000, 50, 'USDC', 7),
  (100000000000000, 35, 'USDC', 7),
  (500000000000000, 25, 'USDC', 7);

create table ujira.fee_volume_entries (
  principal_id uuid not null,
  project_id uuid not null,
  attempt_id uuid not null,
  payout_id uuid not null,
  amount ujira.amount not null
    constraint fee_volume_entries_amount_positive check (amount > 0),
  chain text not null,
  asset text not null,
  scale ujira.scale not null,
  -- When the chain executed it, which decides the month.
  executed_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (principal_id, project_id, attempt_id),
  foreign key (principal_id, project_id, payout_id, attempt_id, chain, asset, scale)
    references ujira.payout_attempts (principal_id, project_id, payout_id, id, chain, asset, scale)
);

create index fee_volume_entries_by_month
  on ujira.fee_volume_entries (principal_id, executed_at);
create index fee_volume_entries_by_attempt_unit
  on ujira.fee_volume_entries (principal_id, project_id, payout_id, attempt_id, chain, asset, scale);

create function ujira.fee_volume_entry_check() returns trigger
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
       and a.total_amount = new.amount
  ) then
    raise exception using
      errcode = 'UJ021',
      message = 'volume counts an executed attempt, at its own total';
  end if;
  return new;
end
$fn$;

create trigger fee_volume_entries_check before insert on ujira.fee_volume_entries
  for each row execute function ujira.fee_volume_entry_check();
create trigger fee_volume_entries_append_only before update or delete on ujira.fee_volume_entries
  for each row execute function ujira.forbid_mutation();
create trigger fee_volume_entries_no_truncate before truncate on ujira.fee_volume_entries
  for each statement execute function ujira.forbid_mutation();

select ujira.apply_tenant_policies('ujira.fee_volume_entries');

grant select, insert on ujira.fee_volume_entries to ujira_app;
grant select on ujira.fee_volume_entries to ujira_reader;

-- The contract would refuse a rate above the mandate's cap, but only after the attempt was
-- planned and the funds counted on. An instance that has not reported its cap yet has
-- nothing to check against, and a default here would be a promise the contract never made.
create function ujira.payout_attempt_within_mandate_cap() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if exists (
    select 1
      from ujira.mandate_instances as i
     where i.principal_id = new.principal_id
       and i.project_id = new.project_id
       and i.id = new.mandate_instance_id
       and new.fee_bps_applied > i.max_fee_bps
  ) then
    raise exception using
      errcode = '23514',
      message = 'the fee rate is above the cap of this mandate';
  end if;
  return new;
end
$fn$;

create trigger payout_attempts_fee_within_mandate before insert on ujira.payout_attempts
  for each row execute function ujira.payout_attempt_within_mandate_cap();

-- The first row. Called from a trigger, where the principal is often being created and no
-- tenant is set, so the tenant is named by the arguments. It writes no audit entry: this is
-- a default and nobody's decision, the row itself is the record, and an audit entry would
-- put a row at the head of every new principal's chain. Nothing but this role's own
-- functions can call it.
create function ujira.seed_standard_fee_terms(
  p_principal uuid,
  p_project uuid,
  p_valid_from timestamptz
) returns void
  language sql
  security definer
  set search_path = pg_catalog
as $fn$
  insert into ujira.fee_terms (principal_id, project_id, rate_bps, basis, valid_from)
  select p_principal, p_project, t.rate_bps, 'standard', p_valid_from
    from ops.standard_fee_tiers as t
   where t.floor_amount = 0;
$fn$;

create function ujira.project_standard_fee_terms() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
begin
  perform ujira.seed_standard_fee_terms(new.principal_id, new.id, new.created_at);
  return new;
end
$fn$;

create trigger projects_standard_fee_terms after insert on ujira.projects
  for each row execute function ujira.project_standard_fee_terms();

-- For the projects that existed before the trigger. Valid from when each was created, so
-- a payout requested at any time since has terms. Running it again finds nothing to do.
create function ujira.backfill_standard_fee_terms() returns void
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  project record;
begin
  for project in
    select p.principal_id, p.id, p.created_at
      from ujira.projects as p
     where not exists (
       select 1
         from ujira.fee_terms as t
        where t.principal_id = p.principal_id
          and t.project_id = p.id
     )
  loop
    perform ujira.seed_standard_fee_terms(project.principal_id, project.id, project.created_at);
  end loop;
end
$fn$;

-- What the principal executed in a UTC month, across all its projects, in the tiers' token.
-- An attempt that settled and then died is not in it.
create function ujira.principal_executed_volume(p_month_start timestamptz)
  returns table (amount numeric, asset text, scale integer)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
declare
  month_utc timestamp := p_month_start at time zone 'UTC';
begin
  if p_month_start is null or month_utc <> date_trunc('month', month_utc) then
    raise exception using
      errcode = '22023',
      message = 'a fee month starts at the first instant of a UTC month';
  end if;
  return query
    select coalesce(sum(e.amount), 0)::numeric, u.asset, u.scale::integer
      from (select distinct t.asset, t.scale from ops.standard_fee_tiers as t) as u
      left join ujira.fee_volume_entries as e
        on e.principal_id = ujira.current_principal_id()
       and e.executed_at >= p_month_start
       and e.executed_at < ((month_utc + interval '1 month') at time zone 'UTC')
       and e.asset = u.asset
       and e.scale = u.scale
       and exists (
         select 1
           from ujira.payout_attempts as a
          where a.principal_id = e.principal_id
            and a.project_id = e.project_id
            and a.id = e.attempt_id
            and a.status in ('settled', 'final')
       )
     group by u.asset, u.scale;
end
$fn$;

-- Moves the current project to the rate its principal's last month earned, by a new row
-- valid from the month's start. The row is what makes a rerun write nothing, and once
-- written it stands: an execution recorded late moves nothing. Terms somebody agreed are
-- left as they are, and a month before the project existed has nothing in force to move.
create function ujira.apply_standard_fee_rate(p_month_start timestamptz)
  returns table (rate_bps bigint, applied boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  month_utc timestamp := p_month_start at time zone 'UTC';
  in_force record;
  volume numeric;
  earned bigint;
  new_id uuid := gen_random_uuid();
  written integer;
begin
  if p_month_start is null or month_utc <> date_trunc('month', month_utc) then
    raise exception using
      errcode = '22023',
      message = 'a fee month starts at the first instant of a UTC month';
  end if;

  select t.basis, t.rate_bps into in_force
    from ujira.fee_terms as t
   where t.principal_id = ujira.current_principal_id()
     and t.project_id = ujira.current_project_id()
     and t.valid_from <= p_month_start
   order by t.valid_from desc
   limit 1;
  if not found or in_force.basis <> 'standard' then
    return query select null::bigint, false;
    return;
  end if;

  select v.amount into strict volume
    from ujira.principal_executed_volume(
      (month_utc - interval '1 month') at time zone 'UTC'
    ) as v;
  select t.rate_bps into strict earned
    from ops.standard_fee_tiers as t
   where t.floor_amount <= volume
   order by t.floor_amount desc
   limit 1;

  -- This month's row, if a run already wrote one, is the answer and is not reopened.
  if exists (
    select 1
      from ujira.fee_terms as t
     where t.principal_id = ujira.current_principal_id()
       and t.project_id = ujira.current_project_id()
       and t.valid_from = p_month_start
  ) then
    return query select in_force.rate_bps, false;
    return;
  end if;

  if earned = in_force.rate_bps then
    return query select earned, false;
    return;
  end if;

  insert into ujira.fee_terms (principal_id, project_id, id, rate_bps, basis, valid_from)
  values (
    ujira.current_principal_id(), ujira.current_project_id(), new_id, earned, 'standard',
    p_month_start
  )
  on conflict on constraint fee_terms_per_instant do nothing;
  get diagnostics written = row_count;
  if written = 0 then
    return query select earned, false;
    return;
  end if;

  -- audit_chain overwrites the sequence and both hashes.
  insert into ujira.audit_log
    (principal_id, project_id, action, actor_kind, actor_id, metadata, seq, prev_hash, row_hash)
  values (
    ujira.current_principal_id(), ujira.current_project_id(), 'fee_terms.recorded', 'system', null,
    jsonb_build_object(
      'target_type', 'fee_terms', 'target_id', new_id::text, 'new_value', earned::text
    ),
    0, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex')
  );
  return query select earned, true;
end
$fn$;

-- The seed runs where no tenant is set, so its insert cannot be checked against one. This
-- role can only be reached through the functions above, which name the tenant themselves.
create policy fee_terms_rates_insert on ujira.fee_terms for insert to ujira_fn_fee_rates
  with check (true);
create policy fee_terms_rates_read on ujira.fee_terms for select to ujira_fn_fee_rates
  using (true);
create policy fee_terms_rates_audit on ujira.audit_log for insert to ujira_fn_fee_rates
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy fee_volume_rates_read on ujira.fee_volume_entries for select to ujira_fn_fee_rates
  using (principal_id = ujira.current_principal_id());
create policy attempts_rates_read on ujira.payout_attempts for select to ujira_fn_fee_rates
  using (principal_id = ujira.current_principal_id());
create policy projects_rates_read on ujira.projects for select to ujira_fn_fee_rates
  using (true);

grant usage on schema ujira, ops to ujira_fn_fee_rates;
grant usage on type ujira.amount, ujira.scale to ujira_fn_fee_rates;
grant select on ops.standard_fee_tiers to ujira_fn_fee_rates;
grant select on ops.standard_fee_tiers to ujira_ops;
grant select, insert on ujira.fee_terms to ujira_fn_fee_rates;
grant insert on ujira.audit_log to ujira_fn_fee_rates;
grant select on ujira.fee_volume_entries, ujira.payout_attempts, ujira.projects
  to ujira_fn_fee_rates;
grant execute on function
  ujira.current_principal_id(), ujira.current_project_id(), ujira.project_scope_all()
  to ujira_fn_fee_rates;

revoke execute on function
  ujira.seed_standard_fee_terms(uuid, uuid, timestamptz),
  ujira.project_standard_fee_terms(),
  ujira.backfill_standard_fee_terms(),
  ujira.principal_executed_volume(timestamptz),
  ujira.apply_standard_fee_rate(timestamptz)
  from public;

grant execute on function ujira.principal_executed_volume(timestamptz) to ujira_app;
grant execute on function ujira.apply_standard_fee_rate(timestamptz) to ujira_app;

-- Handing a function to another role needs that role to hold CREATE on the schema, so
-- it is granted for the handover only.
grant create on schema ujira to ujira_fn_fee_rates;
alter function ujira.seed_standard_fee_terms(uuid, uuid, timestamptz) owner to ujira_fn_fee_rates;
alter function ujira.project_standard_fee_terms() owner to ujira_fn_fee_rates;
alter function ujira.backfill_standard_fee_terms() owner to ujira_fn_fee_rates;
alter function ujira.principal_executed_volume(timestamptz) owner to ujira_fn_fee_rates;
alter function ujira.apply_standard_fee_rate(timestamptz) owner to ujira_fn_fee_rates;
revoke create on schema ujira from ujira_fn_fee_rates;

select ujira.backfill_standard_fee_terms();

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop trigger projects_standard_fee_terms on ujira.projects;
drop trigger payout_attempts_fee_within_mandate on ujira.payout_attempts;
drop function ujira.payout_attempt_within_mandate_cap();

drop policy projects_rates_read on ujira.projects;
drop policy attempts_rates_read on ujira.payout_attempts;
drop policy fee_terms_rates_audit on ujira.audit_log;
drop policy fee_terms_rates_read on ujira.fee_terms;
drop policy fee_terms_rates_insert on ujira.fee_terms;

drop function ujira.apply_standard_fee_rate(timestamptz);
drop function ujira.principal_executed_volume(timestamptz);
drop function ujira.backfill_standard_fee_terms();
drop function ujira.project_standard_fee_terms();
drop function ujira.seed_standard_fee_terms(uuid, uuid, timestamptz);

drop table ujira.fee_volume_entries;
drop function ujira.fee_volume_entry_check();
drop table ops.standard_fee_tiers;

revoke select on ujira.projects, ujira.payout_attempts from ujira_fn_fee_rates;
revoke select, insert on ujira.fee_terms from ujira_fn_fee_rates;
revoke insert on ujira.audit_log from ujira_fn_fee_rates;
revoke execute on function
  ujira.current_principal_id(), ujira.current_project_id(), ujira.project_scope_all()
  from ujira_fn_fee_rates;
revoke usage on type ujira.amount, ujira.scale from ujira_fn_fee_rates;
revoke usage on schema ujira, ops from ujira_fn_fee_rates;

reset role;
