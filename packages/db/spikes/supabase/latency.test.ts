// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Spike: what does setting tenant context add to a repository transaction
// through the transaction pooler? Times a tenant transaction (begin, the
// context statement, one read, commit) against the same transaction
// without the context statement, from wherever this runs.
//
// Every figure here is the network round trip of wherever it ran, so the
// numbers mean little outside the region; only the difference between the
// two transactions carries over. The default run count is small enough to
// finish from anywhere. SPIKE_LATENCY_RUNS raises it: the figures in the
// results file came from 200 runs, which takes several minutes from far
// away and can outrun the timeout below.
//
// Set SPIKE_RESULTS_FILE to keep the numbers. Runs only when the pooler
// URLs are in the environment.

import { writeFileSync } from 'node:fs';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TENANT_A,
  bootstrap,
  cleanup,
  close,
  connectAs,
  runPrefix,
  spikeEnv,
  tenantDdl,
} from './harness.js';
import type { Spike } from './harness.js';

const env = spikeEnv();
const DEFAULT_RUNS = 20;
const MAX_RUNS = 5_000;

/** How many timed pairs to run: SPIKE_LATENCY_RUNS, else DEFAULT_RUNS. */
function runCount(): number {
  const raw = process.env['SPIKE_LATENCY_RUNS'];
  if (raw === undefined || raw === '') return DEFAULT_RUNS;
  const runs = Number(raw);
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw new Error(`SPIKE_LATENCY_RUNS must be a whole number from 1 to ${String(MAX_RUNS)}`);
  }
  return runs;
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

function summary(samples: number[]): { p50: number; p95: number; mean: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((acc, x) => acc + x, 0) / samples.length;
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), mean };
}

describe.skipIf(env === null)('tenant context round trip', { timeout: 900_000 }, () => {
  let spike: Spike;
  let app: pg.Client;

  beforeAll(async () => {
    if (env === null) return;
    spike = await bootstrap(env, runPrefix('l'));
    const migrator = await connectAs(env, 'session', spike.logins.migrator);
    await migrator.query(tenantDdl(spike.names));
    await migrator.end();
    app = await connectAs(env, 'transaction', spike.logins.app);
  }, 180_000);

  afterAll(async () => {
    if (env === null) return;
    await close(app);
    // A failed setup leaves nothing to tear down.
    if ((spike as Spike | undefined) === undefined) return;
    await cleanup(spike.admin, spike.names);
    await spike.admin.end();
  }, 120_000);

  it('measures p50 and p95 with and without the context statement', async () => {
    const time = async (withContext: boolean): Promise<number> => {
      const started = performance.now();
      await app.query('begin');
      if (withContext) {
        await app.query(
          "select set_config('ujira.principal_id', $1, true), set_config('ujira.project_id', $2, true)",
          [TENANT_A.principalId, TENANT_A.projectId],
        );
      }
      // The same read either way, so the difference is the context statement.
      await app.query('select 1');
      await app.query('commit');
      return performance.now() - started;
    };
    const runs = runCount();
    // Warm the connection and plans before measuring.
    for (let i = 0; i < 20; i += 1) {
      await time(true);
      await time(false);
    }
    const plain: number[] = [];
    const tenant: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      plain.push(await time(false));
      tenant.push(await time(true));
    }
    // One bare round trip, to compare the added cost against.
    const roundTrip: number[] = [];
    for (let i = 0; i < Math.min(runs, 100); i += 1) {
      const started = performance.now();
      await app.query('select 1');
      roundTrip.push(performance.now() - started);
    }
    // The server's own cost of the two set_config calls, timed inside one
    // block so no network is involved.
    let serverUs = Number.NaN;
    const onNotice = (msg: { message?: string | undefined }) => {
      const match = /^context_pair_us=([0-9.]+)$/.exec(msg.message ?? '');
      if (match) serverUs = Number(match[1]);
    };
    app.on('notice', onNotice);
    await app.query(`do $$
      declare t0 timestamptz := clock_timestamp();
      begin
        for i in 1..10000 loop
          perform set_config('ujira.principal_id', '${TENANT_A.principalId}', true),
                  set_config('ujira.project_id', '${TENANT_A.projectId}', true);
        end loop;
        raise notice 'context_pair_us=%',
          round((extract(epoch from clock_timestamp() - t0) * 1e6 / 10000)::numeric, 2);
      end $$`);
    app.off('notice', onNotice);
    const result = {
      runs,
      roundTripMs: summary(roundTrip),
      serverMicrosecondsPerContextPair: serverUs,
      plainTransactionMs: summary(plain),
      tenantTransactionMs: summary(tenant),
      addedP50Ms: summary(tenant).p50 - summary(plain).p50,
      addedP95Ms: summary(tenant).p95 - summary(plain).p95,
    };
    const file = process.env['SPIKE_RESULTS_FILE'];
    if (file) writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    expect(result.tenantTransactionMs.p50).toBeGreaterThan(0);
    expect(serverUs).toBeGreaterThan(0);
  });
});
