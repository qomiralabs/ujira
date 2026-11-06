-- contract
-- no-transaction
-- Checks the rows already in ujira.mandate_instances against the check the expand
-- half added, in a transaction of its own, so the scan takes only a lock that lets
-- traffic through.
--
-- One block because a no-transaction migration sends one statement, and the role
-- and timeouts have to be set inside it.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.mandate_instances validate constraint mandate_instances_network_on_chain;
end
$validate$;

-- Down Migration
do $unvalidate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.mandate_instances drop constraint mandate_instances_network_on_chain;
  alter table ujira.mandate_instances
    add constraint mandate_instances_network_on_chain
      check (network is null or split_part(network, ':', 1) = chain) not valid;
end
$unvalidate$;
