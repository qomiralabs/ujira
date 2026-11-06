-- expand
-- Buckets that have refilled completely can go. A missing bucket starts full, so
-- deleting a full one changes nothing a caller can see, and without this the table
-- grows with every distinct address that is ever limited. Whether a bucket is full
-- depends on the rule it was taken under, so each bucket now keeps its capacity and
-- refill, written by the same function that takes from it.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- Null on a bucket last taken from before this, until its next request records them.
alter table ops.rate_limit_buckets
  add column capacity bigint,
  add column refill_per_second bigint;

grant delete on ops.rate_limit_buckets to ujira_ops;

create or replace function ops.take_rate_limit_tokens(
  bucket_keys text[],
  capacities integer[],
  refills_per_second integer[]
)
  returns table (taken_key text, allowed boolean, remaining numeric)
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  all_allowed boolean := true;
  available numeric;
  wanted record;
begin
  if coalesce(cardinality(bucket_keys), 0) not between 1 and 8
     or cardinality(capacities) is distinct from cardinality(bucket_keys)
     or cardinality(refills_per_second) is distinct from cardinality(bucket_keys) then
    raise exception using
      errcode = '22023',
      message = 'from 1 to 8 buckets, each with a capacity and a refill rate';
  end if;
  for wanted in
    select u.key_text, u.capacity, u.refill
      from unnest(bucket_keys, capacities, refills_per_second) as u (key_text, capacity, refill)
     order by u.key_text
  loop
    if wanted.capacity is null or wanted.capacity < 1
       or wanted.refill is null or wanted.refill < 1 then
      raise exception using
        errcode = '22023',
        message = 'a bucket holds at least 1 token and refills at least 1 per second';
    end if;
    insert into ops.rate_limit_buckets as b
        (bucket_key, tokens, refilled_at, capacity, refill_per_second)
      values (wanted.key_text, wanted.capacity, clock_timestamp(), wanted.capacity, wanted.refill)
      on conflict (bucket_key) do update
        set tokens = least(
              wanted.capacity,
              b.tokens
                + greatest(extract(epoch from clock_timestamp() - b.refilled_at), 0) * wanted.refill
            ),
            refilled_at = greatest(clock_timestamp(), b.refilled_at),
            capacity = wanted.capacity,
            refill_per_second = wanted.refill
      returning b.tokens into available;
    all_allowed := all_allowed and available >= 1;
  end loop;
  if all_allowed then
    update ops.rate_limit_buckets as b
       set tokens = b.tokens - 1
     where b.bucket_key = any (bucket_keys);
  end if;
  return query
    select b.bucket_key, all_allowed, b.tokens
      from ops.rate_limit_buckets as b
     where b.bucket_key = any (bucket_keys);
end
$fn$;

-- Deletes up to max_rows buckets that are full now, and returns how many. A bucket a
-- request holds is skipped rather than waited on, so pruning never holds up the
-- limit. The lock re-reads the row, so one taken from since it was found is kept.
create function ops.prune_rate_limit_buckets(max_rows integer) returns integer
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  removed integer;
begin
  if max_rows is null or max_rows not between 1 and 10000 then
    raise exception using
      errcode = '22023',
      message = 'from 1 to 10000 buckets at a time';
  end if;
  with full_now as (
    select b.bucket_key
      from ops.rate_limit_buckets as b
     where b.capacity is not null
       and b.tokens
           + greatest(extract(epoch from clock_timestamp() - b.refilled_at), 0)
             * b.refill_per_second
           >= b.capacity
     limit max_rows
     for update skip locked
  )
  delete from ops.rate_limit_buckets as b
   using full_now
   where b.bucket_key = full_now.bucket_key;
  get diagnostics removed = row_count;
  return removed;
end
$fn$;

revoke execute on function ops.prune_rate_limit_buckets(integer) from public;
grant execute on function ops.prune_rate_limit_buckets(integer) to ujira_app;

grant create on schema ops to ujira_ops;
alter function ops.prune_rate_limit_buckets(integer) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ops.prune_rate_limit_buckets(integer);

create or replace function ops.take_rate_limit_tokens(
  bucket_keys text[],
  capacities integer[],
  refills_per_second integer[]
)
  returns table (taken_key text, allowed boolean, remaining numeric)
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  all_allowed boolean := true;
  available numeric;
  wanted record;
begin
  if coalesce(cardinality(bucket_keys), 0) not between 1 and 8
     or cardinality(capacities) is distinct from cardinality(bucket_keys)
     or cardinality(refills_per_second) is distinct from cardinality(bucket_keys) then
    raise exception using
      errcode = '22023',
      message = 'from 1 to 8 buckets, each with a capacity and a refill rate';
  end if;
  for wanted in
    select u.key_text, u.capacity, u.refill
      from unnest(bucket_keys, capacities, refills_per_second) as u (key_text, capacity, refill)
     order by u.key_text
  loop
    if wanted.capacity is null or wanted.capacity < 1
       or wanted.refill is null or wanted.refill < 1 then
      raise exception using
        errcode = '22023',
        message = 'a bucket holds at least 1 token and refills at least 1 per second';
    end if;
    insert into ops.rate_limit_buckets as b (bucket_key, tokens, refilled_at)
      values (wanted.key_text, wanted.capacity, clock_timestamp())
      on conflict (bucket_key) do update
        set tokens = least(
              wanted.capacity,
              b.tokens
                + greatest(extract(epoch from clock_timestamp() - b.refilled_at), 0) * wanted.refill
            ),
            refilled_at = greatest(clock_timestamp(), b.refilled_at)
      returning b.tokens into available;
    all_allowed := all_allowed and available >= 1;
  end loop;
  if all_allowed then
    update ops.rate_limit_buckets as b
       set tokens = b.tokens - 1
     where b.bucket_key = any (bucket_keys);
  end if;
  return query
    select b.bucket_key, all_allowed, b.tokens
      from ops.rate_limit_buckets as b
     where b.bucket_key = any (bucket_keys);
end
$fn$;

revoke delete on ops.rate_limit_buckets from ujira_ops;

alter table ops.rate_limit_buckets
  drop column refill_per_second,
  drop column capacity;

reset role;
