-- expand
-- How an embed token is found before any tenant is known, and how an invite link is
-- exchanged for one. A row is a token or an invite, and the two never stand in for
-- each other: an invite cannot act as a token, and a token cannot be exchanged, which
-- would let anyone holding one renew it for ever.
--
-- Both run as ujira_fn_tokens, which already finds API keys the same way.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.embed_sessions
  add column kind text not null default 'token'
    constraint embed_sessions_kind check (kind in ('token', 'invite'));

create policy authenticate on ujira.embed_sessions for select to ujira_fn_tokens using (true);
create policy exchange_invite on ujira.embed_sessions for update to ujira_fn_tokens
  using (kind = 'invite') with check (kind = 'invite');
create policy exchange_token on ujira.embed_sessions for insert to ujira_fn_tokens
  with check (kind = 'token');
grant select, insert, update on ujira.embed_sessions to ujira_fn_tokens;
grant usage on domain ujira.hash32 to ujira_fn_tokens;

-- The token a hash names, whatever its tenant, or no row. The caller checks expiry,
-- use and the origin; this only finds the one row.
create function ujira.authenticate_embed_token(token_sha256 bytea)
  returns table (
    session_id uuid,
    principal_id uuid,
    project_id uuid,
    recipient_id uuid,
    purpose text,
    allowed_origins text[],
    expires_at timestamptz,
    consumed_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select s.id, s.principal_id, s.project_id, s.recipient_id, s.purpose, s.allowed_origins,
         s.expires_at, s.consumed_at
    from ujira.embed_sessions as s
   where s.token_hash = token_sha256::ujira.hash32 and s.kind = 'token'
$fn$;

-- Spends an invite and makes the token it pays for, all or nothing. No row when the
-- invite is unknown, spent or lapsed, or when this origin is not one it allows, which
-- leaves it unspent. Only one of many callers can spend it, because the update takes
-- the row. The token gets the invite's recipient, purpose and origins, never a
-- caller's, and the expiry comes from the server.
create function ujira.exchange_embed_invite(
  invite_sha256 bytea,
  new_token_sha256 bytea,
  new_token_prefix text,
  token_seconds integer,
  request_origin text
) returns table (
    session_id uuid,
    recipient_id uuid,
    expires_at timestamptz
  )
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  spent ujira.embed_sessions%rowtype;
begin
  if token_seconds is null or token_seconds < 1 then
    raise exception using errcode = '22023', message = 'a token lasts at least a second';
  end if;
  update ujira.embed_sessions as s
     set consumed_at = now()
   where s.token_hash = invite_sha256::ujira.hash32
     and s.kind = 'invite'
     and s.consumed_at is null
     and s.expires_at > now()
     and request_origin = any (s.allowed_origins)
  returning s.* into spent;
  if not found then
    return;
  end if;
  return query
    insert into ujira.embed_sessions as s (
      principal_id, project_id, token_hash, token_prefix, recipient_id, purpose,
      allowed_origins, created_by_token, expires_at, kind
    ) values (
      spent.principal_id, spent.project_id, new_token_sha256::ujira.hash32, new_token_prefix,
      spent.recipient_id, spent.purpose, spent.allowed_origins, null,
      now() + make_interval(secs => token_seconds), 'token'
    )
    returning s.id, s.recipient_id, s.expires_at;
end
$fn$;

revoke all on function ujira.authenticate_embed_token(bytea) from public;
revoke all on function ujira.exchange_embed_invite(bytea, bytea, text, integer, text) from public;
grant execute on function ujira.authenticate_embed_token(bytea) to ujira_app, ujira_auth;
grant execute on function ujira.exchange_embed_invite(bytea, bytea, text, integer, text)
  to ujira_app, ujira_auth;

-- Handing a function to another role needs that role to hold CREATE on the schema,
-- so it is granted for the handover only.
grant create on schema ujira to ujira_fn_tokens;
alter function ujira.authenticate_embed_token(bytea) owner to ujira_fn_tokens;
alter function ujira.exchange_embed_invite(bytea, bytea, text, integer, text)
  owner to ujira_fn_tokens;
revoke create on schema ujira from ujira_fn_tokens;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.exchange_embed_invite(bytea, bytea, text, integer, text);
drop function ujira.authenticate_embed_token(bytea);
revoke usage on domain ujira.hash32 from ujira_fn_tokens;
revoke select, insert, update on ujira.embed_sessions from ujira_fn_tokens;
drop policy exchange_token on ujira.embed_sessions;
drop policy exchange_invite on ujira.embed_sessions;
drop policy authenticate on ujira.embed_sessions;
alter table ujira.embed_sessions drop column kind;

reset role;
