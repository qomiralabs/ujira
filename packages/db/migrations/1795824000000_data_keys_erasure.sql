-- expand
-- Recipients have the right to erasure, and financial records must be kept. Each
-- recipient's personal data is encrypted with its own data key, so erasing the key
-- makes the data unreadable while every financial row stays as it was.
--
-- A shredded key leaves its row behind as a tombstone, so nothing can quietly give
-- an erased recipient a new key. The log holds ids and nothing else.
--
-- A restore from before an erasure brings the key and the data back, and the log
-- with them, so replay takes its list of erased subjects from outside the backup.
-- Both functions below run as their own narrow role, because replay reaches across
-- tenants: it runs before traffic is admitted, with no tenant to scope it to.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is
-- never dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_fn_erasure') then
    create role ujira_fn_erasure nologin noinherit nobypassrls;
  end if;
  alter role ujira_fn_erasure nobypassrls;
end
$roles$;

grant ujira_fn_erasure to ujira_owner;

set local role ujira_owner;

create table ujira.data_keys (
  principal_id uuid not null,
  project_id uuid not null,
  -- The recipient this key encrypts for.
  subject_id uuid not null,
  wrapped_key bytea,
  kek_id text
    constraint data_keys_kek_id_length check (char_length(kek_id) between 1 and 128),
  schema_version bigint not null default 1
    constraint data_keys_schema_version_range check (schema_version between 1 and 1000),
  created_at timestamptz not null default now(),
  shredded_at timestamptz,
  -- A key is whole and live, or gone with the time it went.
  constraint data_keys_whole check (
    (wrapped_key is not null and kek_id is not null and shredded_at is null)
    or (wrapped_key is null and kek_id is null and shredded_at is not null)
  ),
  primary key (principal_id, project_id, subject_id),
  foreign key (principal_id, project_id, subject_id)
    references ujira.recipients (principal_id, project_id, id)
);

create table ujira.erasure_log (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  -- The two rows of one erasure share this.
  erasure_id uuid not null,
  subject_id uuid not null,
  event text not null
    constraint erasure_log_event check (event in ('requested', 'completed')),
  occurred_at timestamptz not null default now(),
  constraint erasure_log_once unique (principal_id, project_id, erasure_id, event),
  foreign key (principal_id, project_id, subject_id)
    references ujira.recipients (principal_id, project_id, id)
);

create index erasure_log_by_subject on ujira.erasure_log (principal_id, project_id, subject_id);

-- Keeps export in a stable order however long the log gets.
create index erasure_log_completed on ujira.erasure_log (id) where event = 'completed';

-- Erased stays erased. Each of these is what would otherwise let personal data back
-- in after the fact, by a retry or a job that started before the erasure.
create function ujira.data_key_stays_shredded() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if old.shredded_at is not null and new.shredded_at is null then
    raise exception using errcode = 'UJ018', message = 'a shredded data key stays shredded';
  end if;
  return new;
end
$fn$;

create function ujira.recipient_stays_erased() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if old.status = 'erased' and new.status <> 'erased' then
    raise exception using errcode = 'UJ018', message = 'an erased recipient stays erased';
  end if;
  return new;
end
$fn$;

create function ujira.refuse_personal_data_after_erasure() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if exists (
    select 1
      from ujira.recipients as r
     where r.principal_id = new.principal_id
       and r.project_id = new.project_id
       and r.id = new.recipient_id
       and r.status = 'erased'
  ) then
    raise exception using errcode = 'UJ018', message = 'this recipient has been erased';
  end if;
  return new;
end
$fn$;

create trigger data_keys_stay_shredded before update on ujira.data_keys
  for each row execute function ujira.data_key_stays_shredded();
create trigger data_keys_no_delete before delete on ujira.data_keys
  for each row execute function ujira.forbid_mutation();
create trigger data_keys_no_truncate before truncate on ujira.data_keys
  for each statement execute function ujira.forbid_mutation();
create trigger erasure_log_append_only before update or delete on ujira.erasure_log
  for each row execute function ujira.forbid_mutation();
create trigger erasure_log_no_truncate before truncate on ujira.erasure_log
  for each statement execute function ujira.forbid_mutation();
create trigger recipients_stay_erased before update on ujira.recipients
  for each row execute function ujira.recipient_stays_erased();
create trigger recipient_pii_not_erased before insert or update on ujira.recipient_pii
  for each row execute function ujira.refuse_personal_data_after_erasure();
create trigger payout_methods_details_not_erased before insert or update on ujira.payout_methods
  for each row
  when (new.details_ciphertext is not null)
  execute function ujira.refuse_personal_data_after_erasure();

select ujira.apply_tenant_policies('ujira.data_keys');
select ujira.apply_tenant_policies('ujira.erasure_log');

create policy tenant_delete on ujira.recipient_pii for delete to ujira_app
  using (principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id());

-- The reader has none of this: a dashboard has no use for a wrapped key, and the
-- log is for operators.
grant select, insert on ujira.data_keys to ujira_app;
grant update (wrapped_key, kek_id, shredded_at) on ujira.data_keys to ujira_app;
grant select, insert on ujira.erasure_log to ujira_app;
grant delete on ujira.recipient_pii to ujira_app;

-- Every completed erasure this database knows of, in a stable order, a page at a
-- time. Ids and a time, which is all that may leave the database for safe keeping.
create function ujira.erased_subjects(after_id uuid, page_size bigint)
  returns table (
    id uuid,
    principal_id uuid,
    project_id uuid,
    subject_id uuid,
    occurred_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select l.id, l.principal_id, l.project_id, l.subject_id, l.occurred_at
    from ujira.erasure_log as l
   where l.event = 'completed'
     and (after_id is null or l.id > after_id)
   order by l.id
   limit least(page_size, 10000)
$fn$;

-- Makes one erasure true again after a restore. True when something had to change,
-- so a second run reports nothing. A recipient the restored database never had is
-- nothing to erase. When the restored log has lost the erasure it records it again,
-- so a later export does not lose it a second time.
create function ujira.replay_erasure(target_principal uuid, target_project uuid, target_subject uuid)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  changed boolean := false;
  touched bigint;
  new_erasure uuid := gen_random_uuid();
begin
  perform 1
    from ujira.recipients as r
   where r.principal_id = target_principal
     and r.project_id = target_project
     and r.id = target_subject
   for update;
  if not found then
    return false;
  end if;

  update ujira.data_keys as k
     set wrapped_key = null, kek_id = null, shredded_at = now()
   where k.principal_id = target_principal
     and k.project_id = target_project
     and k.subject_id = target_subject
     and k.shredded_at is null;
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  insert into ujira.data_keys (principal_id, project_id, subject_id, shredded_at)
    values (target_principal, target_project, target_subject, now())
    on conflict (principal_id, project_id, subject_id) do nothing;
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  delete from ujira.recipient_pii as p
   where p.principal_id = target_principal
     and p.project_id = target_project
     and p.recipient_id = target_subject;
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  update ujira.payout_methods as m
     set details_ciphertext = null, details_nonce = null
   where m.principal_id = target_principal
     and m.project_id = target_project
     and m.recipient_id = target_subject
     and m.details_ciphertext is not null;
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  -- As recipientIdentities.erase does, because a restore brings these back too.
  update ujira.recipient_identities as i
     set state = 'revoked',
         provider_ref = null,
         provider_subject = null,
         nullifier_hmac = null,
         pending_session_id = null,
         pending_session_url = null,
         pending_session_expires_at = null
   where i.principal_id = target_principal
     and i.project_id = target_project
     and i.recipient_id = target_subject
     and (
       i.state <> 'revoked'
       or i.provider_ref is not null
       or i.provider_subject is not null
       or i.nullifier_hmac is not null
       or i.pending_session_id is not null
       or i.pending_session_url is not null
       or i.pending_session_expires_at is not null
     );
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  update ujira.recipients as r
     set status = 'erased'
   where r.principal_id = target_principal
     and r.project_id = target_project
     and r.id = target_subject
     and r.status <> 'erased';
  get diagnostics touched = row_count;
  changed := changed or touched > 0;

  if not exists (
    select 1
      from ujira.erasure_log as l
     where l.principal_id = target_principal
       and l.project_id = target_project
       and l.subject_id = target_subject
       and l.event = 'completed'
  ) then
    insert into ujira.erasure_log (principal_id, project_id, erasure_id, subject_id, event)
      values
        (target_principal, target_project, new_erasure, target_subject, 'requested'),
        (target_principal, target_project, new_erasure, target_subject, 'completed');
    changed := true;
  end if;
  return changed;
end
$fn$;

-- Each right below is one thing replay_erasure or erased_subjects does, and no more.
create policy erasure_all on ujira.data_keys for all to ujira_fn_erasure
  using (true) with check (true);
create policy erasure_all on ujira.erasure_log for all to ujira_fn_erasure
  using (true) with check (true);
create policy erasure_all on ujira.recipient_pii for all to ujira_fn_erasure
  using (true) with check (true);
create policy erasure_all on ujira.payout_methods for all to ujira_fn_erasure
  using (true) with check (true);
create policy erasure_all on ujira.recipients for all to ujira_fn_erasure
  using (true) with check (true);
create policy erasure_all on ujira.recipient_identities for all to ujira_fn_erasure
  using (true) with check (true);

grant usage on schema ujira to ujira_fn_erasure;
grant select, insert, update on ujira.data_keys to ujira_fn_erasure;
grant select, insert on ujira.erasure_log to ujira_fn_erasure;
grant select, delete on ujira.recipient_pii to ujira_fn_erasure;
grant select, update on ujira.payout_methods to ujira_fn_erasure;
grant select, update on ujira.recipients to ujira_fn_erasure;
grant select, update on ujira.recipient_identities to ujira_fn_erasure;

grant usage on schema ujira to ujira_ops;
grant execute on function ujira.erased_subjects(uuid, bigint) to ujira_ops;
grant execute on function ujira.replay_erasure(uuid, uuid, uuid) to ujira_ops;

grant create on schema ujira to ujira_fn_erasure;
alter function ujira.erased_subjects(uuid, bigint) owner to ujira_fn_erasure;
alter function ujira.replay_erasure(uuid, uuid, uuid) owner to ujira_fn_erasure;
revoke create on schema ujira from ujira_fn_erasure;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function ujira.replay_erasure(uuid, uuid, uuid);
drop function ujira.erased_subjects(uuid, bigint);
drop policy erasure_all on ujira.recipient_identities;
drop policy erasure_all on ujira.recipients;
drop policy erasure_all on ujira.payout_methods;
drop policy erasure_all on ujira.recipient_pii;
drop policy tenant_delete on ujira.recipient_pii;
drop trigger payout_methods_details_not_erased on ujira.payout_methods;
drop trigger recipient_pii_not_erased on ujira.recipient_pii;
drop trigger recipients_stay_erased on ujira.recipients;
drop table ujira.erasure_log;
drop table ujira.data_keys;
drop function ujira.refuse_personal_data_after_erasure();
drop function ujira.recipient_stays_erased();
drop function ujira.data_key_stays_shredded();
revoke select, update on ujira.recipient_identities from ujira_fn_erasure;
revoke select, update on ujira.recipients from ujira_fn_erasure;
revoke select, update on ujira.payout_methods from ujira_fn_erasure;
revoke select, delete on ujira.recipient_pii from ujira_fn_erasure;
revoke delete on ujira.recipient_pii from ujira_app;
revoke usage on schema ujira from ujira_ops;
revoke usage on schema ujira from ujira_fn_erasure;
revoke ujira_fn_erasure from ujira_owner;
