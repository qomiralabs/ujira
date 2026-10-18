# Spike: Supabase roles, policies and pooling

Issue #49. Run on 2026-10-18 against the UJIRA staging project (free plan, region eu-west-1, Ireland, Postgres 17.11). All connections went through Supavisor, the shared pooler: session mode on port 5432 and transaction mode on port 6543. Scripts are in `packages/db/spikes/supabase/`.

Each result is marked:

- **measured**: run on the staging project, by the tests below unless a probe is named;
- **referenced**: taken from vendor documentation, not run;
- **assumed**: not verified.

## How to run

The tests skip unless `SUPABASE_SESSION_POOLER_URL`, `SUPABASE_TRANSACTION_POOLER_URL` and `SUPABASE_PROJECT_REF` are set, so CI never runs them. Locally, with the git-ignored `.env` in the repository root:

```sh
set -a; . ./.env; set +a
SPIKE_RESULTS_FILE=/tmp/latency.json pnpm exec vitest run --project @ujira/db
```

Each test file builds its own copy of the role design under a fresh prefix (`s49` plus a tag and random hex). It drops every role, schema and grant it created when it finishes:

- Login passwords are random per run and never leave the process.
- Only SCRAM-SHA-256 verifiers, computed in the test, are sent to the server.
- Connection errors are reported without the URL.
- The pooler certificate is verified against the pinned Supabase Root 2021 CA (`supabase-root-2021-ca.crt`, SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`), never with verification turned off.

Last run: 3 files and 21 tests passed.

## What stays on the project

Nothing.

- After the run, no role or schema with the spike prefixes remains (measured: 0 roles, 0 schemas).
- No `ujira` schema exists yet.
- The real roles are created by the roles bootstrap migration when the tenancy schema lands. The project is then reviewed and kept as staging (#227).

## Roles and policies (`roles.test.ts`)

| Check                                                                                                                                                                                                      | Result                                                                                        |          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------- |
| The `postgres` role runs the roles bootstrap: it creates an owner without login, a migrator that is a member of it, `NOBYPASSRLS` logins for app, reader, retention and worker, and a narrow definer owner | Pass. On Supabase, `postgres` is not a superuser but has CREATEROLE (and BYPASSRLS, CREATEDB) | measured |
| Every spike role has `rolbypassrls = false` and `rolsuper = false`; only the five login roles can log in                                                                                                   | Pass                                                                                          | measured |
| Custom login roles connect through Supavisor in both modes, with the user name `role.projectref` and a SCRAM password                                                                                      | Pass                                                                                          | measured |
| The app sees only its own tenant's rows                                                                                                                                                                    | Pass                                                                                          | measured |
| The app cannot insert a row for another tenant (`42501`)                                                                                                                                                   | Pass                                                                                          | measured |
| Without tenant context, every read fails with `UJ001`                                                                                                                                                      | Pass                                                                                          | measured |
| Scope `all` reads every project of the principal and refuses every write (`42501`)                                                                                                                         | Pass                                                                                          | measured |
| The app updates only granted columns, and DELETE is refused (`42501`)                                                                                                                                      | Pass                                                                                          | measured |
| The reader reads through the same policies and cannot write                                                                                                                                                | Pass                                                                                          | measured |
| A `security definer` function owned by a narrow NOLOGIN role returns another tenant's row to the app, while the app's direct select returns nothing; the reader cannot execute it                          | Pass                                                                                          | measured |
| The retention role deletes only expired rows, without tenant context                                                                                                                                       | Pass                                                                                          | measured |
| `anon`, `authenticated` and `service_role` have no USAGE on the tenant schema                                                                                                                              | Pass                                                                                          | measured |

Two platform details showed up while building the bootstrap (measured):

- **Creating objects in the owner's schema.** As `postgres`, creating objects in a schema owned by the owner role failed with "permission denied for schema", even after `grant owner to current_user`. It worked after `set role owner`. The bootstrap therefore switches role before DDL.
- **Giving a function to the narrow role.** Handing a definer function to the narrow role (`alter function ... owner to`) needs that role to hold CREATE on the schema, and the session must be able to SET ROLE to both roles. The spike grants CREATE for the handover only, then revokes it.

## Tenant context through the transaction pooler (`pooler.test.ts`)

| Check                                                                                                                                                                                                                                      | Result                                                                                                                                                                                                                                                         |          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Two tenants alternate 40 times on one pooled connection, with `set_config(..., true)` as the first statement; each transaction sees only its tenant, and between transactions both this connection and a second one report no context      | Pass                                                                                                                                                                                                                                                           | measured |
| After a failed transaction (`22012`, rolled back), the context is empty and the next tenant sees only its own rows, 10 times over. A statement after the error in the same transaction is refused (`25P02`), never run with the old tenant | Pass                                                                                                                                                                                                                                                           | measured |
| Parameterized queries (unnamed prepared statements) and named prepared statements both work through the transaction pooler                                                                                                                 | Pass                                                                                                                                                                                                                                                           | measured |
| A session level `SET ujira.principal_id` on one client is seen by a second client that shares the backend                                                                                                                                  | Leaks (measured in a probe: 10 of 10 reads on the second client saw the first client's value, both on one backend). The test asserts that the leak happens exactly when the backends are shared. This is why session level SET of tenant keys must stay banned | measured |
| LISTEN on the transaction pooler                                                                                                                                                                                                           | Notifications are not delivered                                                                                                                                                                                                                                | measured |

Two statements that edit the database ACL at the same moment fail with "tuple concurrently updated" (measured when the spike files ran in parallel). This is plain Postgres behaviour; the spike retries those statements, and a real roles bootstrap runs once, as a single migration.

Supavisor also caches a user's password verifier (measured in a probe). A role dropped and created again with a new password was refused at its first login, and accepted on a retry within 13 s. Rotating a login password therefore has a short window where new connections fail. The tests use a fresh prefix per run and retry logins for up to 60 s.

## Worker checks (`roles.test.ts`, worker checks)

| Check                                                                                                                                                                                                                                                                                                                                     | Result                                                 |          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------- |
| LISTEN and NOTIFY work through the Supavisor session pooler (worker listening, app notifying)                                                                                                                                                                                                                                             | Pass, delivered within 10 s (typically under a second) | measured |
| The worker login can be granted CREATE on the database and installs its own schema with `create schema if not exists`; it has no USAGE on the tenant schema                                                                                                                                                                               | Pass                                                   | measured |
| A `security definer` enqueue function in a non-public schema owned by the worker takes the tenant from transaction context. The app can execute it but cannot read the jobs table; it refuses a missing context (`UJ001`); and with `alter default privileges ... revoke execute on functions from public`, other roles cannot execute it | Pass                                                   | measured |
| The `postgres` role runs the whole roles bootstrap                                                                                                                                                                                                                                                                                        | Pass                                                   | measured |

## Connectivity

| Path                        | Result                                                                                             |                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Direct host                 | Resolves to IPv6 only (one AAAA record, no A record)                                               | measured (DNS)                                       |
| Shared pooler host          | Resolves to IPv4 (four A records) and IPv6                                                         | measured (DNS)                                       |
| Render to the direct host   | Not reachable without the IPv4 add-on, because Render services make outbound connections over IPv4 | referenced (Render) and assumed; not run from Render |
| Render to the shared pooler | Expected to work over IPv4                                                                         | assumed; not run from Render                         |

Working connection path:

- **App:** transaction pooler, port 6543.
- **Worker:** session pooler, port 5432. It needs LISTEN, which the transaction pooler does not deliver (measured).
- **Migrator:** session pooler, port 5432. Its advisory lock is session scoped (referenced).

None of these needs the IPv4 add-on.

## Data API

| Check                                                                                     | Result                                                                                                                                                                                                                                                                                       |                           |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| The API roles (`anon`, `authenticated`, `service_role`) get no grant on the tenant schema | Pass                                                                                                                                                                                                                                                                                         | measured                  |
| Which schemas the Data API exposes                                                        | Not visible from SQL. The `authenticator` role carries no `pgrst.db_schemas` setting, so the exposed list is managed in the dashboard. The maintainer should confirm that `ujira` is not in Settings > Data API > Exposed schemas, or turn the Data API off, before the tenancy schema lands | open, needs the dashboard |

## Latency of the tenant context round trip (`latency.test.ts`)

There were 200 timed runs of each transaction, after 20 warm up runs:

- **plain:** `begin`, `select 1`, `commit`;
- **tenant:** the same, plus the `set_config` statement.

They ran from the developer machine through the transaction pooler, outside the project's region, not from Render.

|                                                                 | p50                  | p95    |
| --------------------------------------------------------------- | -------------------- | ------ |
| Plain transaction                                               | 480 ms               | 566 ms |
| Tenant transaction                                              | 640 ms               | 752 ms |
| Added by the context statement                                  | 161 ms               | 186 ms |
| One network round trip (`select 1`, 100 runs)                   | 145 ms               | 166 ms |
| Server cost of the two `set_config` calls (10,000 in one block) | 3.5 µs per call pair |        |

All of these are measured. The added cost is one network round trip; the server work is negligible. From a service in the same region it would be one in-region round trip (assumed 1 to 3 ms). Render has no Ireland region, so from Frankfurt it would be one Frankfurt to Ireland round trip (assumed around 20 ms). Sending the context in the same round trip as `begin` would remove it.

## Paid add-ons

Not visible from the database. Point in time recovery, the read replica and the IPv4 add-on were not enabled by this spike, and nothing here needs them. The maintainer should confirm the add-on list in the dashboard (Settings > Add-ons) and record it here; until then, this criterion is open.

## Project facts at the time of the run

- **Postgres:** 17.11, `max_connections` 60 (measured).
- **Extensions installed:** `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp` (measured).
- **`authenticator` role settings:** `session_preload_libraries = supautils, safeupdate`, `statement_timeout = 8s`, `lock_timeout = 8s` (measured).
