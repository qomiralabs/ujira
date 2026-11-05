-- expand
-- Receipts. Every payout produces one, listing every leg with its chain and
-- transaction reference. A receipt is permanent: a correction is a new revision,
-- never an edit, so both tables are append only.
--
-- The document is stored as the exact text it was hashed from. jsonb would reorder its
-- keys and drop its whitespace, and it could then never match its hash. It holds what
-- a receipt shows, which is a masked destination, never a full one: these rows are
-- kept for good, and survive a recipient's erasure.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ujira.receipts (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null,
  attempt_id uuid not null,
  -- Bounded, so it reads back exactly as a JavaScript number.
  revision bigint not null
    constraint receipts_revision_range check (revision between 1 and 1000000),
  receipt_number text not null
    constraint receipts_number_format check (receipt_number ~ '^R-[0-9A-Z]{12}$'),
  network ujira.network_id not null,
  issued_at timestamptz not null,
  -- The adapter's reference, opaque here.
  chain_receipt_ref text not null
    constraint receipts_ref_length check (char_length(chain_receipt_ref) between 1 and 512),
  chain text not null,
  asset text not null,
  scale ujira.scale not null,
  settlement_amount ujira.amount not null
    constraint receipts_settlement_positive check (settlement_amount > 0),
  -- What the rails charged across the legs. UJIRA's take is never in here.
  fee_amount ujira.amount not null default 0
    constraint receipts_fee_not_negative check (fee_amount >= 0),
  canonical_document text not null
    constraint receipts_document_present check (char_length(canonical_document) > 0),
  document_sha256 ujira.hash32 not null,
  -- The document this one replaces, so revisions form a chain nobody can rewrite.
  supersedes_sha256 ujira.hash32,
  created_at timestamptz not null default now(),
  constraint receipts_supersedes_after_first check ((revision = 1) = (supersedes_sha256 is null)),
  constraint receipts_network_on_chain check (split_part(network, ':', 1) = chain),
  constraint receipts_revision unique (principal_id, project_id, payout_id, revision),
  constraint receipts_number unique (principal_id, project_id, receipt_number),
  constraint receipts_tenant_key unique (principal_id, project_id, id),
  -- What a receipt leg's foreign key needs.
  constraint receipts_leg_key unique (principal_id, project_id, id, attempt_id, chain, asset, scale),
  -- Carries the payout and the unit, so a receipt cannot name another payout's
  -- attempt or be in a unit that attempt is not.
  foreign key (principal_id, project_id, payout_id, attempt_id, chain, asset, scale)
    references ujira.payout_attempts (principal_id, project_id, payout_id, id, chain, asset, scale)
);

create index receipts_by_attempt on ujira.receipts (principal_id, project_id, attempt_id);

create table ujira.receipt_legs (
  principal_id uuid not null,
  project_id uuid not null,
  receipt_id uuid not null,
  attempt_id uuid not null,
  leg_index bigint not null,
  -- Short enough that no chain's full address fits.
  destination_masked text not null
    constraint receipt_legs_masked_length check (char_length(destination_masked) between 1 and 32),
  destination_tag ujira.u64,
  amount ujira.amount not null
    constraint receipt_legs_amount_positive check (amount > 0),
  fee_amount ujira.amount not null default 0
    constraint receipt_legs_fee_not_negative check (fee_amount >= 0),
  chain text not null,
  asset text not null,
  scale ujira.scale not null,
  chain_receipt_ref text not null
    constraint receipt_legs_ref_length check (char_length(chain_receipt_ref) between 1 and 512),
  created_at timestamptz not null default now(),
  primary key (principal_id, project_id, receipt_id, leg_index),
  foreign key (principal_id, project_id, receipt_id, attempt_id, chain, asset, scale)
    references ujira.receipts (principal_id, project_id, id, attempt_id, chain, asset, scale),
  -- A leg of the attempt the receipt is for, by construction.
  foreign key (principal_id, project_id, attempt_id, leg_index)
    references ujira.payout_legs (principal_id, project_id, attempt_id, leg_index)
);

create index receipt_legs_by_leg
  on ujira.receipt_legs (principal_id, project_id, attempt_id, leg_index);

-- A receipt lists every leg of its attempt and its figures add up, checked at
-- commit because the legs are written after the receipt. The argument names the
-- column holding the receipt's id on the firing table.
create function ujira.receipt_is_whole() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
declare
  target uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
  receipt ujira.receipts%rowtype;
  listed bigint;
  settled numeric;
  fees numeric;
  expected bigint;
begin
  select * into receipt
    from ujira.receipts as r
   where r.principal_id = new.principal_id
     and r.project_id = new.project_id
     and r.id = target;
  select count(*), coalesce(sum(l.amount), 0), coalesce(sum(l.fee_amount), 0)
    into listed, settled, fees
    from ujira.receipt_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.receipt_id = target;
  select count(*) into expected
    from ujira.payout_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.attempt_id = receipt.attempt_id;
  if listed <> expected
     or settled <> receipt.settlement_amount
     or fees <> receipt.fee_amount then
    raise exception using
      errcode = 'UJ016',
      message = 'a receipt must list every leg of its attempt, and its totals must be their sums';
  end if;
  return null;
end
$fn$;

create constraint trigger receipts_whole after insert on ujira.receipts
  deferrable initially deferred
  for each row execute function ujira.receipt_is_whole('id');
create constraint trigger receipt_legs_whole after insert on ujira.receipt_legs
  deferrable initially deferred
  for each row execute function ujira.receipt_is_whole('receipt_id');
create trigger receipts_append_only before update or delete on ujira.receipts
  for each row execute function ujira.forbid_mutation();
create trigger receipts_no_truncate before truncate on ujira.receipts
  for each statement execute function ujira.forbid_mutation();
create trigger receipt_legs_append_only before update or delete on ujira.receipt_legs
  for each row execute function ujira.forbid_mutation();
create trigger receipt_legs_no_truncate before truncate on ujira.receipt_legs
  for each statement execute function ujira.forbid_mutation();

select ujira.apply_tenant_policies('ujira.receipts');
select ujira.apply_tenant_policies('ujira.receipt_legs');

grant select, insert on ujira.receipts, ujira.receipt_legs to ujira_app;
grant select on ujira.receipts, ujira.receipt_legs to ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop table ujira.receipt_legs;
drop table ujira.receipts;
drop function ujira.receipt_is_whole();
