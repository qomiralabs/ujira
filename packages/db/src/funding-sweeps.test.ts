// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A funding account's deposits are swept into the mandate, each at most once.
// The key on the chain's operation id is what makes a retried sweep safe, and
// the row refuses to claim a state its transaction hash does not back up.

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tokenAmount } from '@ujira/core';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import { MIGRATIONS_DIR, parseMigration } from './migrate.js';
import { entryPoints } from './repositories/entry-points.js';
import {
  fundingSources,
  fundingSweeps,
  mandateInstances,
  mandates,
  type NewFundingSweep,
} from './repositories/mandates.js';
import type { Schema } from './schema.generated.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const AMOUNT = tokenAmount(2_500_000n, 'USDC', 'stellar');

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let tenant: ProjectContext;
let other: ProjectContext;

const asTenant = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.tenant(tenant).transaction(work);
const asOther = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.tenant(other).transaction(work);

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function newInstance(as: typeof asTenant): Promise<string> {
  return as(async (tx) => {
    const mandate = await mandates.create(tx, { name: `mandate ${randomUUID()}` });
    const instance = await mandateInstances.create(tx, {
      network: 'stellar:testnet',
      mandateId: mandate.id,
      chain: 'stellar',
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
    return instance.id;
  });
}

async function newFundingAccount(as: typeof asTenant, mandateInstanceId: string): Promise<string> {
  const source = await as(async (tx) =>
    fundingSources.create(tx, {
      mandateInstanceId,
      kind: 'stellar_funding_account',
      config: { sponsoredReserves: true, sponsorTxHash: randomBytes(32) },
    }),
  );
  return source.id;
}

async function newSweep(change: Partial<NewFundingSweep> = {}): Promise<NewFundingSweep> {
  const mandateInstanceId = change.mandateInstanceId ?? (await newInstance(asTenant));
  return {
    mandateInstanceId,
    fundingSourceId:
      change.fundingSourceId ?? (await newFundingAccount(asTenant, mandateInstanceId)),
    depositOperationId: randomUUID(),
    amount: AMOUNT,
    ...change,
  };
}

function inAnHour(): Date {
  return new Date(Date.now() + 3_600_000);
}

// Moves a sweep's time bounds into the past, which no caller can do, to stand in
// for the time passing. Triggers are off for this one write.
async function boundsPassed(id: string, secondsAgo: number): Promise<void> {
  await admin.query("set session_replication_role = 'replica'");
  try {
    await admin.query('update ujira.funding_sweeps set sweep_valid_until = $1 where id = $2', [
      new Date(Date.now() - secondsAgo * 1000),
      id,
    ]);
  } finally {
    await admin.query("set session_replication_role = 'origin'");
  }
}

async function created(): Promise<string> {
  const input = await newSweep();
  return (await asTenant(async (tx) => fundingSweeps.create(tx, input))).id;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  const first = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'alpha',
      projectName: 'one',
      ownerUserId: randomUUID(),
    }),
  );
  tenant = { principalId: first.principalId, projectId: first.projectId };
  const second = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'bravo',
      projectName: 'one',
      ownerUserId: randomUUID(),
    }),
  );
  other = { principalId: second.principalId, projectId: second.projectId };
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('ujira.funding_sweeps', () => {
  it('records a sweep awaiting its signature, with no hash yet', async () => {
    const input = await newSweep();
    const sweep = await asTenant(async (tx) => fundingSweeps.create(tx, input));
    expect(sweep).toMatchObject({ ...input, status: 'awaiting_signature', sweepTxHash: null });
    expect(await asTenant(async (tx) => fundingSweeps.get(tx, sweep.id))).toEqual(sweep);
    expect(
      await asTenant(async (tx) =>
        fundingSweeps.byDepositOperation(tx, {
          chain: 'stellar',
          depositOperationId: input.depositOperationId,
        }),
      ),
    ).toEqual(sweep);
  });

  it('a second sweep for the same deposit operation is refused', async () => {
    const input = await newSweep();
    await asTenant(async (tx) => fundingSweeps.create(tx, input));
    expect(await codeOf(asTenant(async (tx) => fundingSweeps.create(tx, input)))).toBe('23505');
    // Nor can a different source or tenant claim the operation.
    const retry = await newSweep({ depositOperationId: input.depositOperationId });
    expect(await codeOf(asTenant(async (tx) => fundingSweeps.create(tx, retry)))).toBe('23505');
    const theirInstance = await newInstance(asOther);
    const theirSource = await newFundingAccount(asOther, theirInstance);
    expect(
      await codeOf(
        asOther(async (tx) =>
          fundingSweeps.create(tx, {
            ...input,
            mandateInstanceId: theirInstance,
            fundingSourceId: theirSource,
          }),
        ),
      ),
    ).toBe('23505');
  });

  it('settled without sweep_tx_hash is refused', async () => {
    const input = await newSweep();
    // Writing the row directly, so the check itself answers.
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx
            .insertInto('ujira.funding_sweeps')
            .values({
              principal_id: tenant.principalId,
              project_id: tenant.projectId,
              funding_source_id: input.fundingSourceId,
              mandate_instance_id: input.mandateInstanceId,
              chain: 'stellar',
              asset: 'USDC',
              scale: 7,
              deposit_operation_id: input.depositOperationId,
              amount: '2500000',
              status: 'settled',
            })
            .execute(),
        ),
      ),
    ).toBe('23514');
    // And a submitted row cannot lose its hash on the way to settled.
    const id = await created();
    await asTenant(async (tx) =>
      fundingSweeps.setStatus(tx, id, {
        status: 'submitted',
        sweepTxHash: randomBytes(32),
        validUntil: inAnHour(),
      }),
    );
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx
            .updateTable('ujira.funding_sweeps')
            .set({ status: 'settled', sweep_tx_hash: null })
            .where('id', '=', id)
            .execute(),
        ),
      ),
    ).toBe('UJ006');
  });

  it('submitted without sweep_tx_hash is refused', async () => {
    const id = await created();
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx
            .updateTable('ujira.funding_sweeps')
            .set({ status: 'submitted' })
            .where('id', '=', id)
            .execute(),
        ),
      ),
    ).toBe('23514');
  });

  it('holds on to the hash from submission to settlement', async () => {
    const id = await created();
    const hash = randomBytes(32);
    await asTenant(async (tx) =>
      fundingSweeps.setStatus(tx, id, {
        status: 'submitted',
        sweepTxHash: hash,
        validUntil: inAnHour(),
      }),
    );
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx
            .updateTable('ujira.funding_sweeps')
            .set({ sweep_tx_hash: randomBytes(32) })
            .where('id', '=', id)
            .execute(),
        ),
      ),
    ).toBe('UJ006');
    expect(
      await asTenant(async (tx) => fundingSweeps.setStatus(tx, id, { status: 'settled' })),
    ).toBe(true);
    const settled = await asTenant(async (tx) => fundingSweeps.get(tx, id));
    expect(settled?.status).toBe('settled');
    expect(settled?.sweepTxHash).toEqual(hash);
  });

  it('refuses a submission with no time bounds, or bounds already past', async () => {
    const id = await created();
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx
            .updateTable('ujira.funding_sweeps')
            .set({ status: 'submitted', sweep_tx_hash: randomBytes(32) })
            .where('id', '=', id)
            .execute(),
        ),
      ),
    ).toBe('23514');
    expect(
      await codeOf(
        asTenant(async (tx) =>
          fundingSweeps.setStatus(tx, id, {
            status: 'submitted',
            sweepTxHash: randomBytes(32),
            validUntil: new Date(Date.now() - 1000),
          }),
        ),
      ),
    ).toBe('UJ004');
  });

  it('starts awaiting a signature, whatever the row claims', async () => {
    const input = await newSweep();
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx
            .insertInto('ujira.funding_sweeps')
            .values({
              principal_id: tenant.principalId,
              project_id: tenant.projectId,
              funding_source_id: input.fundingSourceId,
              mandate_instance_id: input.mandateInstanceId,
              chain: 'stellar',
              asset: 'USDC',
              scale: 7,
              deposit_operation_id: input.depositOperationId,
              amount: '2500000',
              status: 'settled',
              sweep_tx_hash: randomBytes(32),
              sweep_valid_until: inAnHour(),
            })
            .execute(),
        ),
      ),
    ).toBe('UJ004');
  });

  it('comes only from a funding account on its own instance', async () => {
    const instance = await newInstance(asTenant);
    const elsewhere = await newFundingAccount(asTenant, await newInstance(asTenant));
    const deposits = await asTenant(async (tx) =>
      fundingSources.create(tx, { mandateInstanceId: instance, kind: 'stablecoin_deposit' }),
    );
    for (const fundingSourceId of [elsewhere, deposits.id]) {
      const input = await newSweep({ mandateInstanceId: instance, fundingSourceId });
      expect(await codeOf(asTenant(async (tx) => fundingSweeps.create(tx, input)))).toBe('23503');
    }
  });

  it('refuses an amount not in the instance unit, and an empty one', async () => {
    // Written directly: one token settles at launch, so the typed amount cannot
    // name a wrong unit.
    const wrong = await newSweep();
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx
            .insertInto('ujira.funding_sweeps')
            .values({
              principal_id: tenant.principalId,
              project_id: tenant.projectId,
              funding_source_id: wrong.fundingSourceId,
              mandate_instance_id: wrong.mandateInstanceId,
              chain: 'stellar',
              asset: 'USDC',
              scale: 6,
              deposit_operation_id: wrong.depositOperationId,
              amount: '1',
            })
            .execute(),
        ),
      ),
    ).toBe('23503');
    const empty = await newSweep({ amount: tokenAmount(0n, 'USDC', 'stellar') });
    expect(await codeOf(asTenant(async (tx) => fundingSweeps.create(tx, empty)))).toBe('23514');
  });

  it.each([
    ['deposit_operation_id', { deposit_operation_id: 'another' }],
    ['amount', { amount: '1' }],
    ['asset', { asset: 'EURC' }],
    ['funding_source_id', { funding_source_id: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' }],
  ])('keeps its %s once written', async (_label, change) => {
    const id = await created();
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx.updateTable('ujira.funding_sweeps').set(change).where('id', '=', id).execute(),
        ),
      ),
    ).toBe('UJ006');
  });

  it('cannot be deleted by the app', async () => {
    const id = await created();
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx.deleteFrom('ujira.funding_sweeps').where('id', '=', id).execute(),
        ),
      ),
    ).toBe('42501');
  });

  it('reports what it has no row for', async () => {
    expect(await asTenant(async (tx) => fundingSweeps.get(tx, randomUUID()))).toBeUndefined();
    expect(
      await asTenant(async (tx) =>
        fundingSweeps.byDepositOperation(tx, { chain: 'stellar', depositOperationId: 'nothing' }),
      ),
    ).toBeUndefined();
    expect(
      await asTenant(async (tx) =>
        fundingSweeps.setStatus(tx, randomUUID(), { status: 'settled' }),
      ),
    ).toBe(false);
  });

  it('pages through its rows', async () => {
    await created();
    await created();
    const first = await asTenant(async (tx) => fundingSweeps.list(tx, { limit: 1 }));
    expect(first.items).toHaveLength(1);
    const after = first.next ?? '';
    expect(after).not.toBe('');
    const second = await asTenant(async (tx) => fundingSweeps.list(tx, { limit: 1, after }));
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });
});

// A sent transaction that might still land must never be followed by another,
// or one deposit is swept twice.
describe('a failed sweep', () => {
  async function submitted(): Promise<string> {
    const id = await created();
    await asTenant(async (tx) =>
      fundingSweeps.setStatus(tx, id, {
        status: 'submitted',
        sweepTxHash: randomBytes(32),
        validUntil: inAnHour(),
      }),
    );
    return id;
  }

  it('an early retry is refused while the transaction might still land', async () => {
    const id = await submitted();
    expect(
      await codeOf(
        asTenant(async (tx) =>
          fundingSweeps.setStatus(tx, id, { status: 'failed', failedLedger: null }),
        ),
      ),
    ).toBe('UJ004');
    // Nor can it skip failing and go straight back.
    expect(
      await codeOf(
        asTenant(async (tx) => fundingSweeps.setStatus(tx, id, { status: 'awaiting_signature' })),
      ),
    ).toBe('UJ006');
    expect((await asTenant(async (tx) => fundingSweeps.get(tx, id)))?.status).toBe('submitted');
  });

  it('is refused just after the time bounds, while the clocks could disagree', async () => {
    const id = await submitted();
    await boundsPassed(id, 60);
    expect(
      await codeOf(
        asTenant(async (tx) =>
          fundingSweeps.setStatus(tx, id, { status: 'failed', failedLedger: null }),
        ),
      ),
    ).toBe('UJ004');
  });

  it('goes round again once the time bounds are well past', async () => {
    const id = await submitted();
    await boundsPassed(id, 301);
    await asTenant(async (tx) =>
      fundingSweeps.setStatus(tx, id, { status: 'failed', failedLedger: null }),
    );
    const failed = await asTenant(async (tx) => fundingSweeps.get(tx, id));
    expect(failed).toMatchObject({ status: 'failed', failedLedger: null });
    expect(failed?.sweepTxHash).not.toBeNull();
    await asTenant(async (tx) => fundingSweeps.setStatus(tx, id, { status: 'awaiting_signature' }));
    expect(await asTenant(async (tx) => fundingSweeps.get(tx, id))).toMatchObject({
      status: 'awaiting_signature',
      sweepTxHash: null,
      validUntil: null,
      failedLedger: null,
    });
  });

  it('goes round again at once when a ledger recorded the failure', async () => {
    const id = await submitted();
    await asTenant(async (tx) =>
      fundingSweeps.setStatus(tx, id, { status: 'failed', failedLedger: 77n }),
    );
    expect((await asTenant(async (tx) => fundingSweeps.get(tx, id)))?.failedLedger).toBe(77n);
    expect(
      await asTenant(async (tx) =>
        fundingSweeps.setStatus(tx, id, { status: 'awaiting_signature' }),
      ),
    ).toBe(true);
  });

  it('keeps what it failed with', async () => {
    const id = await submitted();
    await asTenant(async (tx) =>
      fundingSweeps.setStatus(tx, id, { status: 'failed', failedLedger: 77n }),
    );
    for (const change of [{ failed_ledger: 78n }, { sweep_valid_until: inAnHour() }]) {
      expect(
        await codeOf(
          asTenant(async (tx) =>
            tx.updateTable('ujira.funding_sweeps').set(change).where('id', '=', id).execute(),
          ),
        ),
      ).toBe('UJ006');
    }
  });
});

describe('funding accounts as funding sources', () => {
  it('records the sponsorship and reads it back', async () => {
    const mandateInstanceId = await newInstance(asTenant);
    const sponsorTxHash = randomBytes(32);
    const source = await asTenant(async (tx) =>
      fundingSources.create(tx, {
        mandateInstanceId,
        kind: 'stellar_funding_account',
        config: { sponsoredReserves: true, sponsorTxHash },
      }),
    );
    expect(source.config).toEqual({ sponsoredReserves: true, sponsorTxHash });
    expect(await asTenant(async (tx) => fundingSources.get(tx, source.id))).toEqual(source);
    const row = await admin.query<{ config: unknown }>(
      'select config from ujira.funding_sources where id = $1',
      [source.id],
    );
    expect(row.rows[0]?.config).toEqual({
      sponsored_reserves: true,
      sponsor_tx_hash: sponsorTxHash.toString('hex'),
    });
  });

  it('leaves a stablecoin deposit source with no config', async () => {
    const mandateInstanceId = await newInstance(asTenant);
    const source = await asTenant(async (tx) =>
      fundingSources.create(tx, { mandateInstanceId, kind: 'stablecoin_deposit' }),
    );
    expect(source.config).toBeNull();
  });

  const HASH = 'ab'.repeat(32);
  it.each<[string, string, unknown]>([
    ['no config', 'stellar_funding_account', {}],
    ['no hash', 'stellar_funding_account', { sponsored_reserves: true }],
    ['no sponsorship', 'stellar_funding_account', { sponsor_tx_hash: HASH }],
    [
      'unsponsored reserves',
      'stellar_funding_account',
      { sponsored_reserves: false, sponsor_tx_hash: HASH },
    ],
    [
      'a short hash',
      'stellar_funding_account',
      { sponsored_reserves: true, sponsor_tx_hash: 'ab' },
    ],
    [
      'upper case hex',
      'stellar_funding_account',
      { sponsored_reserves: true, sponsor_tx_hash: 'AB'.repeat(32) },
    ],
    [
      'a number for a hash',
      'stellar_funding_account',
      { sponsored_reserves: true, sponsor_tx_hash: 1 },
    ],
    ['a null hash', 'stellar_funding_account', { sponsored_reserves: true, sponsor_tx_hash: null }],
    [
      'anything extra',
      'stellar_funding_account',
      { sponsored_reserves: true, sponsor_tx_hash: HASH, note: 'x' },
    ],
    ['a config that is not an object', 'stellar_funding_account', 1],
    [
      'config on a stablecoin deposit',
      'stablecoin_deposit',
      { sponsored_reserves: true, sponsor_tx_hash: HASH },
    ],
  ])('refuses %s', async (_label, kind, config) => {
    const mandateInstanceId = await newInstance(asTenant);
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx
            .insertInto('ujira.funding_sources')
            .values({
              principal_id: tenant.principalId,
              project_id: tenant.projectId,
              mandate_instance_id: mandateInstanceId,
              kind,
              config: JSON.stringify(config),
            })
            .execute(),
        ),
      ),
    ).toBe('23514');
  });
});

describe('validating the funding source constraints', () => {
  // Tests migrate as a superuser, so nothing else would notice this needing the
  // owner's rights: the real migration login holds them only after set role.
  it('runs in both directions as the migration login', async () => {
    const name = '1794355200001_funding_sources_validate.sql';
    const migration = parseMigration(name, readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
    expect(migration.transactional).toBe(false);
    await admin.query('set session authorization ujira_migrator');
    try {
      await admin.query(migration.down);
      await admin.query(migration.up);
    } finally {
      await admin.query('reset session authorization');
    }
    const constraints = await admin.query<{ conname: string; convalidated: boolean }>(
      `select conname, convalidated
         from pg_catalog.pg_constraint
        where conrelid = 'ujira.funding_sources'::regclass
          and conname in ('funding_sources_kind', 'funding_sources_config_shape')
        order by conname`,
    );
    expect(constraints.rows).toEqual([
      { conname: 'funding_sources_config_shape', convalidated: true },
      { conname: 'funding_sources_kind', convalidated: true },
    ]);
  });
});
