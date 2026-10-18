// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Spike: does tenant context stay transaction local through Supavisor's
// transaction pooler? Two tenants alternate on one pooled connection,
// including after a failed transaction, and a second client shares the
// same backend. Runs only when the pooler URLs are in the environment.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TENANT_A,
  TENANT_B,
  bootstrap,
  cleanup,
  close,
  connectAs,
  contextNow,
  runPrefix,
  spikeEnv,
  sqlState,
  tenantDdl,
  tenantTx,
} from './harness.js';
import type { Spike, Tenant } from './harness.js';

const env = spikeEnv();

describe.skipIf(env === null)(
  'tenant context through the transaction pooler',
  { timeout: 120_000 },
  () => {
    let spike: Spike;
    let app: pg.Client;
    let other: pg.Client;
    let s = '';

    beforeAll(async () => {
      if (env === null) return;
      spike = await bootstrap(env, runPrefix('p'));
      s = spike.names.tenantSchema;
      const migrator = await connectAs(env, 'session', spike.logins.migrator);
      await migrator.query(tenantDdl(spike.names));
      await migrator.end();
      app = await connectAs(env, 'transaction', spike.logins.app);
      other = await connectAs(env, 'transaction', spike.logins.app);
      for (const tenant of [TENANT_A, TENANT_B]) {
        await tenantTx(app, tenant, () =>
          app.query(`insert into ${s}.items (principal_id, project_id, note) values ($1, $2, $3)`, [
            tenant.principalId,
            tenant.projectId,
            tenant === TENANT_A ? 'a' : 'b',
          ]),
        );
      }
    }, 180_000);

    afterAll(async () => {
      if (env === null) return;
      await close(app, other);
      // A failed setup leaves nothing to tear down.
      if ((spike as Spike | undefined) === undefined) return;
      await cleanup(spike.admin, spike.names);
      await spike.admin.end();
    }, 120_000);

    const visible = async (client: pg.Client, tenant: Tenant) =>
      tenantTx(client, tenant, async () => {
        const r = await client.query<{ note: string; principal: string }>(
          `select note, current_setting('ujira.principal_id', true) as principal from ${s}.items`,
        );
        return r.rows;
      });

    it('alternates two tenants on one pooled connection with no carry over', async () => {
      for (let i = 0; i < 40; i += 1) {
        const tenant = i % 2 === 0 ? TENANT_A : TENANT_B;
        const rows = await visible(app, tenant);
        expect(rows).toEqual([
          { note: tenant === TENANT_A ? 'a' : 'b', principal: tenant.principalId },
        ]);
        // Between transactions the connection holds no tenant at all.
        expect(await contextNow(app)).toEqual({ principal: '', project: '' });
        expect(await contextNow(other)).toEqual({ principal: '', project: '' });
      }
    });

    it('clears the context after a failed transaction', async () => {
      for (let i = 0; i < 10; i += 1) {
        const failed = await sqlState(() =>
          tenantTx(app, TENANT_A, () => app.query('select 1 / 0')),
        );
        expect(failed).toBe('22012');
        expect(await contextNow(app)).toEqual({ principal: '', project: '' });
        expect(await visible(app, TENANT_B)).toEqual([
          { note: 'b', principal: TENANT_B.principalId },
        ]);
        // A statement after the error inside the same transaction is refused,
        // not run with the old tenant.
        await app.query('begin');
        await app.query(
          "select set_config('ujira.principal_id', $1, true), set_config('ujira.project_id', $2, true)",
          [TENANT_A.principalId, TENANT_A.projectId],
        );
        expect(await sqlState(() => app.query('select 1 / 0'))).toBe('22012');
        expect(await sqlState(() => app.query(`select * from ${s}.items`))).toBe('25P02');
        await app.query('rollback');
        expect(await contextNow(app)).toEqual({ principal: '', project: '' });
      }
    });

    it('runs parameterized and named prepared statements through the pooler', async () => {
      const r = await app.query<{ v: string }>('select $1::text as v', ['x']);
      expect(r.rows).toEqual([{ v: 'x' }]);
      for (let i = 0; i < 3; i += 1) {
        const named = await app.query<{ v: number }>({
          name: 's49_spike_plus_one',
          text: 'select $1::int + 1 as v',
          values: [i],
        });
        expect(named.rows).toEqual([{ v: i + 1 }]);
      }
    });

    it('shows why session level SET is banned: it reaches another client on the same backend', async () => {
      // A SET and the pid read travel in one simple query, so they run on one
      // backend. The other client then reads its pid and the setting in one
      // statement, until it lands on that same backend.
      const setAndPid = await app.query<{ pid: number }>(
        `set ujira.principal_id = '${TENANT_A.principalId}'; select pg_backend_pid() as pid`,
      );
      const results = setAndPid as unknown as { rows: { pid: number }[] }[];
      const leakedPid = results[1]?.rows[0]?.pid;
      expect(leakedPid).toBeTypeOf('number');
      let seen: { pid: number; principal: string | null } | undefined;
      try {
        for (let round = 0; round < 50 && seen?.pid !== leakedPid; round += 1) {
          const r = await other.query<{ pid: number; principal: string | null }>(
            "select pg_backend_pid() as pid, current_setting('ujira.principal_id', true) as principal",
          );
          seen = r.rows[0];
        }
        expect(seen?.pid).toBe(leakedPid);
        // Another client, never told the tenant, reads it from the backend.
        expect(seen?.principal).toBe(TENANT_A.principalId);
      } finally {
        // Reset on the backend that got the SET, so nothing later in this file
        // starts with it.
        for (let round = 0; round < 50; round += 1) {
          const r = await app.query<{ pid: number }>(
            'reset ujira.principal_id; select pg_backend_pid() as pid',
          );
          const after = r as unknown as { rows: { pid: number }[] }[];
          if (after[1]?.rows[0]?.pid === leakedPid) break;
        }
      }
    });

    it('does not deliver notifications to a LISTEN on the transaction pooler', async () => {
      const listener = await connectAs(env ?? spike.env, 'transaction', spike.logins.app);
      try {
        let delivered = false;
        listener.on('notification', () => {
          delivered = true;
        });
        await listener.query('listen s49_spike_wake');
        // Positive control: a session pooled listener on the same channel
        // must get the notification, so the negative result is not just a
        // slow pooler.
        const control = { seen: false };
        spike.admin.on('notification', () => {
          control.seen = true;
        });
        await spike.admin.query('listen s49_spike_wake');
        await spike.admin.query("select pg_notify('s49_spike_wake', 'x')");
        const started = Date.now();
        while (!control.seen && Date.now() - started < 10_000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(control.seen).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        expect(delivered).toBe(false);
        await spike.admin.query('unlisten s49_spike_wake');
      } finally {
        await listener.end();
      }
    });
  },
);
