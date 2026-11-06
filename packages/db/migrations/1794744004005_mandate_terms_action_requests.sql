-- expand
-- What a principal agreed when a mandate was created, and every signing request
-- UJIRA has handed out for one.
--
-- The chain holds the limits in token units and only a hash of the country list,
-- so the logical dollar limits and the agreed rate live here. The list itself is
-- on the mandate, which is where the attester checks a recipient against it.
--
-- Both unique keys carry the request's Idempotency-Key, which is what stops a
-- second run from doing the work twice. The HTTP record alone cannot: when a
-- process dies mid request its lease runs out and a retry runs the handler again.
-- A retry then finds these rows and hands back the mandate and the signing
-- requests it already made.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ujira.mandate_terms (
  principal_id uuid not null,
  project_id uuid not null,
  mandate_id uuid primary key,
  creation_key text not null
    constraint mandate_terms_creation_key_format check (creation_key ~ '^[A-Za-z0-9_.:-]{1,255}$'),
  recipient_mode text not null
    constraint mandate_terms_recipient_mode check (recipient_mode in ('allowlist', 'attested', 'both')),
  total_budget ujira.amount not null,
  per_payment_cap ujira.amount not null,
  per_recipient_daily_cap ujira.amount not null,
  approval_threshold ujira.amount not null,
  currency text not null,
  scale ujira.scale not null,
  country_policy_hash ujira.hash32 not null,
  max_fee_bps bigint not null
    constraint mandate_terms_max_fee_range check (max_fee_bps between 0 and 100),
  agreed_fee_bps bigint not null
    constraint mandate_terms_agreed_fee_range check (agreed_fee_bps between 0 and 100),
  payout_ttl_seconds bigint not null
    constraint mandate_terms_payout_ttl_range check (payout_ttl_seconds between 3600 and 2592000),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint mandate_terms_creation_once unique (principal_id, project_id, creation_key),
  foreign key (principal_id, project_id, mandate_id)
    references ujira.mandates (principal_id, project_id, id),
  foreign key (currency, scale) references ujira.currency_scales (currency, scale)
);

-- One row per instance per request. A signing request holds public addresses and
-- amounts, and only what the signer already sees. The create row also holds the
-- plan, which is all there is to show for an instance until its event is read.
create table ujira.mandate_action_requests (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_id uuid not null,
  mandate_instance_id uuid not null,
  op text not null
    constraint mandate_action_requests_op
      check (op in ('create', 'lower_fee_cap', 'revoke', 'withdraw', 'cancel_principal_proposal')),
  idempotency_key text not null
    constraint mandate_action_requests_key_format check (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,255}$'),
  signing_request jsonb not null,
  instance_plan jsonb,
  created_at timestamptz not null default now(),
  constraint mandate_action_requests_once
    unique (principal_id, project_id, idempotency_key, mandate_instance_id),
  constraint mandate_action_requests_plan_on_create check ((op = 'create') = (instance_plan is not null)),
  foreign key (principal_id, project_id, mandate_id)
    references ujira.mandates (principal_id, project_id, id),
  foreign key (principal_id, project_id, mandate_instance_id)
    references ujira.mandate_instances (principal_id, project_id, id)
);

create index mandate_action_requests_by_mandate
  on ujira.mandate_action_requests (principal_id, project_id, mandate_id, op);

select ujira.apply_tenant_policies('ujira.mandate_terms');
select ujira.apply_tenant_policies('ujira.mandate_action_requests');

-- Insert and read only: neither what was agreed nor what was handed out changes.
grant select, insert on ujira.mandate_terms to ujira_app;
grant select on ujira.mandate_terms to ujira_reader;
grant select, insert on ujira.mandate_action_requests to ujira_app;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.mandate_action_requests;
drop table ujira.mandate_terms;

reset role;
