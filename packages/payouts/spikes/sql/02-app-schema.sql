-- Runs as ujira_migrator. A cut down tenant table shape: forced row level
-- security driven by transaction local settings.
set role ujira_owner;
create schema ujira authorization ujira_owner;

create function ujira.current_principal_id() returns uuid language plpgsql stable as $$
declare v text := current_setting('ujira.principal_id', true);
begin
  if v is null or v = '' then
    raise exception using errcode = 'UJ001', message = 'tenant context missing';
  end if;
  return v::uuid;
end $$;

create function ujira.current_project_id() returns uuid language plpgsql stable as $$
declare v text := current_setting('ujira.project_id', true);
begin
  if v is null or v = '' then
    raise exception using errcode = 'UJ001', message = 'tenant context missing';
  end if;
  return case when v = 'all' then null else v::uuid end;
end $$;

create table ujira.payouts (
  principal_id uuid not null,
  project_id   uuid not null,
  id           uuid not null default gen_random_uuid(),
  status       text not null default 'queued' check (status in ('queued', 'submitted')),
  tx_ref       text,
  primary key (principal_id, project_id, id)
);

alter table ujira.payouts enable row level security;
alter table ujira.payouts force row level security;
create policy tenant_read on ujira.payouts for select to ujira_app
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy tenant_insert on ujira.payouts for insert to ujira_app
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy tenant_update on ujira.payouts for update to ujira_app
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id())
  with check (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());
create policy owner_all on ujira.payouts for all to ujira_owner using (true) with check (true);

grant usage on schema ujira to ujira_app;
grant select, insert on ujira.payouts to ujira_app;
grant update (status, tx_ref) on ujira.payouts to ujira_app;
reset role;
