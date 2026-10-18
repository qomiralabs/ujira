// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Shared setup for the Supabase platform spike. It builds a throwaway copy
// of the role and policy design under a per-file prefix, runs the checks
// against the real Supavisor poolers, and removes everything again, so the
// project keeps nothing from a run.
//
// Connection strings and passwords never leave this process: URLs are built
// in memory, login passwords are random per run, and errors are reported
// without the URL.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import pg from 'pg';

export interface SpikeEnv {
  readonly session: string;
  readonly transaction: string;
  readonly projectRef: string;
}

/** The pooler URLs from the environment, or null when the spike cannot run. */
export function spikeEnv(): SpikeEnv | null {
  const session = process.env['SUPABASE_SESSION_POOLER_URL'];
  const transaction = process.env['SUPABASE_TRANSACTION_POOLER_URL'];
  const projectRef = process.env['SUPABASE_PROJECT_REF'];
  if (!session || !transaction || !projectRef) return null;
  return { session, transaction, projectRef };
}

// Supabase signs the pooler certificate with its own root, which is not in
// the Node trust store. The root is pinned here rather than turning
// verification off. SHA-256 fingerprint
// 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA.
const CA = readFileSync(path.join(import.meta.dirname, 'supabase-root-2021-ca.crt'), 'utf8');

export type PoolerMode = 'session' | 'transaction';

/** A pooler URL for `role`, or the admin URL when no role is given. */
export function poolerUrl(env: SpikeEnv, mode: PoolerMode, login?: Login): string {
  const url = new URL(mode === 'session' ? env.session : env.transaction);
  if (login !== undefined) {
    // Supavisor routes on the user name: role, a dot, then the project ref.
    url.username = `${login.role}.${env.projectRef}`;
    url.password = login.password;
  }
  return url.toString();
}

export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: url,
    ssl: { ca: CA, rejectUnauthorized: true },
    connectionTimeoutMillis: 15_000,
    statement_timeout: 15_000,
  });
  // pg sometimes repeats the connection string in its message, so the
  // original error is not passed on, only its cleaned text.
  let failure: string | undefined;
  try {
    await client.connect();
  } catch (err) {
    failure = safeMessage(err);
  }
  if (failure !== undefined) throw new Error(`could not connect: ${failure}`);
  return client;
}

/**
 * Connects as a freshly created login. Supavisor caches a user's password
 * verifier, so a login made seconds after its role was created can be
 * refused until the cache refreshes (measured: under 15 s). Each run uses a
 * new prefix, so this rarely waits.
 */
export async function connectAs(
  env: SpikeEnv,
  mode: PoolerMode,
  login: Login,
  timeoutMs = 60_000,
): Promise<pg.Client> {
  const started = Date.now();
  for (;;) {
    try {
      return await connect(poolerUrl(env, mode, login));
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

/** A prefix unique to this run, so no cached login or leftover object can collide. */
export function runPrefix(tag: string): string {
  return `s49${tag}${randomBytes(3).toString('hex')}`;
}

/** Closes whichever of `clients` were opened; a failed setup leaves some unset. */
export async function close(...clients: unknown[]): Promise<void> {
  for (const client of clients) {
    if (client instanceof pg.Client) await client.end().catch(() => undefined);
  }
}

/** An error message with anything that looks like a connection string removed. */
export function safeMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, '<redacted url>');
}

/** The SQLSTATE of a failed query, or undefined when it did not fail. */
export async function sqlState(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'unknown';
  }
  return undefined;
}

export interface Login {
  readonly role: string;
  readonly password: string;
}

/** Role and schema names for one spike run. */
export interface Names {
  readonly owner: string;
  readonly migrator: string;
  readonly app: string;
  readonly worker: string;
  readonly reader: string;
  readonly retention: string;
  readonly auth: string;
  readonly tenantSchema: string;
  readonly jobsSchema: string;
}

export function names(prefix: string): Names {
  return {
    owner: `${prefix}_owner`,
    migrator: `${prefix}_migrator`,
    app: `${prefix}_app`,
    worker: `${prefix}_worker`,
    reader: `${prefix}_reader`,
    retention: `${prefix}_retention`,
    auth: `${prefix}_auth`,
    tenantSchema: `${prefix}_ujira`,
    jobsSchema: `${prefix}_jobs`,
  };
}

export interface Tenant {
  readonly principalId: string;
  readonly projectId: string;
}

export const TENANT_A: Tenant = {
  principalId: '00000000-0000-4000-8000-00000000000a',
  projectId: '00000000-0000-4000-8000-0000000000a1',
};
export const TENANT_B: Tenant = {
  principalId: '00000000-0000-4000-8000-00000000000b',
  projectId: '00000000-0000-4000-8000-0000000000b1',
};

export interface Spike {
  readonly env: SpikeEnv;
  readonly names: Names;
  readonly logins: Readonly<Record<'migrator' | 'app' | 'worker' | 'reader' | 'retention', Login>>;
  /** The admin (postgres) session the bootstrap ran on. */
  readonly admin: pg.Client;
}

function password(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * The SCRAM-SHA-256 verifier for `secret`, computed here so the statement
 * that sets a password carries only the verifier. The plain password never
 * reaches the server's statement log.
 */
export function scramVerifier(secret: string): string {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(secret, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${String(iterations)}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Runs a statement that edits the database's ACL. Two such statements at
 * once fail with "tuple concurrently updated" (plain Postgres behaviour,
 * seen when the spike files run in parallel), so they are retried.
 */
async function aclStatement(admin: pg.Client, sql: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.query(sql);
      return;
    } catch (err) {
      if (attempt >= 10 || !safeMessage(err).includes('tuple concurrently updated')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

/** Drops everything a run with this prefix may have left behind. */
export async function cleanup(admin: pg.Client, n: Names): Promise<void> {
  const roles = [n.app, n.reader, n.retention, n.migrator, n.worker, n.auth, n.owner];
  const existing = await admin.query<{ rolname: string }>(
    'select rolname from pg_roles where rolname = any($1)',
    [roles],
  );
  const present = new Set(existing.rows.map((r) => r.rolname));
  for (const role of roles) {
    if (present.has(role)) await admin.query(`grant ${role} to current_user`);
  }
  await admin.query(`drop schema if exists ${n.jobsSchema} cascade`);
  await admin.query(`drop schema if exists ${n.tenantSchema} cascade`);
  for (const role of roles) {
    if (!present.has(role)) continue;
    await aclStatement(admin, `revoke all on database postgres from ${role}`);
    await admin.query(`drop owned by ${role}`);
    await admin.query(`drop role ${role}`);
  }
}

/**
 * Creates the roles and a small tenant schema following the design: an
 * owner without login, a migrator that is a member of it, NOBYPASSRLS
 * login roles for the app, reader, retention job and worker, and a narrow
 * owner for a security definer lookup. Runs as the project's postgres role,
 * which is itself one of the checks.
 */
export async function bootstrap(env: SpikeEnv, prefix: string): Promise<Spike> {
  const n = names(prefix);
  const admin = await connect(env.session);
  await cleanup(admin, n);
  const logins = {
    migrator: { role: n.migrator, password: password() },
    app: { role: n.app, password: password() },
    worker: { role: n.worker, password: password() },
    reader: { role: n.reader, password: password() },
    retention: { role: n.retention, password: password() },
  };
  // A setup that fails halfway would otherwise leave roles behind, since
  // the caller never gets a Spike to clean up.
  try {
    const login = (l: Login) => `login nobypassrls password '${scramVerifier(l.password)}'`;
    await admin.query(`create role ${n.owner} nologin nobypassrls`);
    await admin.query(`create role ${n.auth} nologin nobypassrls`);
    await admin.query(`create role ${n.migrator} ${login(logins.migrator)} in role ${n.owner}`);
    await admin.query(`create role ${n.app} ${login(logins.app)}`);
    await admin.query(`create role ${n.worker} ${login(logins.worker)}`);
    await admin.query(`create role ${n.reader} ${login(logins.reader)}`);
    await admin.query(`create role ${n.retention} ${login(logins.retention)}`);
    await admin.query(
      `alter role ${n.app} set statement_timeout = '5s'; alter role ${n.app} set lock_timeout = '2s'; alter role ${n.app} set idle_in_transaction_session_timeout = '10s'`,
    );
    // The worker's installer runs `create schema if not exists`, so it needs
    // CREATE on the database, and its functions must not be PUBLIC.
    await aclStatement(admin, `grant create on database postgres to ${n.worker}`);
    await admin.query(`grant ${n.owner}, ${n.worker} to current_user`);
    await admin.query(
      `alter default privileges for role ${n.worker} revoke execute on functions from public`,
    );
    await admin.query(`create schema ${n.tenantSchema} authorization ${n.owner}`);
    await admin.query(
      `grant usage on schema ${n.tenantSchema} to ${n.app}, ${n.reader}, ${n.retention}, ${n.auth}`,
    );
    await admin.query(
      `revoke all on schema ${n.tenantSchema} from public, anon, authenticated, service_role`,
    );
  } catch (err) {
    await cleanup(admin, n).catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw err;
  }
  return { env, names: n, logins, admin };
}

/** Tenant schema DDL, run by the migrator through the session pooler. */
export function tenantDdl(n: Names): string {
  const s = n.tenantSchema;
  return `
    set role ${n.owner};
    create function ${s}.current_principal_id() returns uuid language plpgsql stable as $$
    declare v text := current_setting('ujira.principal_id', true);
    begin
      if v is null or v = '' then
        raise exception using errcode = 'UJ001', message = 'tenant context missing';
      end if;
      return v::uuid;
    end $$;
    create function ${s}.current_project_id() returns uuid language plpgsql stable as $$
    declare v text := current_setting('ujira.project_id', true);
    begin
      if v is null or v = '' then
        raise exception using errcode = 'UJ001', message = 'tenant context missing';
      end if;
      return case when v = 'all' then null else v::uuid end;
    end $$;
    create function ${s}.project_scope_all() returns boolean language sql stable as
      $$ select current_setting('ujira.project_id', true) = 'all' $$;

    create table ${s}.items (
      principal_id uuid not null,
      project_id uuid not null,
      id uuid not null default gen_random_uuid(),
      note text not null,
      expires_at timestamptz not null default now() + interval '1 day',
      primary key (principal_id, project_id, id)
    );
    alter table ${s}.items enable row level security;
    alter table ${s}.items force row level security;
    create policy tenant_read on ${s}.items for select to ${n.app}, ${n.reader}
      using (principal_id = ${s}.current_principal_id()
             and (${s}.project_scope_all() or project_id = ${s}.current_project_id()));
    create policy tenant_insert on ${s}.items for insert to ${n.app}
      with check (principal_id = ${s}.current_principal_id()
                  and project_id = ${s}.current_project_id());
    create policy tenant_update on ${s}.items for update to ${n.app}
      using (principal_id = ${s}.current_principal_id() and project_id = ${s}.current_project_id())
      with check (principal_id = ${s}.current_principal_id()
                  and project_id = ${s}.current_project_id());
    create policy retention_delete on ${s}.items for delete to ${n.retention}
      using (expires_at < now());
    create policy retention_read on ${s}.items for select to ${n.retention}
      using (expires_at < now());
    create policy auth_read on ${s}.items for select to ${n.auth} using (true);
    create policy owner_all on ${s}.items for all to ${n.owner} using (true) with check (true);

    grant select, insert on ${s}.items to ${n.app};
    grant update (note) on ${s}.items to ${n.app};
    grant select on ${s}.items to ${n.reader};
    grant select, delete on ${s}.items to ${n.retention};
    grant select on ${s}.items to ${n.auth};
    grant execute on function ${s}.current_principal_id(), ${s}.current_project_id(),
      ${s}.project_scope_all() to ${n.app}, ${n.reader};
    reset role;
  `;
}

/**
 * The narrow cross-tenant path: a security definer lookup owned by the auth
 * role, which alone has a policy that sees every row. Created by the
 * bootstrap session, which is a member of the owner.
 */
export function definerDdl(n: Names): string {
  const s = n.tenantSchema;
  return `
    grant ${n.auth} to current_user;
    set role ${n.owner};
    create function ${s}.lookup_item(p_id uuid)
      returns table (principal_id uuid, project_id uuid, id uuid)
      language sql stable security definer set search_path = ${s}, pg_temp
      as $$ select principal_id, project_id, id from ${s}.items where id = p_id limit 1 $$;
    -- A new owner needs CREATE on the schema, so the narrow role holds it
    -- only for the hand over.
    grant create on schema ${s} to ${n.auth};
    reset role;
    alter function ${s}.lookup_item(uuid) owner to ${n.auth};
    set role ${n.owner};
    revoke create on schema ${s} from ${n.auth};
    reset role;
    revoke execute on function ${s}.lookup_item(uuid) from public;
    grant execute on function ${s}.lookup_item(uuid) to ${n.app};
  `;
}

/** The jobs schema, installed by the worker role itself as the worker's installer would. */
export function jobsDdl(n: Names): string {
  const j = n.jobsSchema;
  return `
    create schema if not exists ${j};
    create table ${j}.jobs (id bigserial primary key, payload jsonb not null);
    create function ${j}.enqueue(p_task text) returns bigint
      language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
    declare
      v_principal text := current_setting('ujira.principal_id', true);
      v_project text := current_setting('ujira.project_id', true);
      v_id bigint;
    begin
      if v_principal is null or v_principal = '' or v_project is null or v_project = '' then
        raise exception using errcode = 'UJ001', message = 'tenant context missing';
      end if;
      insert into ${j}.jobs (payload)
        values (jsonb_build_object('task', p_task, 'principalId', v_principal, 'projectId', v_project))
        returning id into v_id;
      return v_id;
    end $$;
    grant usage on schema ${j} to ${n.app};
    grant execute on function ${j}.enqueue(text) to ${n.app};
  `;
}

/** Runs `fn` in a transaction with tenant context set as the first statement. */
export async function tenantTx<T>(
  client: pg.Client,
  tenant: Tenant | { readonly principalId: string; readonly projectId: 'all' },
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await client.query(
      "select set_config('ujira.principal_id', $1, true), set_config('ujira.project_id', $2, true)",
      [tenant.principalId, tenant.projectId],
    );
    const result = await fn();
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}

/** The tenant settings the connection reports outside any transaction. */
export async function contextNow(
  client: pg.Client,
): Promise<{ principal: string; project: string }> {
  const r = await client.query<{ principal: string | null; project: string | null }>(
    "select current_setting('ujira.principal_id', true) as principal, current_setting('ujira.project_id', true) as project",
  );
  const row = r.rows[0];
  return { principal: row?.principal ?? '', project: row?.project ?? '' };
}
