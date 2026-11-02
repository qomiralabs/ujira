// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What every ledger test starts from: a tenant with one mandate instance, and
// a way to post under the indexer's login the way the service does.

import { randomBytes, randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';

import type { Database, ProjectContext } from '../database.js';
import { entryPoints, type CreatedPrincipal } from '../repositories/entry-points.js';
import { ledger, type LedgerEntryInput, type PostResult } from '../repositories/ledger.js';
import { chainEvents, mandateInstances, mandates } from '../repositories/mandates.js';
import type { Schema } from '../schema.generated.js';

export interface LedgerFixture {
  readonly tenant: CreatedPrincipal;
  readonly instanceId: string;
}

export async function asIndexer<T>(
  db: Database,
  context: ProjectContext,
  work: (tx: Kysely<Schema>) => Promise<T>,
): Promise<T> {
  return db.withTenant('worker', { ...context, scope: 'project' }, work);
}

export async function ledgerFixture(db: Database): Promise<LedgerFixture> {
  const tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
  const instance = await db.tenant(tenant).transaction(async (tx) => {
    const mandate = await mandates.create(tx, { name: 'Payroll' });
    return mandateInstances.create(tx, {
      mandateId: mandate.id,
      chain: 'stellar',
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
  });
  return { tenant, instanceId: instance.id };
}

export async function recordEvent(
  tx: Kysely<Schema>,
  instanceId: string,
  ledgerNumber = 1n,
): Promise<string> {
  const { id } = await chainEvents.record(tx, {
    mandateInstanceId: instanceId,
    chain: 'stellar',
    txHash: randomBytes(32),
    eventIndex: 0n,
    ledger: ledgerNumber,
    eventType: 'fixture',
    payload: {},
    finalizedAt: new Date(),
  });
  if (id === undefined) throw new Error('the fixture event was not stored');
  return id;
}

// One event and its journal, in one transaction.
export async function postEvent(
  db: Database,
  fixture: LedgerFixture,
  entries: readonly LedgerEntryInput[],
): Promise<PostResult> {
  return asIndexer(db, fixture.tenant, async (tx) => {
    const chainEventId = await recordEvent(tx, fixture.instanceId);
    return ledger.post(tx, { mandateInstanceId: fixture.instanceId, chainEventId, entries });
  });
}

export function deposit(amount: bigint): readonly LedgerEntryInput[] {
  return [
    { kind: 'external', amount: -amount },
    { kind: 'balance', amount },
  ];
}
