// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every move between two funding sweep statuses, allowed or not. The table is
// written out in full, so adding a transition to the database without meaning
// to fails here.

import { randomBytes, randomUUID } from 'node:crypto';

import { tokenAmount } from '@ujira/core';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import {
  fundingSources,
  fundingSweeps,
  mandateInstances,
  mandates,
  type FundingSweepMove,
  type FundingSweepStatus,
} from './repositories/mandates.js';
import type { Schema } from './schema.generated.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const STATUSES: readonly FundingSweepStatus[] = [
  'awaiting_signature',
  'submitted',
  'settled',
  'failed',
  'cancelled',
];

const ALLOWED: Readonly<Record<FundingSweepStatus, readonly FundingSweepStatus[]>> = {
  awaiting_signature: ['submitted', 'cancelled'],
  submitted: ['settled', 'failed'],
  settled: [],
  failed: ['awaiting_signature'],
  cancelled: [],
};

// The shortest allowed road to each status from a new row.
const ROAD: Readonly<Record<FundingSweepStatus, readonly FundingSweepStatus[]>> = {
  awaiting_signature: [],
  submitted: ['submitted'],
  settled: ['submitted', 'settled'],
  failed: ['submitted', 'failed'],
  cancelled: ['cancelled'],
};

let database: TestDatabase;
let db: Database;
let tenant: ProjectContext;
let instanceId: string;
let sourceId: string;

const asTenant = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.tenant(tenant).transaction(work);

function moveTo(status: FundingSweepStatus): FundingSweepMove {
  if (status === 'submitted') {
    return { status, sweepTxHash: randomBytes(32), validUntil: new Date(Date.now() + 3_600_000) };
  }
  return status === 'failed' ? { status, failedLedger: 1n } : { status };
}

async function sweepAt(status: FundingSweepStatus): Promise<string> {
  const sweep = await asTenant(async (tx) =>
    fundingSweeps.create(tx, {
      fundingSourceId: sourceId,
      mandateInstanceId: instanceId,
      depositOperationId: randomUUID(),
      amount: tokenAmount(100n, 'USDC', 'stellar'),
    }),
  );
  for (const step of ROAD[status]) {
    await asTenant(async (tx) => fundingSweeps.setStatus(tx, sweep.id, moveTo(step)));
  }
  return sweep.id;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  const created = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'alpha',
      projectName: 'one',
      ownerUserId: randomUUID(),
    }),
  );
  tenant = { principalId: created.principalId, projectId: created.projectId };
  const setup = await asTenant(async (tx) => {
    const mandate = await mandates.create(tx, { name: 'sweeps' });
    const instance = await mandateInstances.create(tx, {
      network: 'stellar:testnet',
      mandateId: mandate.id,
      chain: 'stellar',
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
    const source = await fundingSources.create(tx, {
      mandateInstanceId: instance.id,
      kind: 'stellar_funding_account',
      config: { sponsoredReserves: true, sponsorTxHash: randomBytes(32) },
    });
    return { instanceId: instance.id, sourceId: source.id };
  });
  instanceId = setup.instanceId;
  sourceId = setup.sourceId;
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

const moves = STATUSES.flatMap((from) =>
  STATUSES.filter((to) => to !== from).map((to) => ({
    from,
    to,
    allowed: ALLOWED[from].includes(to),
  })),
);

describe('funding sweep transitions', () => {
  it.each(moves)('$from to $to: allowed $allowed', async ({ from, to, allowed }) => {
    const id = await sweepAt(from);
    if (allowed) {
      expect(await asTenant(async (tx) => fundingSweeps.setStatus(tx, id, moveTo(to)))).toBe(true);
      expect((await asTenant(async (tx) => fundingSweeps.get(tx, id)))?.status).toBe(to);
      return;
    }
    // The status alone, so what answers is the machine and not the hash rules.
    await expect(
      asTenant(async (tx) =>
        tx.updateTable('ujira.funding_sweeps').set({ status: to }).where('id', '=', id).execute(),
      ),
    ).rejects.toMatchObject({ code: 'UJ004' });
    expect((await asTenant(async (tx) => fundingSweeps.get(tx, id)))?.status).toBe(from);
  });

  it('agrees with the rows the database holds', async () => {
    const rows = await asTenant(async (tx) =>
      tx
        .selectFrom('ujira.status_transitions')
        .select(['from_status', 'to_status'])
        .where('machine', '=', 'funding_sweep')
        .execute(),
    );
    const held = rows.map((row) => `${row.from_status}>${row.to_status}`).sort();
    const written = moves
      .filter((move) => move.allowed)
      .map((move) => `${move.from}>${move.to}`)
      .sort();
    expect(held).toEqual(written);
  });
});
