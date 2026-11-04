-- expand
-- Roles below admin see only the projects listed for them, a linked wallet shows
-- which person approved, and an invitation is single use and bound to a hashed
-- secret, so a leaked database cannot be used to accept one.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.principal_members
  add column invite_secret_hash ujira.hash32,
  add column invite_expires_at timestamptz,
  add column invited_by uuid;

-- Validated by a later migration, on its own, so this holds no long lock.
alter table ujira.principal_members
  add constraint principal_members_invite_whole check (
    (status = 'invited'
      and invite_secret_hash is not null and invite_expires_at is not null and invited_by is not null)
    or (status <> 'invited'
      and invite_secret_hash is null and invite_expires_at is null and invited_by is null)
  ) not valid;

-- The projects a member below admin may see. An owner or admin sees them all and
-- needs no row here.
create table ujira.principal_member_projects (
  principal_id uuid not null,
  project_id uuid not null,
  user_id uuid not null,
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (principal_id, project_id, user_id),
  constraint principal_member_projects_project
    foreign key (principal_id, project_id) references ujira.projects (principal_id, id),
  constraint principal_member_projects_member
    foreign key (principal_id, user_id) references ujira.principal_members (principal_id, user_id)
);

create index principal_member_projects_member
  on ujira.principal_member_projects (principal_id, user_id);

select ujira.apply_tenant_policies('ujira.principal_member_projects');
create policy tenant_delete on ujira.principal_member_projects for delete to ujira_app
  using (
    principal_id = ujira.current_principal_id()
    and project_id = ujira.current_project_id()
    and not ujira.project_scope_all()
  );

-- A wallet belongs to one person at a time, across a principal, so an approval it
-- signed names exactly one of them. Removing a link keeps the row, so what the
-- wallet approved while linked can still be traced.
create table ujira.member_wallets (
  principal_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  network text not null
    constraint member_wallets_network_format check (network ~ '^[a-z0-9-]{1,32}:[A-Za-z0-9_-]{1,64}$'),
  address text not null
    constraint member_wallets_address_length check (char_length(address) between 1 and 128),
  verified_at timestamptz not null,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint member_wallets_member
    foreign key (principal_id, user_id) references ujira.principal_members (principal_id, user_id)
);

create unique index member_wallets_one_live_link
  on ujira.member_wallets (principal_id, network, address) where removed_at is null;
create index member_wallets_member on ujira.member_wallets (principal_id, user_id);

alter table ujira.member_wallets enable row level security;
alter table ujira.member_wallets force row level security;
create policy tenant_read on ujira.member_wallets for select to ujira_app, ujira_reader
  using (principal_id = ujira.current_principal_id());
create policy tenant_insert on ujira.member_wallets for insert to ujira_app
  with check (principal_id = ujira.current_principal_id() and not ujira.project_scope_all());
create policy tenant_update on ujira.member_wallets for update to ujira_app
  using (principal_id = ujira.current_principal_id() and not ujira.project_scope_all())
  with check (principal_id = ujira.current_principal_id() and not ujira.project_scope_all());
-- Only for erasing a member. A link that merely ends is marked removed instead.
create policy tenant_delete on ujira.member_wallets for delete to ujira_app
  using (principal_id = ujira.current_principal_id() and not ujira.project_scope_all());
create policy owner_all on ujira.member_wallets for all to ujira_owner using (true) with check (true);

grant select, insert, update, delete on ujira.principal_member_projects, ujira.member_wallets
  to ujira_app;
grant select on ujira.principal_member_projects, ujira.member_wallets to ujira_reader;

-- Sessions now honour the project list.
create policy sessions_read on ujira.principal_member_projects for select to ujira_fn_sessions
  using (true);
grant select on ujira.principal_member_projects to ujira_fn_sessions;

create or replace function ujira.session_resolve(session_secret_hash bytea)
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
     and (
       s.project_id is null
       or m.role in ('owner', 'admin')
       or exists (
         select from ujira.principal_member_projects as a
          where a.principal_id = s.principal_id
            and a.project_id = s.project_id
            and a.user_id = s.auth_subject
       )
     )
$fn$;

create or replace function ujira.session_select(
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
          and (
            selected_project is null
            or (
              exists (
                select from ujira.projects as p
                 where p.principal_id = selected_principal and p.id = selected_project
              )
              and (
                m.role in ('owner', 'admin')
                or exists (
                  select from ujira.principal_member_projects as a
                   where a.principal_id = selected_principal
                     and a.project_id = selected_project
                     and a.user_id = s.auth_subject
                )
              )
            )
          )
     );
  get diagnostics changed = row_count;
  return changed = 1;
end
$fn$;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create or replace function ujira.session_resolve(session_secret_hash bytea)
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

create or replace function ujira.session_select(
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

drop table ujira.member_wallets;
drop table ujira.principal_member_projects;
alter table ujira.principal_members
  drop constraint principal_members_invite_whole,
  drop column invited_by,
  drop column invite_expires_at,
  drop column invite_secret_hash;

reset role;
