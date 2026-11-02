// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which session each port uses and how rows map. The repositories are stood in
// for here, because the database test harness belongs to the database package;
// the SQL, the keys and the policies are tested there against a real server.

import { randomUUID } from 'node:crypto';

import type { FundingAccountRecord, TenantScope } from '@ujira/chain-adapter';
import type { Database, FundingAccount } from '@ujira/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbFundingAccountStores } from './db-store.js';
import { FundingAccountConflictError } from './errors.js';

const repo = vi.hoisted(() => ({
  forNetwork: vi.fn(),
  record: vi.fn(),
  attach: vi.fn(),
  getInstance: vi.fn(),
}));

vi.mock('@ujira/db', () => ({
  fundingAccounts: {
    forNetwork: repo.forNetwork,
    record: repo.record,
    attach: repo.attach,
  },
  mandateInstances: { get: repo.getInstance },
}));

const NETWORK = 'stellar:testnet' as const;
const HASH = 'ab'.repeat(32);

const scope = { principalId: randomUUID(), projectId: randomUUID() } as TenantScope;

const row: FundingAccount = {
  id: randomUUID(),
  projectId: scope.projectId,
  network: NETWORK,
  address: 'GFORWARDER',
  sponsor: 'GSPONSOR',
  sponsorTxHash: Buffer.from(HASH, 'hex'),
  status: 'active',
  faults: [],
  createdAt: new Date(0),
};

const record: FundingAccountRecord = {
  principalId: scope.principalId,
  projectId: scope.projectId,
  network: NETWORK,
  address: 'GFORWARDER',
  sponsor: 'GSPONSOR',
  sponsorTxHash: HASH,
  status: 'active',
  faults: [],
};

interface Opened {
  readonly session: string;
  readonly context: unknown;
  readonly role?: string;
}

function database(): { readonly db: Pick<Database, 'tenant' | 'principal'>; opened: Opened[] } {
  const opened: Opened[] = [];
  const db = {
    tenant: (context: unknown) => ({
      transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        opened.push({ session: 'tenant', context });
        return work('tx');
      },
    }),
    principal: (context: unknown, role: string) => ({
      transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        opened.push({ session: 'principal', context, role });
        return work('tx');
      },
    }),
  } as unknown as Pick<Database, 'tenant' | 'principal'>;
  return { db, opened };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('db-store.test.ts', () => {
  describe('accounts.forPrincipal', () => {
    it('reads across the principal on the app connection, and maps the row', async () => {
      const { db, opened } = database();
      repo.forNetwork.mockResolvedValue(row);
      const found = await createDbFundingAccountStores(db).accounts.forPrincipal(scope, NETWORK);
      expect(found).toEqual(record);
      expect(opened).toEqual([{ session: 'principal', context: scope, role: 'app' }]);
      expect(repo.forNetwork).toHaveBeenCalledWith('tx', NETWORK);
    });

    it('answers null where there is no account', async () => {
      const { db } = database();
      repo.forNetwork.mockResolvedValue(undefined);
      expect(
        await createDbFundingAccountStores(db).accounts.forPrincipal(scope, NETWORK),
      ).toBeNull();
    });
  });

  describe('accounts.record', () => {
    it("writes under the row's own tenant, with the hash as bytes", async () => {
      const { db, opened } = database();
      repo.record.mockResolvedValue(row);
      await createDbFundingAccountStores(db).accounts.record(record);
      expect(opened).toEqual([
        {
          session: 'tenant',
          context: { principalId: scope.principalId, projectId: scope.projectId },
        },
      ]);
      expect(repo.record).toHaveBeenCalledWith('tx', {
        network: NETWORK,
        address: 'GFORWARDER',
        sponsor: 'GSPONSOR',
        sponsorTxHash: Buffer.from(HASH, 'hex'),
        faults: [],
      });
      expect(repo.forNetwork).not.toHaveBeenCalled();
    });

    it('takes a repeat of the same account as a retry', async () => {
      const { db } = database();
      repo.record.mockResolvedValue(undefined);
      repo.forNetwork.mockResolvedValue(row);
      await expect(
        createDbFundingAccountStores(db).accounts.record(record),
      ).resolves.toBeUndefined();
    });

    it('surfaces a different account already held by this project', async () => {
      const { db } = database();
      repo.record.mockResolvedValue(undefined);
      repo.forNetwork.mockResolvedValue({ ...row, address: 'GOTHER' });
      await expect(createDbFundingAccountStores(db).accounts.record(record)).rejects.toBeInstanceOf(
        FundingAccountConflictError,
      );
    });

    it('surfaces a conflict with a row this project cannot see', async () => {
      const { db } = database();
      repo.record.mockResolvedValue(undefined);
      repo.forNetwork.mockResolvedValue(undefined);
      await expect(createDbFundingAccountStores(db).accounts.record(record)).rejects.toBeInstanceOf(
        FundingAccountConflictError,
      );
    });
  });

  describe('sources.attach', () => {
    const instance = randomUUID();
    const input = { network: NETWORK, mandateInstanceId: instance };

    it('attaches the project account to the instance, under the tenant', async () => {
      const { db, opened } = database();
      repo.forNetwork.mockResolvedValue(row);
      repo.getInstance.mockResolvedValue({ id: instance, chain: 'stellar' });
      repo.attach.mockResolvedValue({ id: 'source-1' });
      expect(await createDbFundingAccountStores(db).sources.attach(scope, input)).toBe('source-1');
      expect(opened).toEqual([{ session: 'tenant', context: scope }]);
      expect(repo.attach).toHaveBeenCalledWith('tx', {
        accountId: row.id,
        mandateInstanceId: instance,
      });
    });

    it('answers null with no account in this project', async () => {
      const { db } = database();
      repo.forNetwork.mockResolvedValue(undefined);
      repo.getInstance.mockResolvedValue({ id: instance, chain: 'stellar' });
      expect(await createDbFundingAccountStores(db).sources.attach(scope, input)).toBeNull();
      expect(repo.attach).not.toHaveBeenCalled();
    });

    it('answers null for an instance this tenant cannot see', async () => {
      const { db } = database();
      repo.forNetwork.mockResolvedValue(row);
      repo.getInstance.mockResolvedValue(undefined);
      expect(await createDbFundingAccountStores(db).sources.attach(scope, input)).toBeNull();
      expect(repo.attach).not.toHaveBeenCalled();
    });

    it('answers null for an instance on another chain', async () => {
      const { db } = database();
      repo.forNetwork.mockResolvedValue(row);
      repo.getInstance.mockResolvedValue({ id: instance, chain: 'elsewhere' });
      expect(await createDbFundingAccountStores(db).sources.attach(scope, input)).toBeNull();
      expect(repo.attach).not.toHaveBeenCalled();
    });

    it('answers null when the repository refuses', async () => {
      const { db } = database();
      repo.forNetwork.mockResolvedValue(row);
      repo.getInstance.mockResolvedValue({ id: instance, chain: 'stellar' });
      repo.attach.mockResolvedValue(undefined);
      expect(await createDbFundingAccountStores(db).sources.attach(scope, input)).toBeNull();
    });
  });
});
