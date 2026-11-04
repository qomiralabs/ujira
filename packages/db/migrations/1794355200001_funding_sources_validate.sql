-- expand
-- no-transaction
-- Checks the rows already in ujira.funding_sources against the two constraints
-- the previous migration added, in a transaction of its own, so the scan takes
-- only a lock that lets traffic through.
--
-- One block because a no-transaction migration sends one statement, and the
-- role and timeouts have to be set inside it: the migration login does not
-- inherit the owner's rights, so a bare alter table would be refused.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.funding_sources validate constraint funding_sources_kind;
  alter table ujira.funding_sources validate constraint funding_sources_config_shape;
end
$validate$;

-- Down Migration
do $unvalidate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.funding_sources drop constraint funding_sources_kind;
  alter table ujira.funding_sources
    add constraint funding_sources_kind
      check (kind in ('stablecoin_deposit', 'stellar_funding_account')) not valid;
  alter table ujira.funding_sources drop constraint funding_sources_config_shape;
  alter table ujira.funding_sources
    add constraint funding_sources_config_shape check (
      case
        when kind <> 'stellar_funding_account' then config = '{}'::jsonb
        when jsonb_typeof(config) <> 'object' then false
        else coalesce(
          config - 'sponsored_reserves' - 'sponsor_tx_hash' = '{}'::jsonb
            and config -> 'sponsored_reserves' = 'true'::jsonb
            and jsonb_typeof(config -> 'sponsor_tx_hash') = 'string'
            and config ->> 'sponsor_tx_hash' ~ '^[0-9a-f]{64}$',
          false
        )
      end
    ) not valid;
end
$unvalidate$;
