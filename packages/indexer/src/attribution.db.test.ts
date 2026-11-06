// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A deposit followed from the account that received it to the sweep it starts, with two
// projects under one principal. Every piece has its own tests, but the guarantee only
// exists across all of them: money sent to a project's account is credited to that
// project and swept to that project's mandate, and never to its sibling's.

import { randomBytes, randomUUID } from 'node:crypto';

import type { FundingAccountRecord, TenantScope, WatchedMandate } from '@ujira/chain-adapter';
import { tokenAmount } from '@ujira/core';
import { entryPoints, mandateInstances, mandates, projects } from '@ujira/db';
import type { Database } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { FundingAccountConflictError, FundingAccountInUseError } from '@ujira/funding';
import { createDbFundingAccountStores, createDbSweepStore } from '@ujira/funding/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { dbWatchedAddresses, type UnroutableAddress } from './watched.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const NETWORK = 'stellar:testnet';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

const stores = () => createDbFundingAccountStores(db);

async function twoProjects(): Promise<readonly [TenantScope, TenantScope]> {
  const created = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: randomUUID(),
      projectName: 'first',
      ownerUserId: randomUUID(),
    }),
  );
  const first = { principalId: created.principalId, projectId: created.projectId };
  const projectId = await db
    .tenant(first)
    .transaction(async (tx) => projects.create(tx, { name: 'second' }));
  return [first, { principalId: created.principalId, projectId }] as unknown as readonly [
    TenantScope,
    TenantScope,
  ];
}

async function newInstance(scope: TenantScope) {
  return db.tenant(scope).transaction(async (tx) => {
    const mandate = await mandates.create(tx, { name: `mandate ${randomUUID()}` });
    return mandateInstances.create(tx, {
      mandateId: mandate.id,
      chain: 'stellar',
      network: NETWORK,
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
  });
}

function accountOf(scope: TenantScope, address = `G${randomUUID()}`): FundingAccountRecord {
  return {
    principalId: scope.principalId,
    projectId: scope.projectId,
    network: NETWORK,
    address,
    sponsor: `G${randomUUID()}`,
    sponsorTxHash: randomBytes(32).toString('hex'),
    status: 'active',
    faults: [],
  };
}

/** A project with its own account funding its own mandate. */
async function funded(scope: TenantScope) {
  const instance = await newInstance(scope);
  const account = accountOf(scope);
  await stores().accounts.record(account);
  const sourceId = await stores().sources.attach(scope, {
    network: NETWORK,
    mandateInstanceId: instance.id,
  });
  if (sourceId === null) throw new Error('not attached');
  return { scope, instance, account, sourceId };
}

function watcher() {
  const refused: UnroutableAddress[] = [];
  const isWatched = dbWatchedAddresses({
    db,
    network: NETWORK,
    onUnroutable: (event) => refused.push(event),
  });
  const watch = (address: string): Promise<WatchedMandate | null> =>
    isWatched({ network: NETWORK, value: address });
  return { watch, refused };
}

describe('two projects under one principal', () => {
  it('have an account each, and each reads only its own', async () => {
    const [first, second] = await twoProjects();
    const a = await funded(first);
    const b = await funded(second);
    expect(a.account.address).not.toBe(b.account.address);
    expect((await stores().accounts.forProject(first, NETWORK))?.address).toBe(a.account.address);
    expect((await stores().accounts.forProject(second, NETWORK))?.address).toBe(b.account.address);
  });

  it('are each credited for what reaches their own account', async () => {
    const [first, second] = await twoProjects();
    const a = await funded(first);
    const b = await funded(second);
    const { watch, refused } = watcher();
    for (const each of [a, b]) {
      expect(await watch(each.account.address)).toEqual({
        scope: each.scope,
        mandate: {
          network: NETWORK,
          address: { network: NETWORK, value: each.instance.contractAddress },
          specVersion: 1,
        },
        asset: 'USDC',
        forwarding: {
          fundingSourceId: each.sourceId,
          mandateInstanceId: each.instance.id,
          forwarder: each.account.address,
          mandate: each.instance.contractAddress,
        },
      });
    }
    expect(refused).toEqual([]);
  });

  it('sweep under the project the deposit was credited to, out of sight of the other', async () => {
    const [first, second] = await twoProjects();
    const a = await funded(first);
    const b = await funded(second);
    const { watch } = watcher();
    const watched = await watch(a.account.address);
    if (watched?.forwarding === undefined) throw new Error('not a forwarding deposit');
    const sweeps = createDbSweepStore(db);
    const depositOperationId = `${String(Date.now())}-0`;
    const sweep = await sweeps.create(watched.scope, {
      fundingSourceId: watched.forwarding.fundingSourceId,
      mandateInstanceId: watched.forwarding.mandateInstanceId,
      depositOperationId,
      amount: tokenAmount(100n, 'USDC', 'stellar'),
    });
    if (sweep === 'duplicate') throw new Error('not a new sweep');
    expect(sweep.mandateInstanceId).toBe(a.instance.id);
    const key = { chain: 'stellar', depositOperationId };
    expect((await sweeps.byDepositOperation(first, key))?.id).toBe(sweep.id);
    expect(await sweeps.byDepositOperation(second, key)).toBeUndefined();
    // Nor can the sibling's account be pointed at this project's mandate.
    await expect(
      sweeps.create(second, {
        fundingSourceId: b.sourceId,
        mandateInstanceId: a.instance.id,
        depositOperationId: `${String(Date.now())}-1`,
        amount: tokenAmount(100n, 'USDC', 'stellar'),
      }),
    ).rejects.toBeDefined();
  });

  // What the per project key does not change: a transfer still cannot say which mandate
  // it is for, so one account keeps funding one mandate.
  it('still cannot attach a second mandate to one account, and neither route moves', async () => {
    const [first, second] = await twoProjects();
    const a = await funded(first);
    const b = await funded(second);
    const another = await newInstance(first);
    await expect(
      stores().sources.attach(first, { network: NETWORK, mandateInstanceId: another.id }),
    ).rejects.toBeInstanceOf(FundingAccountInUseError);
    const { watch, refused } = watcher();
    expect((await watch(a.account.address))?.forwarding?.mandateInstanceId).toBe(a.instance.id);
    expect((await watch(b.account.address))?.forwarding?.mandateInstanceId).toBe(b.instance.id);
    expect(refused).toEqual([]);
  });

  it('cannot hold one address between them', async () => {
    const [first, second] = await twoProjects();
    const a = await funded(first);
    await expect(
      stores().accounts.record(accountOf(second, a.account.address)),
    ).rejects.toBeInstanceOf(FundingAccountConflictError);
    const { watch } = watcher();
    expect((await watch(a.account.address))?.scope).toEqual(first);
  });
});
