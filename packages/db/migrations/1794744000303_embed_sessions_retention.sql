-- expand
-- What the retention job may touch in embed sessions: rows 7 days past expiry, and of
-- those only the columns it needs to find them, never a token hash. A session a wallet
-- verification names stays, because that verification is permanent evidence and its
-- foreign key needs the row. Retention has no tenant context, so these policies are
-- what keep it safe.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create policy retention_read on ujira.destination_verifications for select to ujira_retention
  using (embed_session_id is not null);
grant select (principal_id, project_id, embed_session_id) on ujira.destination_verifications
  to ujira_retention;

create policy retention_read on ujira.embed_sessions for select to ujira_retention
  using (
    expires_at < now() - interval '7 days'
    and not exists (
      select from ujira.destination_verifications as v
       where v.principal_id = embed_sessions.principal_id
         and v.project_id = embed_sessions.project_id
         and v.embed_session_id = embed_sessions.id
    )
  );
create policy retention_delete on ujira.embed_sessions for delete to ujira_retention
  using (
    expires_at < now() - interval '7 days'
    and not exists (
      select from ujira.destination_verifications as v
       where v.principal_id = embed_sessions.principal_id
         and v.project_id = embed_sessions.project_id
         and v.embed_session_id = embed_sessions.id
    )
  );
grant select (principal_id, project_id, id, expires_at), delete on ujira.embed_sessions
  to ujira_retention;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

revoke select (principal_id, project_id, id, expires_at), delete on ujira.embed_sessions
  from ujira_retention;
drop policy retention_delete on ujira.embed_sessions;
drop policy retention_read on ujira.embed_sessions;
revoke select (principal_id, project_id, embed_session_id) on ujira.destination_verifications
  from ujira_retention;
drop policy retention_read on ujira.destination_verifications;

reset role;
