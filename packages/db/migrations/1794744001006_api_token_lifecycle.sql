-- expand
-- What creating, rotating and warning about an API key needs: a name a person can
-- recognize, and a record of each expiry warning, so one is sent once.
--
-- A warning is claimed before it is sent and marked when it has gone. A claim left
-- unmarked by a process that died can be taken again after a while, so a warning
-- can repeat after a crash and is never lost to one.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- Null only on a key made before keys had names.
alter table ujira.api_tokens add column name text;
alter table ujira.api_tokens
  add constraint api_tokens_name_length check (char_length(name) between 1 and 100) not valid;

create table ujira.api_token_expiry_warnings (
  principal_id uuid not null,
  project_id uuid not null,
  token_id uuid not null,
  threshold_days bigint not null
    constraint api_token_expiry_warnings_threshold check (threshold_days in (7, 30)),
  claimed_at timestamptz not null default now(),
  notified_at timestamptz,
  primary key (principal_id, project_id, token_id, threshold_days),
  foreign key (principal_id, project_id, token_id)
    references ujira.api_tokens (principal_id, project_id, id)
);

select ujira.apply_tenant_policies('ujira.api_token_expiry_warnings');
create policy sweep on ujira.api_token_expiry_warnings for select to ujira_fn_tokens using (true);

grant select, insert, update (claimed_at, notified_at)
  on ujira.api_token_expiry_warnings to ujira_app;
grant select on ujira.api_token_expiry_warnings to ujira_reader;
grant select on ujira.api_token_expiry_warnings to ujira_fn_tokens;

-- The one read across tenants the sweep needs: which keys have a warning still to
-- send, and whose they are, so each is then handled under its own tenant. It says
-- nothing about a key but its id.
create function ujira.api_tokens_nearing_expiry(after_id uuid, max_rows integer)
  returns table (token_id uuid, principal_id uuid, project_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select t.id, t.principal_id, t.project_id
    from ujira.api_tokens as t
   where (after_id is null or t.id > after_id)
     and t.revoked_at is null
     and t.expires_at > now()
     and t.expires_at <= now() + interval '30 days'
     -- A rotated key is on its way out on purpose.
     and not exists (
       select 1
         from ujira.api_tokens as successor
        where successor.principal_id = t.principal_id
          and successor.project_id = t.project_id
          and successor.rotated_from_id = t.id
     )
     and not exists (
       select 1
         from ujira.api_token_expiry_warnings as w
        where w.principal_id = t.principal_id
          and w.project_id = t.project_id
          and w.token_id = t.id
          and w.notified_at is not null
          and w.threshold_days = case when t.expires_at <= now() + interval '7 days' then 7 else 30 end
     )
   order by t.id
   limit least(greatest(max_rows, 1), 1000)
$fn$;

revoke all on function ujira.api_tokens_nearing_expiry(uuid, integer) from public;
grant execute on function ujira.api_tokens_nearing_expiry(uuid, integer) to ujira_app;

-- Handing a function to another role needs that role to hold CREATE on the schema,
-- so it is granted for the handover only.
grant create on schema ujira to ujira_fn_tokens;
alter function ujira.api_tokens_nearing_expiry(uuid, integer) owner to ujira_fn_tokens;
revoke create on schema ujira from ujira_fn_tokens;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function ujira.api_tokens_nearing_expiry(uuid, integer);
drop table ujira.api_token_expiry_warnings;
alter table ujira.api_tokens drop constraint api_tokens_name_length;
alter table ujira.api_tokens drop column name;
