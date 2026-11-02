-- expand
-- no-transaction
-- What a payout booking points at, so a booking can never name a contract other
-- than its instance's. The table is live, so the index is built concurrently and
-- on its own.

-- Up Migration
create unique index concurrently if not exists mandate_instances_contract_key
  on ujira.mandate_instances (principal_id, project_id, id, chain, contract_address);

-- Down Migration
drop index concurrently if exists ujira.mandate_instances_contract_key;
