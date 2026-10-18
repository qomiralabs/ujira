// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Probe: how does Supavisor's password cache behave when a login is rotated,
// recreated or revoked? Opt in with SUPABASE_SPIKE_PROBES=1 on top of the
// spike environment. Every timing is written to SPIKE_PROBE_RESULTS when
// set. The probe role is dropped afterwards.

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, poolerUrl, probesEnabled, scramVerifier, spikeEnv } from '../harness.js';
import type { Login, PoolerMode, SpikeEnv } from '../harness.js';

const env = spikeEnv();
const MODES: readonly PoolerMode[] = ['session', 'transaction'];
// How long to keep trying before calling a state final.
const LIMIT_MS = 180_000;
const results: Record<string, unknown> = {};

async function canLogin(e: SpikeEnv, mode: PoolerMode, login: Login): Promise<boolean> {
  try {
    const c = await connect(poolerUrl(e, mode, login));
    await c.end();
    return true;
  } catch {
    return false;
  }
}

/** Seconds until `want` holds for a login in `mode`, or null if it never did within the limit. */
async function secondsUntil(
  e: SpikeEnv,
  mode: PoolerMode,
  login: Login,
  want: boolean,
): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < LIMIT_MS) {
    if ((await canLogin(e, mode, login)) === want) return Math.round((Date.now() - started) / 1000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

describe.skipIf(env === null || !probesEnabled())(
  'Supavisor password cache',
  { timeout: 1_800_000 },
  () => {
    let admin: pg.Client;
    const role = `s49c${randomBytes(3).toString('hex')}_probe`;
    const secret = () => randomBytes(24).toString('base64url');

    beforeAll(async () => {
      if (env === null) return;
      admin = await connect(env.session);
    });

    afterAll(async () => {
      if (env === null) return;
      const file = process.env['SPIKE_PROBE_RESULTS'];
      if (file) writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
      await admin.query(`drop role if exists ${role}`).catch(() => undefined);
      await admin.end();
    });

    it('rotation: how long the old password keeps working, and when the new one starts', async () => {
      if (env === null) return;
      const first: Login = { role, password: secret() };
      await admin.query(
        `create role ${role} login nobypassrls password '${scramVerifier(first.password)}'`,
      );
      for (const mode of MODES) expect(await secondsUntil(env, mode, first, true)).not.toBeNull();
      const second: Login = { role, password: secret() };
      await admin.query(`alter role ${role} password '${scramVerifier(second.password)}'`);
      for (const mode of MODES) {
        results[`rotate.${mode}.oldRefusedAfterSeconds`] = await secondsUntil(
          env,
          mode,
          first,
          false,
        );
        results[`rotate.${mode}.newAcceptedAfterSeconds`] = await secondsUntil(
          env,
          mode,
          second,
          true,
        );
      }
      for (const mode of MODES) {
        expect(results[`rotate.${mode}.oldRefusedAfterSeconds`]).not.toBeNull();
        expect(results[`rotate.${mode}.newAcceptedAfterSeconds`]).not.toBeNull();
      }
    });

    it('recreation: how long a dropped and recreated login refuses its new password', async () => {
      if (env === null) return;
      await admin.query(`drop role ${role}`);
      const fresh: Login = { role, password: secret() };
      await admin.query(
        `create role ${role} login nobypassrls password '${scramVerifier(fresh.password)}'`,
      );
      for (const mode of MODES) {
        results[`recreate.${mode}.newAcceptedAfterSeconds`] = await secondsUntil(
          env,
          mode,
          fresh,
          true,
        );
        expect(results[`recreate.${mode}.newAcceptedAfterSeconds`]).not.toBeNull();
      }
    });

    it('revocation: NOLOGIN and terminating its backends, then how long logins still work', async () => {
      if (env === null) return;
      const current: Login = { role, password: secret() };
      await admin.query(`alter role ${role} password '${scramVerifier(current.password)}'`);
      for (const mode of MODES) expect(await secondsUntil(env, mode, current, true)).not.toBeNull();
      // An open session survives NOLOGIN until its backend is terminated.
      const held = await connect(poolerUrl(env, 'session', current));
      await admin.query(`alter role ${role} nologin`);
      const stillOpen = await held
        .query('select 1')
        .then(() => true)
        .catch(() => false);
      results['revoke.openSessionWorksAfterNologin'] = stillOpen;
      const terminated = await admin.query<{ n: number }>(
        'select count(*)::int as n from (select pg_terminate_backend(pid) from pg_stat_activity where usename = $1) t',
        [role],
      );
      results['revoke.backendsTerminated'] = terminated.rows[0]?.n ?? 0;
      results['revoke.openSessionWorksAfterTerminate'] = await held
        .query('select 1')
        .then(() => true)
        .catch(() => false);
      await held.end().catch(() => undefined);
      for (const mode of MODES) {
        results[`revoke.${mode}.refusedAfterSeconds`] = await secondsUntil(
          env,
          mode,
          current,
          false,
        );
        expect(results[`revoke.${mode}.refusedAfterSeconds`]).not.toBeNull();
      }
    });
  },
);
