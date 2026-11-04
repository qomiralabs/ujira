// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import {
  fundingSources,
  mandateInstances,
  mandates,
  type NewMandateInstance,
} from './repositories/mandates.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let tenant: CreatedPrincipal;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function newMandate(): Promise<string> {
  const mandate = await db
    .tenant(tenant)
    .transaction(async (tx) => mandates.create(tx, { name: 'Payroll' }));
  return mandate.id;
}

async function createInstance(
  mandateId: string,
  overrides: { asset?: string; chain?: string; scale?: number; contractAddress?: string } = {},
) {
  return db.tenant(tenant).transaction(async (tx) =>
    mandateInstances.create(tx, {
      network: 'stellar:testnet',
      mandateId,
      chain: overrides.chain ?? 'stellar',
      contractAddress: overrides.contractAddress ?? `C${randomUUID()}`,
      specVersion: '1',
      asset: overrides.asset ?? 'USDC',
      scale: overrides.scale ?? 7,
    }),
  );
}

describe('the network of a mandate instance', () => {
  const instance = async (network: string, chain = 'stellar') => {
    const mandateId = await newMandate();
    return db.tenant(tenant).transaction(async (tx) =>
      mandateInstances.create(tx, {
        network,
        mandateId,
        chain,
        contractAddress: `C${randomUUID()}`,
        specVersion: '1',
        asset: 'USDC',
        scale: 7,
      }),
    );
  };

  it('is recorded and read back', async () => {
    const made = await instance('stellar:pubnet');
    expect(made.network).toBe('stellar:pubnet');
    const read = await db
      .tenant(tenant)
      .transaction(async (tx) => mandateInstances.get(tx, made.id));
    expect(read?.network).toBe('stellar:pubnet');
  });

  it('refuses a network the system does not run', async () => {
    expect(await codeOf(instance('stellar:futurenet'))).toBe('23514');
  });

  it('refuses a new instance that does not say', async () => {
    const mandateId = await newMandate();
    const attempt = db.tenant(tenant).transaction(async (tx) =>
      mandateInstances.create(tx, {
        mandateId,
        chain: 'stellar',
        contractAddress: `C${randomUUID()}`,
        specVersion: '1',
        asset: 'USDC',
        scale: 7,
      } as NewMandateInstance),
    );
    expect(await codeOf(attempt)).toBe('23514');
  });
});

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('mandate instances', () => {
  it('accepts USDC on stellar at scale 7', async () => {
    const created = await createInstance(await newMandate());
    expect(created.asset).toBe('USDC');
    expect(created.scale).toBe(7);
  });

  it('USDm on stellar is rejected', async () => {
    expect(await codeOf(createInstance(await newMandate(), { asset: 'USDm', scale: 18 }))).toBe(
      '23503',
    );
    expect(await codeOf(createInstance(await newMandate(), { asset: 'USDM', scale: 7 }))).toBe(
      '23503',
    );
  });

  it('rejects USDC at another scale, and on a chain that does not settle it', async () => {
    expect(await codeOf(createInstance(await newMandate(), { scale: 6 }))).toBe('23503');
    // The network is not on that chain, which the check says before the key can.
    expect(await codeOf(createInstance(await newMandate(), { chain: 'celo' }))).toBe('23514');
  });

  it('holds one contract address once on a chain, across every tenant', async () => {
    const contractAddress = `C${randomUUID()}`;
    await createInstance(await newMandate(), { contractAddress });
    expect(await codeOf(createInstance(await newMandate(), { contractAddress }))).toBe('23505');
  });

  it('holds one instance per mandate, chain and asset', async () => {
    const mandateId = await newMandate();
    await createInstance(mandateId);
    expect(await codeOf(createInstance(mandateId))).toBe('23505');
  });

  it('refuses a mandate of another project', async () => {
    expect(await codeOf(createInstance(randomUUID()))).toBe('23503');
  });

  it('lists and reads its own, a page at a time', async () => {
    const created = await createInstance(await newMandate());
    await createInstance(await newMandate());
    const session = db.tenant(tenant);
    expect(await session.transaction(async (tx) => mandateInstances.get(tx, created.id))).toEqual(
      created,
    );
    const first = await session.transaction(async (tx) => mandateInstances.list(tx, { limit: 1 }));
    expect(first.items).toHaveLength(1);
    const after = first.next ?? '';
    const rest = await session.transaction(async (tx) =>
      mandateInstances.list(tx, { limit: 100, after }),
    );
    expect(rest.items.map((item) => item.id)).not.toContain(first.items[0]?.id);
  });
});

describe('mandates', () => {
  it('creates, renames, reads and pages', async () => {
    const id = await newMandate();
    await newMandate();
    const session = db.tenant(tenant);
    expect(await session.transaction(async (tx) => mandates.rename(tx, id, 'Renamed'))).toBe(true);
    expect((await session.transaction(async (tx) => mandates.get(tx, id)))?.name).toBe('Renamed');
    const first = await session.transaction(async (tx) => mandates.list(tx, { limit: 1 }));
    const after = first.next ?? '';
    const rest = await session.transaction(async (tx) => mandates.list(tx, { limit: 100, after }));
    expect(rest.items.map((item) => item.id)).not.toContain(first.items[0]?.id);
  });
});

describe('funding sources', () => {
  it('accepts a stablecoin deposit source and nothing else at launch', async () => {
    const instance = await createInstance(await newMandate());
    const session = db.tenant(tenant);
    const created = await session.transaction(async (tx) =>
      fundingSources.create(tx, { mandateInstanceId: instance.id, kind: 'stablecoin_deposit' }),
    );
    expect(await session.transaction(async (tx) => fundingSources.get(tx, created.id))).toEqual(
      created,
    );
    await session.transaction(async (tx) =>
      fundingSources.create(tx, { mandateInstanceId: instance.id, kind: 'stablecoin_deposit' }),
    );
    const first = await session.transaction(async (tx) => fundingSources.list(tx, { limit: 1 }));
    const after = first.next ?? '';
    const rest = await session.transaction(async (tx) =>
      fundingSources.list(tx, { limit: 100, after }),
    );
    expect(rest.items.map((item) => item.id)).not.toContain(first.items[0]?.id);
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          fundingSources.create(tx, {
            mandateInstanceId: instance.id,
            kind: 'fiat' as 'stablecoin_deposit',
          }),
        ),
      ),
    ).toBe('23514');
  });
});

describe('project funding settings', () => {
  it('defaults to no fallback and a 14 day hold, and refuses values out of range', async () => {
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const defaults = await admin.query<{ fallback: string; seconds: string }>(
        `select chain_fallback as fallback, funding_hold_max_seconds::text as seconds
           from ujira.projects where id = $1`,
        [tenant.projectId],
      );
      expect(defaults.rows).toEqual([{ fallback: 'off', seconds: '1209600' }]);
      const update = (set: string): Promise<unknown> =>
        admin.query(`update ujira.projects set ${set} where id = $1`, [tenant.projectId]);
      await update(`chain_fallback = 'verified_methods'`);
      await update('funding_hold_max_seconds = 3600');
      await update('funding_hold_max_seconds = 2592000');
      expect(await codeOf(update(`chain_fallback = 'always'`))).toBe('23514');
      expect(await codeOf(update('funding_hold_max_seconds = 3599'))).toBe('23514');
      expect(await codeOf(update('funding_hold_max_seconds = 2592001'))).toBe('23514');
    } finally {
      await admin.end();
    }
  });
});
