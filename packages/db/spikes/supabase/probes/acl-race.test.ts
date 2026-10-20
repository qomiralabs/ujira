// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Probe: do two database ACL edits at the same moment conflict? Opt in with
// SUPABASE_SPIKE_PROBES=1 on top of the spike environment. The counts are
// written to SPIKE_PROBE_RESULTS when set. Both probe roles are dropped
// afterwards.

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, probesEnabled, safeMessage, spikeEnv } from '../harness.js';

const env = spikeEnv();
const ROUNDS = 30;

describe.skipIf(env === null || !probesEnabled())(
  'concurrent database ACL edits',
  { timeout: 600_000 },
  () => {
    let first: pg.Client;
    let second: pg.Client;
    const tag = randomBytes(3).toString('hex');
    const roles = [`s49a${tag}_one`, `s49a${tag}_two`];

    beforeAll(async () => {
      if (env === null) return;
      first = await connect(env.session);
      second = await connect(env.session);
      for (const role of roles) await first.query(`create role ${role} nologin`);
    });

    afterAll(async () => {
      if (env === null) return;
      for (const role of roles) {
        await first.query(`revoke all on database postgres from ${role}`).catch(() => undefined);
        await first.query(`drop role if exists ${role}`).catch(() => undefined);
      }
      await first.end();
      await second.end();
    });

    it('counts "tuple concurrently updated" over parallel grant and revoke pairs', async () => {
      let conflicts = 0;
      let other = 0;
      const run = async (client: pg.Client, sql: string) => {
        try {
          await client.query(sql);
        } catch (err) {
          if (safeMessage(err).includes('tuple concurrently updated')) conflicts += 1;
          else other += 1;
        }
      };
      for (let i = 0; i < ROUNDS; i += 1) {
        await Promise.all([
          run(first, `grant create on database postgres to ${roles[0] ?? ''}`),
          run(second, `grant create on database postgres to ${roles[1] ?? ''}`),
        ]);
        await Promise.all([
          run(first, `revoke create on database postgres from ${roles[0] ?? ''}`),
          run(second, `revoke create on database postgres from ${roles[1] ?? ''}`),
        ]);
      }
      const result = { statements: ROUNDS * 4, conflicts, otherErrors: other };
      const file = process.env['SPIKE_PROBE_RESULTS'];
      if (file) writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      expect(other).toBe(0);
    });
  },
);
