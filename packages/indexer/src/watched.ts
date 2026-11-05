// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Whose an address is, for the deposit scan: a mandate's own contract, or a forwarding
// account and the mandate it funds. The answer decides which tenant is credited and
// where a sweep sends the money, so anything less than one clear answer is no answer.
// The chain adapter still checks what comes back against the registry before it
// believes any of it.

import {
  chainOf,
  type ChainAddress,
  type DepositScanRequest,
  type NetworkId,
  type TenantScope,
  type WatchedMandate,
} from '@ujira/chain-adapter';
import { isTokenAsset } from '@ujira/core';
import { entryPoints, type Database } from '@ujira/db';

/**
 * Why money reached an address of ours with nowhere to go. It stays on the account,
 * and the principal still controls it, so someone has to be told.
 */
export type UnroutableReason =
  'account_rejected' | 'no_mandate' | 'several_mandates' | 'unknown_asset';

export interface UnroutableAddress {
  readonly network: NetworkId;
  readonly address: string;
  readonly reason: UnroutableReason;
}

export interface WatchedAddressOptions {
  readonly db: Pick<Database, 'unscoped'>;
  readonly network: NetworkId;
  readonly onUnroutable: (event: UnroutableAddress) => void;
}

export function dbWatchedAddresses(
  options: WatchedAddressOptions,
): DepositScanRequest['isWatched'] {
  const { db, network, onUnroutable } = options;

  const refuse = (address: string, reason: UnroutableReason): null => {
    onUnroutable({ network, address, reason });
    return null;
  };

  const mandateRef = (contract: string): WatchedMandate['mandate'] => ({
    network,
    address: { network, value: contract },
    specVersion: 1,
  });

  async function forwardingAccount(address: string): Promise<WatchedMandate | null> {
    const account = await db.unscoped(
      (tx) => entryPoints.resolveFundingAddress(tx, network, address),
      'worker',
    );
    if (account === undefined) return null;
    if (account.status !== 'active') return refuse(address, 'account_rejected');
    const [only, ...others] = account.instances;
    if (only === undefined) return refuse(address, 'no_mandate');
    // Which of several a deposit is for cannot be told from the transfer. Picking one
    // could sweep a principal's money into the wrong mandate. The key on the account
    // should make this impossible, and this decides where money goes, so it stays.
    if (others.length > 0) return refuse(address, 'several_mandates');
    if (!isTokenAsset(only.asset)) return refuse(address, 'unknown_asset');
    return {
      scope: { principalId: account.principalId, projectId: account.projectId } as TenantScope,
      mandate: mandateRef(only.contractAddress),
      asset: only.asset,
      forwarding: {
        fundingSourceId: only.fundingSourceId,
        mandateInstanceId: only.mandateInstanceId,
        forwarder: address,
        mandate: only.contractAddress,
      },
    };
  }

  return async (asked: ChainAddress) => {
    if (asked.network !== network) return null;
    const instance = await db.unscoped(
      (tx) => entryPoints.resolveMandateInstance(tx, chainOf(network), asked.value),
      'worker',
    );
    if (instance === undefined) return forwardingAccount(asked.value);
    if (!isTokenAsset(instance.asset)) return refuse(asked.value, 'unknown_asset');
    return {
      scope: { principalId: instance.principalId, projectId: instance.projectId } as TenantScope,
      mandate: mandateRef(asked.value),
      asset: instance.asset,
    };
  };
}
