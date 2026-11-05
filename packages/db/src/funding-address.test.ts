// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How the indexer learns whose a forwarding account is, with no tenant to read under.
// It gets one exact address at a time and nothing else, so the isolation between
// tenants holds for everything it does not ask about by name.

import { randomBytes, randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import { fundingAccounts } from './repositories/funding-accounts.js';
import { fundingSources, mandateInstances, mandates } from './repositories/mandates.js';
import type { Schema } from './schema.generated.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const NETWORK = 'stellar:testnet';

let database: TestDatabase;
let db: Database;

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  return work.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code,
  );
}

async function newTenant(): Promise<ProjectContext> {
  const created = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: randomUUID(),
      projectName: 'first',
      ownerUserId: randomUUID(),
    }),
  );
  return { principalId: created.principalId, projectId: created.projectId };
}

const as = <T>(tenant: ProjectContext, work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.tenant(tenant).transaction(work);

async function newInstance(tenant: ProjectContext, chain = 'stellar') {
  return as(tenant, async (tx) => {
    const mandate = await mandates.create(tx, { name: `mandate ${randomUUID()}` });
    return mandateInstances.create(tx, {
      network: 'stellar:testnet',
      mandateId: mandate.id,
      chain,
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
  });
}

async function newAccount(tenant: ProjectContext, faults: readonly string[] = []) {
  const address = `G${randomUUID()}`;
  const account = await as(tenant, async (tx) =>
    fundingAccounts.record(tx, {
      network: NETWORK,
      address,
      sponsor: `G${randomUUID()}`,
      sponsorTxHash: randomBytes(32),
      faults,
    }),
  );
  if (account === undefined) throw new Error('no account');
  return account;
}

async function attach(tenant: ProjectContext, accountId: string, mandateInstanceId: string) {
  const source = await as(tenant, async (tx) =>
    fundingAccounts.attach(tx, { accountId, mandateInstanceId }),
  );
  if (source === undefined) throw new Error('not attached');
  return source;
}

const resolve = (address: string, network = NETWORK) =>
  db.unscoped(async (tx) => entryPoints.resolveFundingAddress(tx, network, address), 'indexer');

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('resolving a forwarding account', () => {
  it('finds the tenant and the one mandate an account funds', async () => {
    const tenant = await newTenant();
    const instance = await newInstance(tenant);
    const account = await newAccount(tenant);
    const source = await attach(tenant, account.id, instance.id);
    expect(await resolve(account.address)).toEqual({
      principalId: tenant.principalId,
      projectId: tenant.projectId,
      fundingAccountId: account.id,
      status: 'active',
      instances: [
        {
          fundingSourceId: source.id,
          mandateInstanceId: instance.id,
          contractAddress: instance.contractAddress,
          asset: 'USDC',
        },
      ],
    });
  });

  it('shows an account that funds nothing as having no instances', async () => {
    const tenant = await newTenant();
    const account = await newAccount(tenant);
    expect(await resolve(account.address)).toMatchObject({
      fundingAccountId: account.id,
      status: 'active',
      instances: [],
    });
  });

  it('shows every instance of an account that funds several', async () => {
    const tenant = await newTenant();
    const first = await newInstance(tenant);
    const second = await newInstance(tenant);
    const account = await newAccount(tenant);
    await attach(tenant, account.id, first.id);
    // Attaching refuses this today, and the function still has to tell the truth
    // about it, because the guard in the scan depends on it if the rule is lifted.
    const extra = await as(tenant, async (tx) =>
      fundingSources.create(tx, {
        mandateInstanceId: second.id,
        kind: 'stellar_funding_account',
        config: { sponsoredReserves: true, sponsorTxHash: randomBytes(32) },
      }),
    );
    const owner = new pg.Client({ connectionString: database.url });
    await owner.connect();
    try {
      await owner.query('drop index if exists ujira.funding_account_sources_one_per_account');
      await owner.query(
        `insert into ujira.funding_account_sources
           (principal_id, project_id, funding_account_id, funding_source_id, mandate_instance_id)
         values ($1, $2, $3, $4, $5)`,
        [tenant.principalId, tenant.projectId, account.id, extra.id, second.id],
      );
    } finally {
      await owner.end();
    }
    const found = await resolve(account.address);
    expect(found?.instances.map((instance) => instance.mandateInstanceId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it('says when an account was rejected', async () => {
    const tenant = await newTenant();
    const account = await newAccount(tenant, ['master_key_kept']);
    expect(await resolve(account.address)).toMatchObject({ status: 'rejected', instances: [] });
  });

  it('answers nothing for an address that is no account of ours', async () => {
    expect(await resolve(`G${randomUUID()}`)).toBeUndefined();
  });

  it('keeps one address apart on each network', async () => {
    const tenant = await newTenant();
    const account = await newAccount(tenant);
    expect(await resolve(account.address, 'stellar:pubnet')).toBeUndefined();
  });
});

describe('what the indexer can reach', () => {
  it('gets back only the account it named, never another tenant', async () => {
    const first = await newTenant();
    const second = await newTenant();
    const mine = await newAccount(first);
    const theirs = await newAccount(second);
    expect(await resolve(mine.address)).toMatchObject({ principalId: first.principalId });
    expect(await resolve(theirs.address)).toMatchObject({ principalId: second.principalId });
  });

  it('cannot list accounts by a pattern or an empty address', async () => {
    const tenant = await newTenant();
    await newAccount(tenant);
    expect(await resolve('G%')).toBeUndefined();
    expect(await resolve('%')).toBeUndefined();
    expect(await resolve('')).toBeUndefined();
  });

  it('cannot read the tables themselves', async () => {
    const read = (statement: ReturnType<typeof sql>) =>
      codeOf(db.unscoped(async (tx) => statement.execute(tx), 'indexer'));
    expect(await read(sql`select * from ujira.funding_accounts`)).toBe('42501');
    expect(await read(sql`select * from ujira.funding_account_sources`)).toBe('42501');
  });

  it('is refused to the app login, which has a tenant to read under', async () => {
    const tenant = await newTenant();
    const account = await newAccount(tenant);
    expect(
      await codeOf(
        db.unscoped(async (tx) => entryPoints.resolveFundingAddress(tx, NETWORK, account.address)),
      ),
    ).toBe('42501');
  });

  it('leaves the tenant boundary where it was for the app', async () => {
    const first = await newTenant();
    const second = await newTenant();
    const theirs = await newAccount(second);
    const seen = await as(first, async (tx) =>
      tx
        .selectFrom('ujira.funding_accounts')
        .select('id')
        .where('id', '=', theirs.id)
        .executeTakeFirst(),
    );
    expect(seen).toBeUndefined();
  });
});
