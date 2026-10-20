# Spike: Supabase roles, policies and pooling

Issue #49. Run on 2026-10-18 against the UJIRA staging project (free plan, region eu-west-1, Ireland, Postgres 17.11). All connections went through Supavisor, the shared pooler: session mode on port 5432 and transaction mode on port 6543. Scripts are in `packages/db/spikes/supabase/`.

Each result is marked:

- **measured**: run on the staging project by a committed test or probe, named with the result;
- **confirmed by the maintainer**: read by a person from the Supabase dashboard on the date given. Nothing in this repository can re-verify it, because the setting is not visible to any query; re-checking it means opening the dashboard again;
- **assumed**: not verified.

## How to run

The tests skip unless `SUPABASE_SESSION_POOLER_URL`, `SUPABASE_TRANSACTION_POOLER_URL` and `SUPABASE_PROJECT_REF` are set, so CI never connects. Two rules keep a skip from looking like a pass:

- if only some of the three are set, the harness throws;
- with `SUPABASE_SPIKE_REQUIRED=1`, a missing configuration throws too.

Locally, with the git-ignored `.env` in the repository root:

**Run one file at a time.** The files must not run in parallel. A parallel run of the
three gave 2 failed and 4 passed, every failure
`could not connect: timeout expired` against the harness's 15 second
`connectionTimeoutMillis` (measured). Each file bootstraps its own roles and
opens several pooled connections, so run together they ask the free
project's pooler for more connections at once than it hands out inside that
limit. The failures are connections not being granted in time, not the
design. Either name one file per command, as below, or
pass `--no-file-parallelism`.

```sh
set -a; . ./.env; set +a
for f in roles pooler latency; do
  SUPABASE_SPIKE_REQUIRED=1 SPIKE_RESULTS_FILE=/tmp/latency.json \
    pnpm exec vitest run --project @ujira/db "spikes/supabase/$f.test.ts"
done
# The probes also run with SUPABASE_SPIKE_PROBES=1; each writes its
# numbers to SPIKE_PROBE_RESULTS.
SUPABASE_SPIKE_REQUIRED=1 SUPABASE_SPIKE_PROBES=1 SPIKE_PROBE_RESULTS=/tmp/cache.json \
  pnpm exec vitest run --project @ujira/db spikes/supabase/probes/password-cache.test.ts
SUPABASE_SPIKE_REQUIRED=1 SUPABASE_SPIKE_PROBES=1 SPIKE_PROBE_RESULTS=/tmp/acl.json \
  pnpm exec vitest run --project @ujira/db spikes/supabase/probes/acl-race.test.ts
```

`harness.test.ts` needs no database and runs everywhere, CI included. It covers the environment rules, the TLS refusals and the URL handling below.

Each test file builds its own copy of the role design under a fresh prefix (`s49` plus a tag and random hex). It drops every role, schema and grant it created when it finishes:

- Login passwords are random per run and never leave the process.
- Only SCRAM-SHA-256 verifiers, computed in the test, are sent to the server.
- Connection errors are reported without the URL. A URL that fails to parse is replaced by a fixed message, because the URL parser puts the whole input, password included, on its error.
- The pooler certificate is verified against the pinned Supabase Root 2021 CA (`supabase-root-2021-ca.crt`, SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`), never with verification turned off.
- Any `ssl*` parameter in a pooler URL is refused, because pg lets it replace the pinned CA. `sslmode=no-verify` or `disable` would turn verification or TLS off. Before connecting, the harness also checks that the client's TLS settings are the pinned object.

Last run with `SUPABASE_SPIKE_REQUIRED=1`, one file at a time: `roles.test.ts` 16 passed, `pooler.test.ts` 5 passed, `latency.test.ts` 1 passed, `harness.test.ts` 17 passed, with the 2 probe files skipped. The probes were run separately (see below). After every run, 0 spike roles and 0 spike schemas remained.

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
| The same API roles hold no table, column or function privilege in the tenant schema, and no default ACL (in that schema or in every schema) grants them anything for the owner's or the worker's objects   | Pass, once the owner revokes PUBLIC execute (next paragraph)                                  | measured |

Two platform details showed up while building the bootstrap (measured):

- **Creating objects in the owner's schema.** As `postgres`, creating objects in a schema owned by the owner role failed with "permission denied for schema", even after `grant owner to current_user`. It worked after `set role owner`. The bootstrap therefore switches role before DDL.
- **New functions are executable by PUBLIC.** By default, Postgres makes every new function executable by PUBLIC, which includes the Supabase API roles. Without schema USAGE they still cannot call one, but the first run of the privilege check found `EXECUTE` for `anon`, `authenticated` and `service_role` on the three context functions. The owner now runs `alter default privileges for role <owner> revoke execute on functions from public` first, as the worker already did, and grants each function explicitly.
- **Supabase's own default ACLs** grant the API roles new tables, sequences and functions created by `postgres` in `public` and `storage`, and by `supabase_admin` in `public`, `graphql` and `graphql_public`. There is no default ACL for every schema, so objects in a new schema owned by the owner role get none (measured).
- **Giving a function to the narrow role.** Handing a definer function to the narrow role (`alter function ... owner to`) needs that role to hold CREATE on the schema, and the session must be able to SET ROLE to both roles. The spike grants CREATE for the handover only, then revokes it.

## Tenant context through the transaction pooler (`pooler.test.ts`)

| Check                                                                                                                                                                                                                                      | Result                                                                                                                                                                                                                                                                                                                      |          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Two tenants alternate 40 times on one pooled connection, with `set_config(..., true)` as the first statement; each transaction sees only its tenant, and between transactions both this connection and a second one report no context      | Pass                                                                                                                                                                                                                                                                                                                        | measured |
| After a failed transaction (`22012`, rolled back), the context is empty and the next tenant sees only its own rows, 10 times over. A statement after the error in the same transaction is refused (`25P02`), never run with the old tenant | Pass                                                                                                                                                                                                                                                                                                                        | measured |
| Parameterized queries (unnamed prepared statements) and named prepared statements both work through the transaction pooler                                                                                                                 | Pass                                                                                                                                                                                                                                                                                                                        | measured |
| A session level `SET ujira.principal_id` on one client is seen by a second client on the same backend                                                                                                                                      | Leaks. The SET and its backend pid are read in one query; the second client reads its own pid and the setting in one statement until it lands on that backend, and it must then see the first client's tenant. The reset afterwards runs on the same backend. This is why session level SET of tenant keys must stay banned | measured |
| LISTEN on the transaction pooler                                                                                                                                                                                                           | Notifications are not delivered. As a positive control, a session pooled listener on the same channel does receive the same NOTIFY                                                                                                                                                                                          | measured |

## Probes (`probes/`, opt in)

**Concurrent database ACL edits (`acl-race.test.ts`).** Two sessions grant and then revoke CREATE on the database for two roles at the same moment, 30 rounds (120 statements). 47 statements failed with "tuple concurrently updated", and there were no other errors (measured). This is plain Postgres behaviour. The spike retries those statements; a real roles bootstrap runs once, as a single migration.

**Supavisor's password cache (`password-cache.test.ts`).** A probe login polled once a second, through both poolers, up to 180 s per step. Measured on two runs (first run, second run):

| Step                                                                                                                 | Session pooler | Transaction pooler |
| -------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------ |
| Rotate the password: the old password is still accepted for                                                          | 1 s, 17 s      | 2 s, 2 s           |
| Rotate the password: the new password is accepted after                                                              | 1 s, 1 s       | 1 s, 1 s           |
| Drop and recreate the role with a new password: the new one is accepted after                                        | 3 s, 4 s       | 1 s, 2 s           |
| Revoke: after `alter role ... nologin` and `pg_terminate_backend` on its backends, new logins are still accepted for | 39 s, 86 s     | 7 s, 1 s           |

What this means for revoking a login:

- In both runs, an open session of the role stopped working right after NOLOGIN, and `pg_terminate_backend` found no backend under the role's name.
- Supavisor kept accepting new logins with the old credentials for up to 86 s after NOLOGIN, and up to 17 s after a password change. The window is longer through the session pooler.
- Revoking a login is NOLOGIN, then terminating its backends, then waiting out the pooler cache. Treat a compromised login as usable for up to about a minute and a half after revocation, unless Supabase offers a way to flush the pooler. Changing the password as well narrows the window but does not close it.

The earlier observation that a recreated login was refused for up to about 13 s came from an uncommitted script; the committed probe measured at most 3 s. The tests still retry new logins for up to 60 s.

## Worker checks (`roles.test.ts`, worker checks)

| Check                                                                                                                                                                                                                                                                                                                                     | Result                                                 |          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------- |
| LISTEN and NOTIFY work through the Supavisor session pooler (worker listening, app notifying)                                                                                                                                                                                                                                             | Pass, delivered within 10 s (typically under a second) | measured |
| The worker login can be granted CREATE on the database and installs its own schema with `create schema if not exists`; it has no USAGE on the tenant schema                                                                                                                                                                               | Pass                                                   | measured |
| A `security definer` enqueue function in a non-public schema owned by the worker takes the tenant from transaction context. The app can execute it but cannot read the jobs table; it refuses a missing context (`UJ001`); and with `alter default privileges ... revoke execute on functions from public`, other roles cannot execute it | Pass                                                   | measured |
| The `postgres` role runs the whole roles bootstrap                                                                                                                                                                                                                                                                                        | Pass                                                   | measured |

## Connectivity

| Path                        | Result                                                                                                           |                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Direct host                 | Resolves to IPv6 only (one AAAA record, no A record)                                                             | measured (DNS)               |
| Shared pooler host          | Resolves to IPv4 (four A records) and IPv6                                                                       | measured (DNS)               |
| Render to the direct host   | Assumed not reachable without the IPv4 add-on, on the assumption that Render services connect out over IPv4 only | assumed; not run from Render |
| Render to the shared pooler | Expected to work over IPv4                                                                                       | assumed; not run from Render |

Working connection path:

- **App:** transaction pooler, port 6543.
- **Worker:** session pooler, port 5432. It needs LISTEN, which the transaction pooler does not deliver (measured).
- **Migrator:** session pooler, port 5432. Assumed, because its advisory lock is expected to be session scoped; this was not checked against the migration tool.

None of these needs the IPv4 add-on.

## Data API

| Check                                                                                     | Result                                                                                                                                                 |                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| The API roles (`anon`, `authenticated`, `service_role`) get no grant on the tenant schema | Pass                                                                                                                                                   | measured                    |
| Which schemas the Data API exposes                                                        | Schema `ujira` is not exposed through the Data API. The maintainer read this from Settings > Data API > Exposed schemas in the dashboard on 2026-10-20 | confirmed by the maintainer |

The exposed schema list is not visible to SQL: the `authenticator` role carries no `pgrst.db_schemas` setting, so no query in this repository can check it or notice a later change. Someone changing the exposed schemas in the dashboard would not fail any test here. The grant checks above are what the repository can enforce, and they hold whatever the Data API is set to.

## Latency of the tenant context round trip (`latency.test.ts`)

**These figures only describe where they were taken.** Two transactions are timed:

- **plain:** `begin`, `select 1`, `commit`;
- **tenant:** the same, plus the `set_config` statement.

The numbers below came from a developer machine through the transaction pooler, outside the project's region and not from Render, with `SPIKE_LATENCY_RUNS=200` after 20 warm up runs. Only the difference between the two transactions carries to another location; every absolute figure is that machine's round trip. Even the difference moves with the network: an earlier run on the same machine gave 566 ms and 752 ms for the two transactions, and 186 ms added.

The test defaults to 20 runs, so it finishes from anywhere; `SPIKE_LATENCY_RUNS` reproduces the 200 run figures and takes several minutes from far away. At 200 runs from far outside the region it can outrun its own 900 second timeout, which is a limit of where it runs and not a broken test.

|                                                                 | p50                            | p95      |
| --------------------------------------------------------------- | ------------------------------ | -------- |
| Plain transaction                                               | 498 ms                         | 1,232 ms |
| Tenant transaction                                              | 676 ms                         | 1,508 ms |
| Added by the context statement                                  | 178 ms                         | 276 ms   |
| One network round trip (`select 1`, 100 runs)                   | 163 ms                         | 249 ms   |
| Server cost of the two `set_config` calls (10,000 in one block) | 3.5 microseconds per call pair |          |

All of these are measured by `latency.test.ts`, which also records the round trip and the server cost. The added cost is one network round trip; the server work is negligible. From a service in the same region it would be one in-region round trip (assumed 1 to 3 ms). Render has no Ireland region, so from Frankfurt it would be one Frankfurt to Ireland round trip (assumed around 20 ms). Sending the context in the same round trip as `begin` would remove it.

## Recommendation for packages/db: bind the context to its transaction

Context is transaction local, and the tests above found no carry over. As defence in depth, the repository can also bind the context to the transaction that set it:

- set `ujira.txid` to `txid_current()` next to the tenant keys;
- have `current_principal_id()` refuse, with `UJ001`, whenever `ujira.txid` differs from `txid_current()`.

A setting that somehow survived into another transaction, through a session level SET or a pooler bug, would then be refused instead of used. This is a recommendation for the real schema, not code in this spike.

## Paid add-ons

No paid add-on is enabled on the project. The maintainer read the add-on list from Settings > Add-ons in the dashboard on 2026-10-20 (confirmed by the maintainer). That covers point in time recovery, the read replica and the IPv4 add-on, none of which this spike needs or enabled.

As with the Data API list, add-ons are not visible from the database, so nothing in this repository can re-verify this or catch a later change. Re-checking it means opening the dashboard again. Point in time recovery is a launch gate and is expected to be bought just before mainnet, which will change this line.

## Project facts at the time of the run

- **Postgres:** 17.11, `max_connections` 60 (measured).
- **Extensions installed:** `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp` (measured).
- **`authenticator` role settings:** `session_preload_libraries = supautils, safeupdate`, `statement_timeout = 8s`, `lock_timeout = 8s` (measured).
