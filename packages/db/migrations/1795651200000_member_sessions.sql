-- expand
-- Dashboard sessions are opaque and held here, so this table is the authority: a
-- session resolves only while it is unexpired, unrevoked and backed by an active
-- membership. It belongs to a person rather than a tenant, since a person picks
-- which principal to act for after signing in, so nothing here can run under a
-- tenant context. Every read and write goes through a security definer function
-- owned by its own narrow role, and no service role can touch the table itself.
--
-- A session is found by the hash of its secret, so holding the secret is what lets
-- a caller act on it, and the secret itself is never stored.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is
-- never dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_fn_sessions') then
    create role ujira_fn_sessions nologin noinherit nobypassrls;
  end if;
  alter role ujira_fn_sessions nobypassrls;
end
$roles$;

grant ujira_fn_sessions to ujira_owner;

set local role ujira_owner;

-- Whether a member can act. Removing someone keeps the row, so what they did
-- still names them.
alter table ujira.principal_members
  add column status text not null default 'active'
    constraint principal_members_status check (status in ('invited', 'active', 'suspended', 'removed'));

create table ujira.member_sessions (
  id uuid primary key default gen_random_uuid(),
  secret_hash ujira.hash32 not null constraint member_sessions_secret_hash_key unique,
  -- The identity provider's subject for the person, never an email.
  auth_subject uuid not null,
  supabase_session_id text not null
    constraint member_sessions_supabase_length check (char_length(supabase_session_id) between 1 and 128),
  aal text not null constraint member_sessions_aal check (aal in ('aal1', 'aal2')),
  -- What the person has chosen to act for, once they have chosen.
  principal_id uuid references ujira.principals (id),
  project_id uuid,
  stepped_up_at timestamptz,
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
    constraint member_sessions_reason_format check (revoked_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- An HMAC the caller computed, so the same address shows up as the same value
  -- and the table cannot be read back into where anyone was.
  ip_hmac ujira.hash32,
  user_agent_family text
    constraint member_sessions_user_agent_format check (user_agent_family ~ '^[A-Za-z0-9 ._-]{1,32}$'),
  created_at timestamptz not null default now(),
  constraint member_sessions_project_scope
    foreign key (principal_id, project_id) references ujira.projects (principal_id, id),
  constraint member_sessions_project_needs_principal
    check (project_id is null or principal_id is not null),
  constraint member_sessions_idle_within_absolute check (idle_expires_at <= absolute_expires_at),
  constraint member_sessions_revocation_whole check ((revoked_at is null) = (revoked_reason is null))
);

create index member_sessions_subject on ujira.member_sessions (auth_subject);
create index member_sessions_retention on ujira.member_sessions (absolute_expires_at);
create index member_sessions_project_scope
  on ujira.member_sessions (principal_id, project_id) where principal_id is not null;

alter table ujira.member_sessions enable row level security;
alter table ujira.member_sessions force row level security;
create policy owner_all on ujira.member_sessions for all to ujira_owner using (true) with check (true);
create policy sessions_all on ujira.member_sessions for all to ujira_fn_sessions
  using (true) with check (true);
create policy sessions_read on ujira.principal_members for select to ujira_fn_sessions using (true);
create policy sessions_read on ujira.projects for select to ujira_fn_sessions using (true);

revoke all on ujira.member_sessions from public;
grant usage on schema ujira to ujira_fn_sessions;
grant usage on domain ujira.hash32 to ujira_fn_sessions;
grant select, insert, update, delete on ujira.member_sessions to ujira_fn_sessions;
grant select on ujira.principal_members, ujira.projects to ujira_fn_sessions;

-- The principals a person may act for. Never another person's: the caller names
-- the subject it already authenticated.
create function ujira.member_memberships(subject uuid)
  returns table (principal_id uuid, role text)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select m.principal_id, m.role
    from ujira.principal_members as m
   where m.user_id = subject and m.status = 'active'
   order by m.principal_id
$fn$;

create function ujira.session_create(
  session_secret_hash bytea,
  subject uuid,
  supabase_id text,
  assurance text,
  idle_seconds integer,
  absolute_seconds integer,
  client_ip_hmac bytea,
  client_user_agent_family text
) returns table (session_id uuid, idle_expires_at timestamptz, absolute_expires_at timestamptz)
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
begin
  if idle_seconds is null or idle_seconds < 1 or absolute_seconds is null or absolute_seconds < 1 then
    raise exception using errcode = '22023', message = 'a session lasts at least a second';
  end if;
  return query
    insert into ujira.member_sessions as s (
      secret_hash, auth_subject, supabase_session_id, aal, idle_expires_at, absolute_expires_at,
      ip_hmac, user_agent_family
    ) values (
      session_secret_hash, subject, supabase_id, assurance,
      now() + make_interval(secs => least(idle_seconds, absolute_seconds)),
      now() + make_interval(secs => absolute_seconds),
      client_ip_hmac, client_user_agent_family
    )
    returning s.id, s.idle_expires_at, s.absolute_expires_at;
end
$fn$;

-- The live session behind a secret, or no row. A session that has chosen a tenant
-- resolves only while the person can still act for it, so removing someone ends
-- their access on their next request and not when the session lapses.
create function ujira.session_resolve(session_secret_hash bytea)
  returns table (
    session_id uuid,
    auth_subject uuid,
    supabase_session_id text,
    aal text,
    principal_id uuid,
    project_id uuid,
    member_role text,
    stepped_up_at timestamptz,
    idle_expires_at timestamptz,
    absolute_expires_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select s.id, s.auth_subject, s.supabase_session_id, s.aal, s.principal_id, s.project_id, m.role,
         s.stepped_up_at, s.idle_expires_at, s.absolute_expires_at
    from ujira.member_sessions as s
    left join ujira.principal_members as m
      on m.principal_id = s.principal_id and m.user_id = s.auth_subject and m.status = 'active'
   where s.secret_hash = session_secret_hash::ujira.hash32
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.absolute_expires_at > now()
     and (s.principal_id is null or m.user_id is not null)
$fn$;

-- Chooses what the session acts for. False when the session is not live, the
-- person is not an active member of the principal, or the project is not that
-- principal's, so a session can never point at a tenant it has no right to.
create function ujira.session_select(
  session_secret_hash bytea,
  selected_principal uuid,
  selected_project uuid
) returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  changed integer;
begin
  update ujira.member_sessions as s
     set principal_id = selected_principal, project_id = selected_project
   where s.secret_hash = session_secret_hash::ujira.hash32
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.absolute_expires_at > now()
     and exists (
       select from ujira.principal_members as m
        where m.principal_id = selected_principal
          and m.user_id = s.auth_subject
          and m.status = 'active'
     )
     and (
       selected_project is null
       or exists (
         select from ujira.projects as p
          where p.principal_id = selected_principal and p.id = selected_project
       )
     );
  get diagnostics changed = row_count;
  return changed = 1;
end
$fn$;

-- Extends a live session's idle window, never past its absolute expiry, and
-- never brings a lapsed one back. Null when there is nothing to extend.
create function ujira.session_touch(session_secret_hash bytea, idle_seconds integer)
  returns timestamptz
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  extended timestamptz;
begin
  if idle_seconds is null or idle_seconds < 1 then
    raise exception using errcode = '22023', message = 'a session lasts at least a second';
  end if;
  update ujira.member_sessions as s
     set idle_expires_at = least(now() + make_interval(secs => idle_seconds), s.absolute_expires_at)
   where s.secret_hash = session_secret_hash::ujira.hash32
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.absolute_expires_at > now()
  returning s.idle_expires_at into extended;
  return extended;
end
$fn$;

-- Records that the person just proved themselves again. The time comes from the
-- server, so a caller cannot date a step up.
create function ujira.session_step_up(session_secret_hash bytea, assurance text)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  changed integer;
begin
  update ujira.member_sessions as s
     set aal = assurance, stepped_up_at = now()
   where s.secret_hash = session_secret_hash::ujira.hash32
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.absolute_expires_at > now();
  get diagnostics changed = row_count;
  return changed = 1;
end
$fn$;

create function ujira.session_revoke(session_secret_hash bytea, reason text)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  changed integer;
begin
  update ujira.member_sessions as s
     set revoked_at = now(), revoked_reason = reason
   where s.secret_hash = session_secret_hash::ujira.hash32 and s.revoked_at is null;
  get diagnostics changed = row_count;
  return changed = 1;
end
$fn$;

-- Ends every session a person has, for a password change or a compromise.
create function ujira.session_revoke_subject(subject uuid, reason text)
  returns bigint
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  changed bigint;
begin
  update ujira.member_sessions as s
     set revoked_at = now(), revoked_reason = reason
   where s.auth_subject = subject and s.revoked_at is null;
  get diagnostics changed = row_count;
  return changed;
end
$fn$;

-- Removes one batch of sessions 30 days past their expiry or revocation, and says
-- how many, so a job can keep calling until none are left without one long delete
-- holding locks.
create function ujira.session_delete_expired(batch_size integer)
  returns bigint
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  removed bigint;
begin
  if batch_size is null or batch_size < 1 or batch_size > 10000 then
    raise exception using errcode = '22023', message = 'a batch is from 1 to 10000 rows';
  end if;
  delete from ujira.member_sessions as s
   where s.id in (
     select c.id
       from ujira.member_sessions as c
      where least(c.revoked_at, c.idle_expires_at, c.absolute_expires_at) < now() - interval '30 days'
      order by c.absolute_expires_at
      limit batch_size
   );
  get diagnostics removed = row_count;
  return removed;
end
$fn$;

revoke all on function ujira.member_memberships(uuid) from public;
revoke all on function ujira.session_create(bytea, uuid, text, text, integer, integer, bytea, text) from public;
revoke all on function ujira.session_resolve(bytea) from public;
revoke all on function ujira.session_select(bytea, uuid, uuid) from public;
revoke all on function ujira.session_touch(bytea, integer) from public;
revoke all on function ujira.session_step_up(bytea, text) from public;
revoke all on function ujira.session_revoke(bytea, text) from public;
revoke all on function ujira.session_revoke_subject(uuid, text) from public;
revoke all on function ujira.session_delete_expired(integer) from public;

grant execute on function ujira.member_memberships(uuid) to ujira_app, ujira_auth;
grant execute on function ujira.session_create(bytea, uuid, text, text, integer, integer, bytea, text)
  to ujira_app, ujira_auth;
grant execute on function ujira.session_resolve(bytea) to ujira_app, ujira_auth;
grant execute on function ujira.session_select(bytea, uuid, uuid) to ujira_app, ujira_auth;
grant execute on function ujira.session_touch(bytea, integer) to ujira_app, ujira_auth;
grant execute on function ujira.session_step_up(bytea, text) to ujira_app, ujira_auth;
grant execute on function ujira.session_revoke(bytea, text) to ujira_app, ujira_auth;
grant execute on function ujira.session_revoke_subject(uuid, text) to ujira_app, ujira_auth;
grant execute on function ujira.session_delete_expired(integer) to ujira_retention;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ujira to ujira_fn_sessions;
alter function ujira.member_memberships(uuid) owner to ujira_fn_sessions;
alter function ujira.session_create(bytea, uuid, text, text, integer, integer, bytea, text)
  owner to ujira_fn_sessions;
alter function ujira.session_resolve(bytea) owner to ujira_fn_sessions;
alter function ujira.session_select(bytea, uuid, uuid) owner to ujira_fn_sessions;
alter function ujira.session_touch(bytea, integer) owner to ujira_fn_sessions;
alter function ujira.session_step_up(bytea, text) owner to ujira_fn_sessions;
alter function ujira.session_revoke(bytea, text) owner to ujira_fn_sessions;
alter function ujira.session_revoke_subject(uuid, text) owner to ujira_fn_sessions;
alter function ujira.session_delete_expired(integer) owner to ujira_fn_sessions;
revoke create on schema ujira from ujira_fn_sessions;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.session_delete_expired(integer);
drop function ujira.session_revoke_subject(uuid, text);
drop function ujira.session_revoke(bytea, text);
drop function ujira.session_step_up(bytea, text);
drop function ujira.session_touch(bytea, integer);
drop function ujira.session_select(bytea, uuid, uuid);
drop function ujira.session_resolve(bytea);
drop function ujira.session_create(bytea, uuid, text, text, integer, integer, bytea, text);
drop function ujira.member_memberships(uuid);

revoke select on ujira.principal_members, ujira.projects from ujira_fn_sessions;
drop policy sessions_read on ujira.projects;
drop policy sessions_read on ujira.principal_members;
drop table ujira.member_sessions;
alter table ujira.principal_members drop column status;

revoke usage on domain ujira.hash32 from ujira_fn_sessions;
revoke usage on schema ujira from ujira_fn_sessions;

reset role;

revoke ujira_fn_sessions from ujira_owner;
