// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Rehearses pending migrations against a database that already holds data,
// one migration at a time, and records what each one did to traffic: how
// long it ran, which locks it held, and how long ordinary reads waited
// behind it. A migration that is instant on an empty test database can hold
// an exclusive lock for minutes on a full table, and this is where that
// shows before a deploy rather than during one.
//
// While a migration runs, a probe reads one row from every table in a loop,
// standing in for the service, and a watcher samples pg_locks. A probe read
// that waits on the migration's lock is exactly what a payout request would
// do at that moment.
//
// Like migrate.ts this imports nothing from its own package, so the nightly
// script can load it directly. The runner is passed in.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

// The migrator's connections carry this name, so the watcher can tell the
// migration's locks from the probe's.
export const REHEARSAL_APPLICATION = 'ujira_rehearsal_migrate';

export interface RehearsalStep {
  readonly name: string;
  readonly durationMs: number;
  // Relation locks the migration held, as "<mode> on <schema>.<table>". A
  // relation the migration created and has not committed is invisible to
  // the watcher and is left out.
  readonly locks: readonly string[];
  // Samples in which some other session was waiting on a lock, and the
  // longest wait seen.
  readonly lockWaitSamples: number;
  readonly maxLockWaitMs: number;
  readonly probeReads: number;
  readonly probeErrors: number;
  readonly maxProbeMs: number;
}

export interface RehearseOptions {
  readonly databaseUrl: string;
  // Applies the next pending migration through the given URL, which names
  // the connection for the watcher, and returns what it applied: one name,
  // or none when nothing is left.
  readonly applyNext: (databaseUrl: string) => Promise<readonly string[]>;
  readonly sampleEveryMs?: number;
}

export function withApplicationName(url: string, name: string): string {
  const next = new URL(url);
  next.searchParams.set('application_name', name);
  return next.toString();
}

async function userTables(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `select format('%I.%I', schemaname, relname) as name
       from pg_stat_user_tables
      where relname <> 'ujira_migrations'
      order by 1`,
  );
  return result.rows.map((row) => row.name);
}

interface LockSample {
  readonly migrator: boolean;
  readonly granted: boolean;
  readonly mode: string;
  readonly relation: string | null;
  readonly waited_ms: number | null;
}

async function sampleLocks(client: pg.Client): Promise<LockSample[]> {
  const result = await client.query<LockSample>(
    `select a.application_name = $1 as migrator,
            l.granted,
            l.mode,
            case when c.oid is null then null else format('%I.%I', n.nspname, c.relname) end as relation,
            case when l.granted then null
                 else (extract(epoch from clock_timestamp() - a.query_start) * 1000)::float8 end as waited_ms
       from pg_locks l
       join pg_stat_activity a on a.pid = l.pid
       left join pg_class c on c.oid = l.relation
       left join pg_namespace n on n.oid = c.relnamespace
      where l.locktype = 'relation'
        and a.datname = current_database()
        and a.pid <> pg_backend_pid()
        and (n.nspname is null or n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast'))`,
    [REHEARSAL_APPLICATION],
  );
  return result.rows;
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

export async function rehearse(options: RehearseOptions): Promise<RehearsalStep[]> {
  const every = options.sampleEveryMs ?? 50;
  const watcher = await connect(options.databaseUrl);
  const probe = await connect(options.databaseUrl);
  const steps: RehearsalStep[] = [];
  try {
    for (;;) {
      const tables = await userTables(watcher);
      const locks = new Set<string>();
      let lockWaitSamples = 0;
      let maxLockWaitMs = 0;
      let probeReads = 0;
      let probeErrors = 0;
      let maxProbeMs = 0;
      const done = new AbortController();

      const watching = (async () => {
        while (!done.signal.aborted) {
          const samples = await sampleLocks(watcher);
          let waiting = false;
          for (const sample of samples) {
            if (sample.migrator && sample.granted && sample.relation !== null) {
              locks.add(`${sample.mode} on ${sample.relation}`);
            }
            if (!sample.migrator && !sample.granted) {
              waiting = true;
              maxLockWaitMs = Math.max(maxLockWaitMs, sample.waited_ms ?? 0);
            }
          }
          if (waiting) lockWaitSamples += 1;
          await sleep(every);
        }
      })();

      const probing = (async () => {
        while (!done.signal.aborted) {
          for (const table of tables) {
            const started = performance.now();
            try {
              await probe.query(`select 1 from ${table} limit 1`);
              probeReads += 1;
            } catch {
              // A table the migration dropped or renamed. Counted, because a
              // read the service makes would fail the same way.
              probeErrors += 1;
            }
            maxProbeMs = Math.max(maxProbeMs, performance.now() - started);
          }
          await sleep(every);
        }
      })();

      const started = performance.now();
      let applied: readonly string[];
      try {
        applied = await options.applyNext(
          withApplicationName(options.databaseUrl, REHEARSAL_APPLICATION),
        );
      } finally {
        done.abort();
        await Promise.all([watching, probing]);
      }
      const durationMs = performance.now() - started;
      const [name] = applied;
      if (name === undefined) break;
      steps.push({
        name,
        durationMs,
        locks: [...locks].sort(),
        lockWaitSamples,
        maxLockWaitMs,
        probeReads,
        probeErrors,
        maxProbeMs,
      });
    }
  } finally {
    await Promise.all([watcher.end(), probe.end()]);
  }
  return steps;
}

// Synthetic rows for the rehearsal, one SQL file per migration that created
// the tables it fills, named after that migration. A file runs only once
// its migration is in the released set, so it never targets a table the
// database does not have yet. The row count is read inside the file with
// current_setting('ujira.synthetic_rows')::bigint.
export interface Seed {
  readonly migration: string;
  readonly sql: string;
}

export function loadSeeds(dir: string, released: readonly string[]): Seed[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  // Migration names as the runner records them, without the extension.
  const releasedSet = new Set(released);
  return files
    .filter((file) => file.endsWith('.sql') && releasedSet.has(file.slice(0, -'.sql'.length)))
    .sort()
    .map((file) => ({
      migration: file.slice(0, -'.sql'.length),
      sql: readFileSync(join(dir, file), 'utf8'),
    }));
}

export async function seed(
  databaseUrl: string,
  seeds: readonly Seed[],
  rows: number,
): Promise<void> {
  if (!Number.isSafeInteger(rows) || rows < 0) {
    throw new RangeError('rows must be a whole number of at least 0');
  }
  const client = await connect(databaseUrl);
  try {
    for (const item of seeds) {
      await client.query('begin');
      try {
        await client.query(`select set_config('ujira.synthetic_rows', $1, true)`, [String(rows)]);
        await client.query(item.sql);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}
