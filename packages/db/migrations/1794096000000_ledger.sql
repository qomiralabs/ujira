-- expand
-- The double-entry ledger mirror. It records finalized on-chain facts as
-- balanced journals per mandate instance, so the dashboard and reconciliation
-- can always show where every minor unit is. It mirrors the contract and
-- never decides anything: the contract's state() is the truth, and the
-- reconciliation view is where a disagreement shows.
--
-- Every entry goes through ledger_stamp, which locks the account row and
-- writes the running balance, so the balance after each entry is exact under
-- any concurrency and an account's sequence has no gaps. The stamp runs as its
-- own narrow role, because it is the only thing allowed to change a balance.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is
-- never dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_fn_ledger') then
    create role ujira_fn_ledger nologin noinherit nobypassrls;
  end if;
  alter role ujira_fn_ledger nobypassrls;
end
$roles$;

grant ujira_fn_ledger to ujira_owner;

set local role ujira_owner;

-- One account of each kind per mandate instance. balance, pending, committed
-- and spent are the four figures the contract reports. external is the other
-- side of money entering or leaving the contract: without it a deposit could
-- not be a balanced journal, and it is never compared with the contract.
create table ujira.ledger_accounts (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_instance_id uuid not null,
  kind text not null
    constraint ledger_accounts_kind
      check (kind in ('balance', 'pending', 'committed', 'spent', 'external')),
  chain text not null,
  asset text not null,
  scale ujira.scale not null,
  balance ujira.amount not null default 0,
  last_seq bigint not null default 0,
  created_at timestamptz not null default now(),
  constraint ledger_accounts_per_kind unique (principal_id, project_id, mandate_instance_id, kind),
  constraint ledger_accounts_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id, chain, asset, scale)
    references ujira.mandate_instances (principal_id, project_id, id, chain, asset, scale)
);

-- A journal mirrors one chain event, or reverses one earlier journal.
-- Corrections are reversals, never edits or deletes. Each unique key makes
-- posting idempotent: the same event posts once, and a journal is reversed at
-- most once.
create table ujira.ledger_journals (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_instance_id uuid not null,
  chain_event_id uuid,
  reverses_journal_id uuid,
  created_at timestamptz not null default now(),
  constraint ledger_journals_one_cause
    check ((chain_event_id is null) <> (reverses_journal_id is null)),
  constraint ledger_journals_per_event unique (principal_id, project_id, chain_event_id),
  constraint ledger_journals_reversed_once unique (principal_id, project_id, reverses_journal_id),
  constraint ledger_journals_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id)
    references ujira.mandate_instances (principal_id, project_id, id),
  foreign key (principal_id, project_id, chain_event_id)
    references ujira.chain_events (principal_id, project_id, id),
  foreign key (principal_id, project_id, reverses_journal_id)
    references ujira.ledger_journals (principal_id, project_id, id)
);

-- account_seq and balance_after are written by ledger_stamp whatever a caller
-- passes.
create table ujira.ledger_entries (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null,
  account_id uuid not null,
  amount ujira.amount not null
    constraint ledger_entries_amount_nonzero check (amount <> 0),
  account_seq bigint not null,
  balance_after ujira.amount not null,
  created_at timestamptz not null default now(),
  constraint ledger_entries_seq unique (account_id, account_seq),
  foreign key (principal_id, project_id, journal_id)
    references ujira.ledger_journals (principal_id, project_id, id),
  foreign key (principal_id, project_id, account_id)
    references ujira.ledger_accounts (principal_id, project_id, id)
);

create index ledger_entries_by_journal on ujira.ledger_entries (principal_id, project_id, journal_id);

-- What the contract's state() reported at a ledger, kept as the other side of
-- the reconciliation view.
create table ujira.mandate_state_snapshots (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_instance_id uuid not null,
  ledger bigint not null
    constraint mandate_state_snapshots_ledger_positive check (ledger >= 0),
  balance ujira.amount not null,
  pending ujira.amount not null,
  committed ujira.amount not null,
  spent ujira.amount not null,
  taken_at timestamptz not null default now(),
  constraint mandate_state_snapshots_per_ledger unique (principal_id, project_id, mandate_instance_id, ledger),
  foreign key (principal_id, project_id, mandate_instance_id)
    references ujira.mandate_instances (principal_id, project_id, id)
);

-- Stamps one entry. Taking the account row's lock first is what makes the
-- sequence gapless and the balance exact: writers on one account queue here.
-- UJ011 refuses an entry that would take an account past zero the wrong way.
create function ujira.ledger_stamp() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  account ujira.ledger_accounts%rowtype;
  next_balance numeric;
begin
  select * into account
    from ujira.ledger_accounts as a
   where a.id = new.account_id
     and a.principal_id = new.principal_id
     and a.project_id = new.project_id
   for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'a ledger entry must name an account of its own tenant';
  end if;
  next_balance := account.balance + new.amount;
  if (account.kind = 'external' and next_balance > 0)
     or (account.kind <> 'external' and next_balance < 0) then
    raise exception using
      errcode = 'UJ011',
      message = format('this entry would take a %s account past zero', account.kind);
  end if;
  new.account_seq := account.last_seq + 1;
  new.balance_after := next_balance;
  update ujira.ledger_accounts as a
     set balance = next_balance,
         last_seq = new.account_seq
   where a.id = account.id;
  return new;
end
$fn$;

-- Refuses a journal whose entries do not sum to zero, at commit, so a writer
-- can post its entries in any order. A journal with no entries is refused too,
-- because it would record a cause with no effect.
create function ujira.ledger_balanced() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  journal uuid;
  total numeric;
  entries bigint;
begin
  -- Two statements, because a field of NEW is resolved when its statement is
  -- planned, and each table has only one of these columns.
  if tg_table_name = 'ledger_journals' then
    journal := new.id;
  else
    journal := new.journal_id;
  end if;
  select coalesce(sum(e.amount), 0), count(*) into total, entries
    from ujira.ledger_entries as e
   where e.journal_id = journal;
  if entries = 0 or total <> 0 then
    raise exception using
      errcode = 'UJ003',
      message = format('ledger journal %s does not balance: %s entries summing to %s', journal, entries, total);
  end if;
  return null;
end
$fn$;

-- Only the stamp changes an account. Everyone else, the owner included, is
-- refused, and a new account always starts at zero, which is what keeps a
-- balance equal to the sum of its entries.
create function ujira.ledger_accounts_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if tg_op = 'INSERT' then
    new.balance := 0;
    new.last_seq := 0;
    return new;
  end if;
  if tg_op = 'UPDATE' and current_user = 'ujira_fn_ledger'
     and new.id = old.id
     and new.principal_id = old.principal_id
     and new.project_id = old.project_id
     and new.mandate_instance_id = old.mandate_instance_id
     and new.kind = old.kind
     and new.chain = old.chain
     and new.asset = old.asset
     and new.scale = old.scale then
    return new;
  end if;
  raise exception using
    errcode = 'UJ002',
    message = format('%I.%I is changed only by the ledger stamp: %s is refused', tg_table_schema, tg_table_name, lower(tg_op));
end
$fn$;

create trigger ledger_entries_stamp before insert on ujira.ledger_entries
  for each row execute function ujira.ledger_stamp();
create constraint trigger ledger_entries_balanced after insert on ujira.ledger_entries
  deferrable initially deferred
  for each row execute function ujira.ledger_balanced();
create constraint trigger ledger_journals_balanced after insert on ujira.ledger_journals
  deferrable initially deferred
  for each row execute function ujira.ledger_balanced();

create trigger ledger_accounts_guard before insert or update or delete on ujira.ledger_accounts
  for each row execute function ujira.ledger_accounts_guard();
create trigger ledger_accounts_no_truncate before truncate on ujira.ledger_accounts
  for each statement execute function ujira.forbid_mutation();
create trigger ledger_journals_append_only before update or delete on ujira.ledger_journals
  for each row execute function ujira.forbid_mutation();
create trigger ledger_journals_no_truncate before truncate on ujira.ledger_journals
  for each statement execute function ujira.forbid_mutation();
create trigger ledger_entries_append_only before update or delete on ujira.ledger_entries
  for each row execute function ujira.forbid_mutation();
create trigger ledger_entries_no_truncate before truncate on ujira.ledger_entries
  for each statement execute function ujira.forbid_mutation();
create trigger mandate_state_snapshots_append_only before update or delete on ujira.mandate_state_snapshots
  for each row execute function ujira.forbid_mutation();
create trigger mandate_state_snapshots_no_truncate before truncate on ujira.mandate_state_snapshots
  for each statement execute function ujira.forbid_mutation();

select ujira.apply_tenant_policies('ujira.ledger_accounts');
select ujira.apply_tenant_policies('ujira.ledger_journals');
select ujira.apply_tenant_policies('ujira.ledger_entries');
select ujira.apply_tenant_policies('ujira.mandate_state_snapshots');

create policy ledger_stamp_read on ujira.ledger_accounts for select to ujira_fn_ledger using (true);
create policy ledger_stamp_update on ujira.ledger_accounts for update to ujira_fn_ledger
  using (true) with check (true);
create policy ledger_balanced_read on ujira.ledger_entries for select to ujira_fn_ledger using (true);

-- The indexer posts under a tenant context. It reads the instance to open the
-- accounts in its unit, and writes journals and entries; it holds no update
-- right on an account.
create policy indexer_read on ujira.mandate_instances for select to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_read on ujira.ledger_accounts for select to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_insert on ujira.ledger_accounts for insert to ujira_indexer
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_read on ujira.ledger_journals for select to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_insert on ujira.ledger_journals for insert to ujira_indexer
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_read on ujira.ledger_entries for select to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_insert on ujira.ledger_entries for insert to ujira_indexer
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_read on ujira.mandate_state_snapshots for select to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy indexer_insert on ujira.mandate_state_snapshots for insert to ujira_indexer
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());

grant select on
  ujira.ledger_accounts,
  ujira.ledger_journals,
  ujira.ledger_entries,
  ujira.mandate_state_snapshots
  to ujira_app, ujira_reader;
grant select on ujira.mandate_instances to ujira_indexer;
grant select, insert on
  ujira.ledger_accounts,
  ujira.ledger_journals,
  ujira.ledger_entries,
  ujira.mandate_state_snapshots
  to ujira_indexer;

grant usage on schema ujira to ujira_fn_ledger;
grant select, update on ujira.ledger_accounts to ujira_fn_ledger;
grant select on ujira.ledger_entries to ujira_fn_ledger;
grant usage on domain ujira.amount to ujira_fn_ledger;

-- The latest state() of each instance beside the ledger's four accounts. A row
-- with matches false is a disagreement between the ledger and the contract.
-- security_invoker, so the caller's own row level security applies to it.
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

-- Handing the two definer functions over needs CREATE for a moment.
grant create on schema ujira to ujira_fn_ledger;
alter function ujira.ledger_stamp() owner to ujira_fn_ledger;
alter function ujira.ledger_balanced() owner to ujira_fn_ledger;
revoke create on schema ujira from ujira_fn_ledger;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop view ujira.ledger_reconciliation;
drop table ujira.mandate_state_snapshots;
drop table ujira.ledger_entries;
drop table ujira.ledger_journals;
drop table ujira.ledger_accounts;
drop function ujira.ledger_accounts_guard();
drop function ujira.ledger_balanced();
drop function ujira.ledger_stamp();
drop policy indexer_read on ujira.mandate_instances;
revoke select on ujira.mandate_instances from ujira_indexer;
revoke usage on domain ujira.amount from ujira_fn_ledger;
revoke usage on schema ujira from ujira_fn_ledger;
revoke ujira_fn_ledger from ujira_owner;
