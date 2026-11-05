-- expand
-- no-transaction
-- A forwarding account belongs to a project, so a principal with two projects can
-- have two, and a deposit is credited to the project that holds the account it reached.
-- Added before the key it replaces is dropped, so there is never a moment with neither.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
-- squawk-ignore require-lock-timeout, require-statement-timeout
create unique index concurrently if not exists funding_accounts_one_per_project
  on ujira.funding_accounts (principal_id, project_id, network);

-- Down Migration
drop index concurrently if exists ujira.funding_accounts_one_per_project;
