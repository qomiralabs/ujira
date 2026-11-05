-- expand
-- A funding account is verified when it is created, and the principal owns it and
-- can change it afterwards. UJIRA must not stop that, but must stop vouching for an
-- address that no longer has the shape it verified. What was found at creation is a
-- record, so a later finding goes beside it, one row each time the answer changes,
-- and the latest one says what the account is now.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ujira.funding_account_checks (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  funding_account_id uuid not null,
  -- Empty means the account was read back in the shape it was verified in.
  faults text[] not null default '{}',
  -- The statement's clock, not the transaction's, so two findings cannot tie.
  checked_at timestamptz not null default clock_timestamp(),
  constraint funding_account_checks_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, funding_account_id)
    references ujira.funding_accounts (principal_id, project_id, id)
);

create index funding_account_checks_latest
  on ujira.funding_account_checks (principal_id, project_id, funding_account_id, checked_at);

select ujira.apply_tenant_policies('ujira.funding_account_checks');

-- No update and no delete: each finding is a record of what was on chain.
grant select, insert on ujira.funding_account_checks to ujira_app;
grant select on ujira.funding_account_checks to ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.funding_account_checks;

reset role;
