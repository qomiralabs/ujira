-- expand
-- The attester signer must not sign anything the identity service has not
-- recorded first. This narrow function is how it asks: it answers whether a
-- pending attestation with this digest exists, and for which tenant, so both
-- sides must agree before a signature is produced.
--
-- The attestation log does not exist yet, so for now the function returns no
-- rows, and the signer refuses everything. When the log lands, the function
-- is replaced to read it.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so they are created only if missing and are
-- never dropped by the down section. The login's password is set outside
-- migrations.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_signer_read') then
    create role ujira_signer_read nologin noinherit nobypassrls;
  end if;
  alter role ujira_signer_read nobypassrls;
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_signer_attester') then
    create role ujira_signer_attester login noinherit nobypassrls;
  end if;
  alter role ujira_signer_attester nobypassrls;
end
$roles$;

alter role ujira_signer_attester set statement_timeout = '5s';
alter role ujira_signer_attester set lock_timeout = '3s';
alter role ujira_signer_attester set idle_in_transaction_session_timeout = '10s';

-- The owner hands the function to this role, which needs the owner to be able
-- to act as it.
grant ujira_signer_read to ujira_owner;

set local role ujira_owner;

grant usage on schema ujira to ujira_signer_read, ujira_signer_attester;

create function ujira.attestation_pending(p_digest bytea)
  returns table (principal_id uuid, project_id uuid, attestation_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select null::uuid, null::uuid, null::uuid where false and p_digest is not null
$fn$;

grant execute on function ujira.attestation_pending(bytea) to ujira_signer_attester;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ujira to ujira_signer_read;
alter function ujira.attestation_pending(bytea) owner to ujira_signer_read;
revoke create on schema ujira from ujira_signer_read;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function ujira.attestation_pending(bytea);
revoke usage on schema ujira from ujira_signer_read, ujira_signer_attester;
revoke ujira_signer_read from ujira_owner;
alter role ujira_signer_attester reset statement_timeout;
alter role ujira_signer_attester reset lock_timeout;
alter role ujira_signer_attester reset idle_in_transaction_session_timeout;
