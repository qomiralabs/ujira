-- expand
-- A forwarding account a principal controls, for exchanges that cannot send to a
-- contract. One funding source per mandate instance is not where this belongs:
-- the account is one per principal and network, and serves every instance there,
-- so its address and what was found on chain need a row of their own.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ujira.funding_accounts (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  network text not null
    constraint funding_accounts_network_length check (char_length(network) between 1 and 64),
  address text not null
    constraint funding_accounts_address_length check (char_length(address) between 1 and 128),
  sponsor text not null
    constraint funding_accounts_sponsor_length check (char_length(sponsor) between 1 and 128),
  sponsor_tx_hash ujira.hash32 not null,
  status text not null
    constraint funding_accounts_status check (status in ('active', 'rejected')),
  -- What the read back found wrong. A rejected account stays on the row, so the
  -- principal cannot be sponsored a second one while someone looks at the first.
  faults text[] not null default '{}',
  created_at timestamptz not null default now(),
  -- Across the principal's projects, because reserves are budgeted per principal.
  constraint funding_accounts_one_per_principal unique (principal_id, network),
  -- Across every tenant. A deposit is attributed by the address it reached, so an
  -- address held by two tenants could credit the wrong one.
  constraint funding_accounts_address_once unique (network, address),
  constraint funding_accounts_tenant_key unique (principal_id, project_id, id),
  constraint funding_accounts_status_matches_faults
    check ((status = 'active') = (cardinality(faults) = 0)),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

-- Which mandate instance an account funds, through which funding source. The key
-- on the instance is what makes a retried confirmation safe. It lives here because
-- funding_sources is not new, and an index on it would hold that table's lock for
-- the whole migration run.
create table ujira.funding_account_sources (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  funding_account_id uuid not null,
  funding_source_id uuid not null,
  mandate_instance_id uuid not null,
  created_at timestamptz not null default now(),
  constraint funding_account_sources_one_per_instance unique (mandate_instance_id),
  constraint funding_account_sources_source_once unique (funding_source_id),
  constraint funding_account_sources_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, funding_account_id)
    references ujira.funding_accounts (principal_id, project_id, id),
  foreign key (principal_id, project_id, funding_source_id)
    references ujira.funding_sources (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id)
    references ujira.mandate_instances (principal_id, project_id, id)
);

create index funding_account_sources_by_account
  on ujira.funding_account_sources (principal_id, project_id, funding_account_id);

select ujira.apply_tenant_policies('ujira.funding_accounts');
select ujira.apply_tenant_policies('ujira.funding_account_sources');

-- No update and no delete: what was found on chain is a record, and fixing a
-- rejected account is a decision for a person, through the owner.
grant select, insert on ujira.funding_accounts, ujira.funding_account_sources to ujira_app;
grant select on ujira.funding_accounts, ujira.funding_account_sources to ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.funding_account_sources;
drop table ujira.funding_accounts;

reset role;
