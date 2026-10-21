# Spike: Graphile Worker fit (issue #50)

> **The live test files that produced these numbers were removed** by #52
> (`spikes/harness.ts` and `spikes/worker.test.ts`). Two reasons, recorded so
> the gap is visible rather than quiet. They were the last code outside
> `packages/db` importing `pg`, and the import fence that keeps the driver in
> one package allows no exceptions. They had also begun failing the gate
> intermittently on an uncaught Postgres error while every test passed, and a
> flake that fails the gate teaches people to rerun rather than read. The
> decision this spike produced is in this file, the evidence is in its pull
> request, and the SQL it ran is still in `spikes/sql/`. Reproducing a number
> here now means writing a test inside `packages/db`, which has a Postgres
> harness of its own.

Graphile Worker 0.18.0 fits, with five changes to how we use it. All results below were measured on local Postgres 17.6 in Docker on an Apple M3 Pro laptop (11 cores, 18 GiB). The free Supabase spike project was not used in this pass, so everything about the hosted pooler is inferred from a local PgBouncer and still needs a run there.

## Versions

| Package                      | Version | Released   | License |
| ---------------------------- | ------- | ---------- | ------- |
| `graphile-worker`            | 0.18.0  | 2026-09-08 | MIT     |
| `pg`                         | 8.23.1  | 2026-09-30 | MIT     |
| `@testcontainers/postgresql` | 12.2.0  | 2026-09-28 | MIT     |
| `zod`                        | 4.6.5   | 2026-09-13 | MIT     |

The 66 runtime packages of `graphile-worker` and `pg` are 56 MIT, 8 ISC, one 0BSD and one Python-2.0 (`argparse`). `pnpm licenses:check` passes. One runtime dependency, `graphile-config`, is still a pre-release (`0.0.1-beta.18`).

## Install, as a deploy step

Order on a fresh database:

1. Platform admin, once: create the roles, then run [`sql/01-bootstrap.sql`](sql/01-bootstrap.sql). It creates schemas `graphile_worker` and `ujira_jobs` owned by `ujira_worker`, grants that role CREATE on the database, and revokes PUBLIC execute on its future functions.
2. App migrations as `ujira_migrator`.
3. Worker schema as `ujira_worker`, over a session connection:

   ```sh
   pnpm --filter @ujira/payouts exec graphile-worker --schema-only --connection "$UJIRA_DATABASE_SESSION_URL"
   ```

   This took 0.47 s on an empty database and leaves schema revision 20.

4. [`sql/03-enqueue.sql`](sql/03-enqueue.sql) as `ujira_worker`.

CREATE on the database is required even when the schema already exists, because the installer always runs `create schema if not exists` (measured: `permission denied for database` without it). Every worker pool also runs the same migration check when it starts, so a pool on a newer version upgrades the schema itself. Pin the version and run step 3 before rolling out pools.

## Answers

| Question                                   | Answer                                                                                                                                                                                                                                                                                                                                                           | Proof                                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate deploy step                       | Yes, with a dedicated `ujira_worker` role that owns the worker schema and has no rights on `ujira`                                                                                                                                                                                                                                                               | Install above; test `app role adds a job inside a tenant transaction` checks the worker has no USAGE on `ujira`                                    |
| App role enqueues under RLS                | Not through `graphile_worker.add_job`: it is security invoker and the worker tables have RLS enabled with no policies. Usage only gives `permission denied for table _private_tasks`; table grants on top give `new row violates row-level security policy`. A security definer `ujira_jobs.enqueue` owned by `ujira_worker` works, and it is the only way in    | Test `app role adds a job inside a tenant transaction`, test `app role cannot reach graphile_worker directly`                                      |
| Job only on commit                         | Yes. The job is invisible to other sessions before commit and gone after rollback                                                                                                                                                                                                                                                                                | Test `rolled back transaction leaves no job`                                                                                                       |
| Tenant context per job                     | `enqueue` copies principal and project from the transaction settings into the payload and refuses a missing context, the `all` scope, and tenant ids passed by the caller. Handlers parse the payload with zod and open a tenant transaction from it; across 300 jobs on two tenants no handler saw another tenant's rows                                        | Tests `enqueue refuses a job without a single project context`, `two jobs on one queue never run concurrently`                                     |
| Job keys                                   | Keys and queue names are global. With a bare key, tenant B's `add_job` replaced tenant A's job in place (same id, payload now B's). `enqueue` prefixes both with `principal:project:`                                                                                                                                                                            | Test `the same job key from two tenants makes two jobs`                                                                                            |
| Serial queue per mandate                   | Yes, at most one running job per queue in every run, with and without the local queue                                                                                                                                                                                                                                                                            | Test `two jobs on one queue never run concurrently`                                                                                                |
| Order within a queue                       | Not FIFO by default. Jobs are claimed by `(priority, run_at)` with no tie break, and every job from one transaction shares `now()`. After touching half the rows, 40 jobs ran as 0, 2, 4, ... `enqueue` defaults `run_at` to `clock_timestamp()`, which restored strict order                                                                                    | Test `a crashed worker holds its queue until force unlocked` asserts order after a lock is cleared                                                 |
| Retries and backoff                        | Built in delay is `exp(min(attempts, 10))` seconds and cannot be configured: 2.7, 7.3, 20, 55, 148, 403, 1097, 2981, 8103 s, then 22026 s (6.1 h) for every later try, 21.9 h over 12 tries. A handler can own its curve by enqueueing itself under the same key with a later `run_at` and returning: measured 5, 10, 20, 40, 80, 160, 320, 600, 600, 600, 600 s | Tests `failed jobs back off by e to the attempts and stop at max attempts`, `a handler can own its backoff by replacing itself under the same key` |
| Dead letter                                | A job at `max_attempts` stays in the table with `last_error` and is never claimed again, even when due                                                                                                                                                                                                                                                           | Test `failed jobs back off by e to the attempts and stop at max attempts`                                                                          |
| Cron                                       | Two pools with the same crontab over 150 s: 2 ticks, each timestamp once. After 150 s with no pool, a restart with `?fill=4m` backfilled the 3 missed minutes. Task names in a crontab cannot contain dots (`reconcile:sweep` works, `reconcile.sweep` is rejected)                                                                                              | Scratch run, not committed (needs minutes of wall time)                                                                                            |
| Graceful shutdown                          | See below: needs batched completion                                                                                                                                                                                                                                                                                                                              | Test `stopping mid job still records the completion`                                                                                               |
| Crash                                      | A killed process leaves its job and its queue locked for 4 hours (fixed in code), blocking the whole mandate queue. `force_unlock_workers` freed it and the next job started 192 ms later                                                                                                                                                                        | Test `a crashed worker holds its queue until force unlocked`                                                                                       |
| Restore                                    | See below                                                                                                                                                                                                                                                                                                                                                        | Test `restored jobs are safe`                                                                                                                      |
| Same Postgres, behind a transaction pooler | Enqueue through the pooler works (NOTIFY fires at commit on the server). The worker pool behind the pooler loses LISTEN without any error and falls back to polling                                                                                                                                                                                              | Latency table below                                                                                                                                |

## Enqueue argument checks

An `IF` on NULL is false, so the first version of `enqueue` let `enqueue('payout:advance', null)` store a `{}` payload with no tenant, and let a NULL key mode through. The function now refuses a NULL task, ids or key mode up front (SQLSTATE 22004). A NULL job key, queue, run at or max attempts still means not set, and every other check is written so that NULL can only fail it. Empty keys and queues are refused, since they would collapse to the bare tenant prefix, and max attempts must be 1 to 100. Tenant ids are stored in canonical lower case form in both the payload and the prefix. There is one test per argument.

## Graceful shutdown

With default settings 0.18.0 calls the completion write without waiting for it. On SIGTERM the pool finished its running job, logged success, and the process exited before the write landed: the job stayed locked (5 of 5 runs). With `completeJobBatchDelay: 0` and `failJobBatchDelay: 0` the completion was written in 5 of 5 runs, and a job that honoured `helpers.abortSignal` was released at the 5 s abort timeout with `last_error` set, ready to retry. A job that ignores the signal holds shutdown until it ends (19.8 s for a 20 s job), so handlers must honour it and the platform's kill grace must exceed the abort timeout. Handling SIGTERM ourselves with `noHandleSignals` and `runner.stop()` did not help without batching.

## Restore run

Three payouts were committed with their `payout:advance` jobs on one mandate queue. A dump was taken with a fourth job held by a live worker. The chain is simulated outside the database, so a restore cannot roll it back.

| Step                                  | Jobs | Locked | Paid on chain | Payouts submitted | Pay calls |
| ------------------------------------- | ---- | ------ | ------------- | ----------------- | --------- |
| First run                             | 1    | 1      | 3             | 3                 | 3         |
| After restore                         | 4    | 1      | 3             | 0                 |           |
| Idempotent handler after restore      | 1    | 1      | 3             | 3                 | 0         |
| Naive handler after restore (control) | 1    | 1      | 3             | 3                 | 3         |

The restore brings back every job that had already run, with the payouts unpaid. The idempotent handler asks the chain by payout id before paying and reconciled all three with zero pay calls. The naive control sent three duplicate submissions that only the chain's own duplicate check stopped. The job that was locked at dump time stayed locked after the restore; once force unlocked it ran exactly once. Database level grants are not in the dump: after restoring into a new database `ujira_worker` had no CREATE, so the bootstrap must run again before the next install.

## Pickup latency

200 jobs, one every 25 ms, measured from before the enqueue transaction to the handler starting.

| App connection | Worker connection | Prepared statements | p50     | p95     | max     |
| -------------- | ----------------- | ------------------- | ------- | ------- | ------- |
| direct         | direct            | on                  | 10 ms   | 28 ms   | 62 ms   |
| PgBouncer      | direct            | on                  | 5 ms    | 23 ms   | 53 ms   |
| PgBouncer      | PgBouncer         | on                  | 1127 ms | 1989 ms | 2089 ms |
| PgBouncer      | PgBouncer         | off                 | 989 ms  | 1920 ms | 2012 ms |

PgBouncer 1.24.1 in transaction mode with `max_prepared_statements = 200`. Prepared statements caused no errors in either mode.

## Throughput

The host was heavily loaded by other work during these runs (load average 9 to 23 on 11 cores), and results moved by up to 3x between runs, so read them as lower bounds. Four runs on fresh databases, Postgres in Docker Desktop, one worker process.

| Measure                                             | Range across runs       |
| --------------------------------------------------- | ----------------------- |
| Tenant transaction with one insert, 16 clients      | 1036 to 2483 per second |
| Same transaction plus `enqueue` with key and queue  | 216 to 2484 per second  |
| No-op jobs, concurrency 1                           | 371 to 2092 per second  |
| No-op jobs, concurrency 10                          | 3145 to 8400 per second |
| No-op jobs, concurrency 50                          | 3039 to 8330 per second |
| Jobs that open a tenant transaction, concurrency 10 | 626 to 1666 per second  |
| Same, concurrency 50                                | 1114 to 2896 per second |
| Same, concurrency 20, 200 named queues              | 214 to 453 per second   |
| Same, concurrency 20, 20 named queues               | 282 to 488 per second   |

Named queues cost most of the throughput, as expected from a lock per queue. The local queue (`localQueue.size: 50`) made a mixed run of 300 jobs on four named queues take 18.9 s against 3.2 s without it, so leave it off while mandates use named queues.

## Settings the payouts service must use

- `completeJobBatchDelay: 0` and `failJobBatchDelay: 0`.
- Worker pools run as `ujira_worker` over a session connection, never the transaction pooler.
- The app enqueues only through `ujira_jobs.enqueue`.
- Task names use colons, not dots.
- Handlers honour `helpers.abortSignal`, are idempotent against the chain, and do not rely on job order across a crash.
- A sweeper or the deploy runbook calls `force_unlock_workers` for pools known to be dead, after a crash and after every restore.

## Run the tests

```sh
pnpm --filter @ujira/payouts test
```

Needs Docker. One container, about 15 s.
