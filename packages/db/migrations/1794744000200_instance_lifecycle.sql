-- expand
-- Only the chain moves a mandate instance through its life. The event intake reads a
-- trusted factory's creation and the mandate's own pause, resume and revocation, and
-- the indexer's login is the one given the right to change an instance's status, and
-- only under the tenant whose instance it is. No login the API holds has it.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

grant update (status) on ujira.mandate_instances to ujira_indexer;

create policy indexer_lifecycle on ujira.mandate_instances for update to ujira_indexer
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id())
  with check (
    principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id()
  );

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop policy indexer_lifecycle on ujira.mandate_instances;
revoke update (status) on ujira.mandate_instances from ujira_indexer;

reset role;
