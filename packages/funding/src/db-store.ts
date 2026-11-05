// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The funding account ports over the database's repositories. Its own entry point,
// so a service that only takes the chain side, or a test, does not load a driver.

import { chainOf } from '@ujira/chain-adapter';
import type { FundingAccountRecord, FundingAccountStore, NetworkId } from '@ujira/chain-adapter';
import { fundingAccounts, mandateInstances } from '@ujira/db';
import type { Database, FundingAccount } from '@ujira/db';

import { FundingAccountConflictError } from './errors.js';
import type { FundingSourceStore } from './funding-account.js';

function toRecord(
  principalId: string,
  network: NetworkId,
  row: FundingAccount,
): FundingAccountRecord {
  return {
    principalId,
    projectId: row.projectId,
    network,
    address: row.address,
    sponsor: row.sponsor,
    sponsorTxHash: row.sponsorTxHash.toString('hex'),
    status: row.status,
    faults: row.faults,
  };
}

export function createDbFundingAccountStores(db: Pick<Database, 'tenant' | 'principal'>): {
  readonly accounts: FundingAccountStore;
  readonly sources: FundingSourceStore;
} {
  return {
    accounts: {
      // Read across the principal's projects, since reserves are budgeted per
      // principal. Through the app's connection rather than the reader's, because
      // a reader that lags could miss the row a retried confirmation just wrote.
      async forPrincipal(scope, network) {
        const row = await db
          .principal(scope, 'app')
          .transaction(async (tx) => fundingAccounts.forNetwork(tx, network));
        return row === undefined ? null : toRecord(scope.principalId, network, row);
      },

      // A repeat of the same account is a retry and fine. Anything else means the
      // chain holds an account the table has no room for.
      async record(row) {
        const context = { principalId: row.principalId, projectId: row.projectId };
        const saved = await db.tenant(context).transaction(
          async (tx) =>
            (await fundingAccounts.record(tx, {
              network: row.network,
              address: row.address,
              sponsor: row.sponsor,
              sponsorTxHash: Buffer.from(row.sponsorTxHash, 'hex'),
              faults: row.faults,
            })) ?? (await fundingAccounts.forNetwork(tx, row.network)),
        );
        if (saved?.address !== row.address) throw new FundingAccountConflictError();
      },
    },

    sources: {
      async attach(scope, { network, mandateInstanceId }) {
        return db.tenant(scope).transaction(async (tx) => {
          const account = await fundingAccounts.forNetwork(tx, network);
          const instance = await mandateInstances.get(tx, mandateInstanceId);
          if (account === undefined || instance?.chain !== chainOf(network)) return null;
          const source = await fundingAccounts.attach(tx, {
            accountId: account.id,
            mandateInstanceId,
          });
          return source?.id ?? null;
        });
      },
    },
  };
}
