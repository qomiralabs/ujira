-- expand
-- Rotation lineage on API tokens, and the buckets behind the API rate limits.
--
-- The buckets are unlogged because a rate limit counter is worth nothing after
-- a crash: the worst a lost row does is hand back a full bucket, and every
-- request writes one, so it stays out of the WAL. They live in ops and hold no
-- customer data, so a key is a digest of what is being limited, and the format
-- check refuses anything else, a raw id included.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.api_tokens add column rotated_from_id uuid;

-- Both tenant columns are in the key, so a token can only descend from a token
-- of its own project. Checked against existing rows by a later migration, so
-- adding it here takes no scan.
alter table ujira.api_tokens
  add constraint api_tokens_rotated_from_fkey
    foreign key (principal_id, project_id, rotated_from_id)
    references ujira.api_tokens (principal_id, project_id, id)
    not valid;

create unlogged table ops.rate_limit_buckets (
  bucket_key text primary key
    constraint rate_limit_buckets_key_format check (bucket_key ~ '^[a-z_]{1,32}:[0-9a-f]{64}$'),
  -- Fractional, because a bucket refills between requests.
  tokens numeric(18, 6) not null
    constraint rate_limit_buckets_tokens_not_negative check (tokens >= 0),
  refilled_at timestamptz not null
);

grant select, insert, update on ops.rate_limit_buckets to ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ops.rate_limit_buckets;
alter table ujira.api_tokens drop constraint api_tokens_rotated_from_fkey;
alter table ujira.api_tokens drop column rotated_from_id;

reset role;
