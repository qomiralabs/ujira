// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One forwarding account per principal and network, no address held twice, and
// one funding source per mandate instance however often a confirmation is retried.
// Those keys are what the sponsorship and the sweeps rely on.

import { randomBytes, randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import { fundingAccounts, type NewFundingAccount } from './repositories/funding-accounts.js';
import { fundingSources, mandateInstances, mandates } from './repositories/mandates.js';
import { projects } from './repositories/tenancy.js';
import type { Schema } from './schema.generated.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const NETWORK = 'stellar:testnet';

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function newAccount(change: Partial<NewFundingAccount> = {}): NewFundingAccount {
  return {
    network: NETWORK,
    address: `G${randomUUID()}`,
    sponsor: `G${randomUUID()}`,
    sponsorTxHash: randomBytes(32),
    faults: [],
    ...change,
  };
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

async function as<T>(tenant: ProjectContext, work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> {
  return db.tenant(tenant).transaction(work);
}

async function newInstance(tenant: ProjectContext, network = NETWORK): Promise<string> {
  return as(tenant, async (tx) => {
    const mandate = await mandates.create(tx, { name: `mandate ${randomUUID()}` });
    const instance = await mandateInstances.create(tx, {
      network,
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

async function secondProject(tenant: ProjectContext): Promise<ProjectContext> {
  const projectId = await db
    .tenant(tenant)
    .transaction(async (tx) => projects.create(tx, { name: 'second' }));
  return { principalId: tenant.principalId, projectId };
}

// A row with no network, as one from before the column has, or one made by the code
// still running during a deploy.
async function instanceFromBeforeNetworks(tenant: ProjectContext): Promise<string> {
  const mandate = await as(tenant, async (tx) =>
    mandates.create(tx, { name: `mandate ${randomUUID()}` }),
  );
  const row = await admin.query<{ id: string }>(
    `insert into ujira.mandate_instances
       (principal_id, project_id, mandate_id, chain, contract_address, spec_version, asset, scale)
     values ($1, $2, $3, 'stellar', $4, '1', 'USDC', 7)
     returning id`,
    [tenant.principalId, tenant.projectId, mandate.id, `C${randomUUID()}`],
  );
  return row.rows[0]?.id ?? '';
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('funding accounts', () => {
  it('records a good account as active and reads it back with its tenant', async () => {
    const tenant = await newTenant();
    const input = newAccount();
    const saved = await as(tenant, async (tx) => fundingAccounts.record(tx, input));
    expect(saved).toMatchObject({
      projectId: tenant.projectId,
      network: NETWORK,
      address: input.address,
      sponsor: input.sponsor,
      status: 'active',
      faults: [],
    });
    expect(saved?.sponsorTxHash.equals(input.sponsorTxHash)).toBe(true);
    const row = await admin.query<{ principal_id: string }>(
      'select principal_id from ujira.funding_accounts where id = $1',
      [saved?.id],
    );
    expect(row.rows[0]?.principal_id).toBe(tenant.principalId);
    const read = await as(tenant, async (tx) => fundingAccounts.forNetwork(tx, NETWORK));
    expect(read?.id).toBe(saved?.id);
  });

  it('records an account with faults as rejected, keeping them', async () => {
    const tenant = await newTenant();
    const saved = await as(tenant, async (tx) =>
      fundingAccounts.record(tx, newAccount({ faults: ['extra_signer', 'thresholds'] })),
    );
    expect(saved?.status).toBe('rejected');
    expect(saved?.faults).toEqual(['extra_signer', 'thresholds']);
  });

  it('finds nothing on a network with no account', async () => {
    const tenant = await newTenant();
    await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    expect(
      await as(tenant, async (tx) => fundingAccounts.forNetwork(tx, 'stellar:pubnet')),
    ).toBeUndefined();
  });

  it('keeps the first account for a principal and network', async () => {
    const tenant = await newTenant();
    const first = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    const again = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    expect(again).toBeUndefined();
    const read = await as(tenant, async (tx) => fundingAccounts.forNetwork(tx, NETWORK));
    expect(read?.id).toBe(first?.id);
    const other = await as(tenant, async (tx) =>
      fundingAccounts.record(tx, newAccount({ network: 'stellar:pubnet' })),
    );
    expect(other?.network).toBe('stellar:pubnet');
  });

  it('holds a principal to one across its projects, and shows it to the principal only', async () => {
    const tenant = await newTenant();
    const second = await secondProject(tenant);
    const first = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    expect(
      await as(second, async (tx) => fundingAccounts.record(tx, newAccount())),
    ).toBeUndefined();
    expect(await as(second, async (tx) => fundingAccounts.forNetwork(tx, NETWORK))).toBeUndefined();
    const across = await db
      .principal(second, 'app')
      .transaction(async (tx) => fundingAccounts.forNetwork(tx, NETWORK));
    expect(across?.id).toBe(first?.id);
    expect(across?.projectId).toBe(tenant.projectId);
  });

  it('never lets two tenants hold one address, without showing whose it is', async () => {
    const tenant = await newTenant();
    const other = await newTenant();
    const address = `G${randomUUID()}`;
    await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount({ address })));
    expect(
      await as(other, async (tx) => fundingAccounts.record(tx, newAccount({ address }))),
    ).toBeUndefined();
    expect(await as(other, async (tx) => fundingAccounts.forNetwork(tx, NETWORK))).toBeUndefined();
  });

  it('refuses a row whose status disagrees with its faults, whoever writes it', async () => {
    const tenant = await newTenant();
    const insert = async (status: string, faults: string[]): Promise<void> => {
      await admin.query(
        `insert into ujira.funding_accounts
           (principal_id, project_id, network, address, sponsor, sponsor_tx_hash, status, faults)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenant.principalId,
          tenant.projectId,
          NETWORK,
          `G${randomUUID()}`,
          `G${randomUUID()}`,
          randomBytes(32),
          status,
          faults,
        ],
      );
    };
    expect(await codeOf(insert('active', ['extra_signer']))).toBe('23514');
    expect(await codeOf(insert('rejected', []))).toBe('23514');
    expect(await codeOf(insert('pending', []))).toBe('23514');
  });

  it('gives the app no way to change or remove what was found', async () => {
    const tenant = await newTenant();
    const saved = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    const id = saved?.id ?? '';
    const change = as(tenant, async (tx) =>
      tx
        .updateTable('ujira.funding_accounts')
        .set({ address: 'elsewhere' })
        .where('id', '=', id)
        .execute(),
    );
    expect(await codeOf(change)).toBe('42501');
    const remove = as(tenant, async (tx) =>
      tx.deleteFrom('ujira.funding_accounts').where('id', '=', id).execute(),
    );
    expect(await codeOf(remove)).toBe('42501');
  });
});

describe('reading a funding account again', () => {
  async function recorded(tenant: ProjectContext, faults: readonly string[] = []) {
    const saved = await as(tenant, async (tx) =>
      fundingAccounts.record(tx, newAccount({ faults })),
    );
    return saved?.id ?? '';
  }
  const current = async (tenant: ProjectContext) =>
    as(tenant, async (tx) => fundingAccounts.forNetwork(tx, NETWORK));

  it('reads as changed once a later read finds something else', async () => {
    const tenant = await newTenant();
    const accountId = await recorded(tenant);
    expect((await current(tenant))?.status).toBe('active');
    await as(tenant, async (tx) =>
      fundingAccounts.recordCheck(tx, { accountId, faults: ['extra_signer'] }),
    );
    expect(await current(tenant)).toMatchObject({ status: 'changed', faults: ['extra_signer'] });
  });

  it('keeps what was found at creation, and every later finding', async () => {
    const tenant = await newTenant();
    const accountId = await recorded(tenant);
    await as(tenant, async (tx) =>
      fundingAccounts.recordCheck(tx, { accountId, faults: ['extra_signer'] }),
    );
    await as(tenant, async (tx) => fundingAccounts.recordCheck(tx, { accountId, faults: [] }));
    const row = await admin.query<{ status: string; faults: string[] }>(
      'select status, faults from ujira.funding_accounts where id = $1',
      [accountId],
    );
    expect(row.rows[0]).toEqual({ status: 'active', faults: [] });
    const checks = await admin.query<{ faults: string[] }>(
      'select faults from ujira.funding_account_checks where funding_account_id = $1 order by checked_at',
      [accountId],
    );
    expect(checks.rows.map((check) => check.faults)).toEqual([['extra_signer'], []]);
  });

  it('goes back to active when the latest read finds the shape it verified', async () => {
    const tenant = await newTenant();
    const accountId = await recorded(tenant);
    await as(tenant, async (tx) =>
      fundingAccounts.recordCheck(tx, { accountId, faults: ['extra_signer'] }),
    );
    await as(tenant, async (tx) => fundingAccounts.recordCheck(tx, { accountId, faults: [] }));
    expect(await current(tenant)).toMatchObject({ status: 'active', faults: [] });
  });

  it('reads the latest of findings written in one transaction', async () => {
    const tenant = await newTenant();
    const accountId = await recorded(tenant);
    await as(tenant, async (tx) => {
      await fundingAccounts.recordCheck(tx, { accountId, faults: [] });
      await fundingAccounts.recordCheck(tx, { accountId, faults: ['thresholds'] });
    });
    expect((await current(tenant))?.faults).toEqual(['thresholds']);
  });

  it('does not read an account rejected at creation back into use', async () => {
    const tenant = await newTenant();
    const accountId = await recorded(tenant, ['extra_signer']);
    await as(tenant, async (tx) => fundingAccounts.recordCheck(tx, { accountId, faults: [] }));
    expect(await current(tenant)).toMatchObject({ status: 'rejected', faults: ['extra_signer'] });
  });

  it('makes no new funding source from a changed account', async () => {
    const tenant = await newTenant();
    const accountId = await recorded(tenant);
    await as(tenant, async (tx) =>
      fundingAccounts.recordCheck(tx, { accountId, faults: ['extra_signer'] }),
    );
    const instance = await newInstance(tenant);
    expect(
      await as(tenant, async (tx) =>
        fundingAccounts.attach(tx, { accountId, mandateInstanceId: instance }),
      ),
    ).toBeUndefined();
    await as(tenant, async (tx) => fundingAccounts.recordCheck(tx, { accountId, faults: [] }));
    const source = await as(tenant, async (tx) =>
      fundingAccounts.attach(tx, { accountId, mandateInstanceId: instance }),
    );
    expect(source?.mandateInstanceId).toBe(instance);
  });

  it('gives the app no way to change or remove a finding', async () => {
    const tenant = await newTenant();
    const accountId = await recorded(tenant);
    await as(tenant, async (tx) => fundingAccounts.recordCheck(tx, { accountId, faults: [] }));
    const change = as(tenant, async (tx) =>
      tx
        .updateTable('ujira.funding_account_checks')
        .set({ faults: ['forged'] })
        .where('funding_account_id', '=', accountId)
        .execute(),
    );
    expect(await codeOf(change)).toBe('42501');
    const remove = as(tenant, async (tx) =>
      tx
        .deleteFrom('ujira.funding_account_checks')
        .where('funding_account_id', '=', accountId)
        .execute(),
    );
    expect(await codeOf(remove)).toBe('42501');
  });
});

describe('attaching an account to a mandate instance', () => {
  it('makes a stellar_funding_account source carrying the sponsoring transaction', async () => {
    const tenant = await newTenant();
    const input = newAccount();
    const account = await as(tenant, async (tx) => fundingAccounts.record(tx, input));
    const instance = await newInstance(tenant);
    const source = await as(tenant, async (tx) =>
      fundingAccounts.attach(tx, { accountId: account?.id ?? '', mandateInstanceId: instance }),
    );
    expect(source).toMatchObject({ mandateInstanceId: instance, kind: 'stellar_funding_account' });
    expect(source?.config?.sponsoredReserves).toBe(true);
    expect(source?.config?.sponsorTxHash.equals(input.sponsorTxHash)).toBe(true);
  });

  it('answers a retry with the same source', async () => {
    const tenant = await newTenant();
    const account = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    const instance = await newInstance(tenant);
    const attach = async () =>
      as(tenant, async (tx) =>
        fundingAccounts.attach(tx, { accountId: account?.id ?? '', mandateInstanceId: instance }),
      );
    const first = await attach();
    const second = await attach();
    expect(second?.id).toBe(first?.id);
    const count = await admin.query<{ count: string }>(
      'select count(*)::text as count from ujira.funding_sources where mandate_instance_id = $1',
      [instance],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('leaves one source when two confirmations race', async () => {
    const tenant = await newTenant();
    const account = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    const instance = await newInstance(tenant);
    const attach = async () =>
      as(tenant, async (tx) =>
        fundingAccounts.attach(tx, { accountId: account?.id ?? '', mandateInstanceId: instance }),
      );
    const results = await Promise.all([attach(), attach(), attach(), attach()]);
    expect(new Set(results.map((source) => source?.id)).size).toBe(1);
    const count = await admin.query<{ count: string }>(
      'select count(*)::text as count from ujira.funding_sources where mandate_instance_id = $1',
      [instance],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('lets one account fund several instances', async () => {
    const tenant = await newTenant();
    const account = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    const [one, two] = await Promise.all([newInstance(tenant), newInstance(tenant)]);
    const sources = await as(tenant, async (tx) => [
      await fundingAccounts.attach(tx, { accountId: account?.id ?? '', mandateInstanceId: one }),
      await fundingAccounts.attach(tx, { accountId: account?.id ?? '', mandateInstanceId: two }),
    ]);
    expect(sources[0]?.id).not.toBe(sources[1]?.id);
    expect(sources.map((source) => source?.mandateInstanceId)).toEqual([one, two]);
  });

  it('does not attach a rejected account', async () => {
    const tenant = await newTenant();
    const account = await as(tenant, async (tx) =>
      fundingAccounts.record(tx, newAccount({ faults: ['extra_signer'] })),
    );
    const instance = await newInstance(tenant);
    expect(
      await as(tenant, async (tx) =>
        fundingAccounts.attach(tx, { accountId: account?.id ?? '', mandateInstanceId: instance }),
      ),
    ).toBeUndefined();
    const page = await as(tenant, async (tx) => fundingSources.list(tx, { limit: 10 }));
    expect(page.items).toEqual([]);
  });

  it('does not move an instance from one account to another', async () => {
    const tenant = await newTenant();
    const testnet = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    const pubnet = await as(tenant, async (tx) =>
      fundingAccounts.record(tx, newAccount({ network: 'stellar:pubnet' })),
    );
    const instance = await newInstance(tenant);
    await as(tenant, async (tx) =>
      fundingAccounts.attach(tx, { accountId: testnet?.id ?? '', mandateInstanceId: instance }),
    );
    expect(
      await as(tenant, async (tx) =>
        fundingAccounts.attach(tx, { accountId: pubnet?.id ?? '', mandateInstanceId: instance }),
      ),
    ).toBeUndefined();
  });

  it('refuses a testnet account on a pubnet instance, whoever writes it', async () => {
    const tenant = await newTenant();
    const account = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    const instance = await newInstance(tenant, 'stellar:pubnet');
    const accountId = account?.id ?? '';
    expect(
      await as(tenant, async (tx) =>
        fundingAccounts.attach(tx, { accountId, mandateInstanceId: instance }),
      ),
    ).toBeUndefined();
    // Nothing is left behind, since the app could not remove it.
    const none = await as(tenant, async (tx) => fundingSources.list(tx, { limit: 10 }));
    expect(none.items).toEqual([]);
    const source = await as(tenant, async (tx) =>
      fundingSources.create(tx, {
        mandateInstanceId: instance,
        kind: 'stellar_funding_account',
        config: { sponsoredReserves: true, sponsorTxHash: randomBytes(32) },
      }),
    );
    const direct = as(tenant, async (tx) =>
      tx
        .insertInto('ujira.funding_account_sources')
        .values({
          principal_id: tenant.principalId,
          project_id: tenant.projectId,
          funding_account_id: accountId,
          funding_source_id: source.id,
          mandate_instance_id: instance,
        })
        .execute(),
    );
    expect(await codeOf(direct)).toBe('23514');
  });

  it('refuses a pubnet account on a testnet instance', async () => {
    const tenant = await newTenant();
    const account = await as(tenant, async (tx) =>
      fundingAccounts.record(tx, newAccount({ network: 'stellar:pubnet' })),
    );
    const instance = await newInstance(tenant);
    expect(
      await as(tenant, async (tx) =>
        fundingAccounts.attach(tx, { accountId: account?.id ?? '', mandateInstanceId: instance }),
      ),
    ).toBeUndefined();
  });

  it('attaches on the same network, on pubnet as well', async () => {
    const tenant = await newTenant();
    const account = await as(tenant, async (tx) =>
      fundingAccounts.record(tx, newAccount({ network: 'stellar:pubnet' })),
    );
    const instance = await newInstance(tenant, 'stellar:pubnet');
    const source = await as(tenant, async (tx) =>
      fundingAccounts.attach(tx, { accountId: account?.id ?? '', mandateInstanceId: instance }),
    );
    expect(source?.mandateInstanceId).toBe(instance);
  });

  it('refuses a link to a source on another instance, whoever writes it', async () => {
    const tenant = await newTenant();
    const account = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    const [mine, other] = await Promise.all([newInstance(tenant), newInstance(tenant)]);
    const elsewhere = await as(tenant, async (tx) =>
      fundingSources.create(tx, {
        mandateInstanceId: other,
        kind: 'stellar_funding_account',
        config: { sponsoredReserves: true, sponsorTxHash: randomBytes(32) },
      }),
    );
    const direct = as(tenant, async (tx) =>
      tx
        .insertInto('ujira.funding_account_sources')
        .values({
          principal_id: tenant.principalId,
          project_id: tenant.projectId,
          funding_account_id: account?.id ?? '',
          funding_source_id: elsewhere.id,
          mandate_instance_id: mine,
        })
        .execute(),
    );
    expect(await codeOf(direct)).toBe('23514');
  });

  it('funds nothing from an instance whose network is not known', async () => {
    const tenant = await newTenant();
    const account = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    const instance = await instanceFromBeforeNetworks(tenant);
    const read = await as(tenant, async (tx) => mandateInstances.get(tx, instance));
    expect(read?.network).toBeNull();
    expect(
      await as(tenant, async (tx) =>
        fundingAccounts.attach(tx, { accountId: account?.id ?? '', mandateInstanceId: instance }),
      ),
    ).toBeUndefined();
    const none = await as(tenant, async (tx) => fundingSources.list(tx, { limit: 10 }));
    expect(none.items).toEqual([]);
  });

  it('is held to one source per instance by the table itself', async () => {
    const tenant = await newTenant();
    const account = await as(tenant, async (tx) => fundingAccounts.record(tx, newAccount()));
    const instance = await newInstance(tenant);
    const source = await as(tenant, async (tx) =>
      fundingAccounts.attach(tx, { accountId: account?.id ?? '', mandateInstanceId: instance }),
    );
    const other = await as(tenant, async (tx) =>
      fundingSources.create(tx, {
        mandateInstanceId: instance,
        kind: 'stellar_funding_account',
        config: { sponsoredReserves: true, sponsorTxHash: randomBytes(32) },
      }),
    );
    expect(source?.id).not.toBe(other.id);
    const second = as(tenant, async (tx) =>
      tx
        .insertInto('ujira.funding_account_sources')
        .values({
          principal_id: tenant.principalId,
          project_id: tenant.projectId,
          funding_account_id: account?.id ?? '',
          funding_source_id: other.id,
          mandate_instance_id: instance,
        })
        .execute(),
    );
    expect(await codeOf(second)).toBe('23505');
  });
});
