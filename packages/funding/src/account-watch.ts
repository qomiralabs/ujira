// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Keeps a funding account honest after creation. The principal owns the account and
// may change it, and UJIRA does not try to stop that. It stops vouching for the
// address: a changed account is not offered and no sweep is asked for from it. The
// money in it stays the principal's, and stays visible as a sweep awaiting its
// signature, and counts as funding nothing until it has been swept.
//
// A deposit prompt reads the account at that moment, so the interval below bounds
// only how long the address can go on being shown after a change. It is a starting
// value: an exchange deposit takes minutes, so this catches a change before most
// deposits made after it.

import type {
  CallOptions,
  FundingAccountFlow,
  FundingAccountRecord,
  NetworkId,
  TenantScope,
} from '@ujira/chain-adapter';

import { FundingInputError } from './errors.js';
import type { SweepAccounts } from './sweep.js';

/** How often each funding account should be read again, at the most. */
export const FUNDING_ACCOUNT_WATCH_INTERVAL_SECONDS = 900;

export interface FundingAccountWatchOptions {
  /** The flow for a network, or null where funding accounts are not offered. */
  readonly flowFor: (network: NetworkId) => FundingAccountFlow | null;
}

export interface FundingAccountWatch {
  /**
   * One scheduled read of this project's account on this network, which records and
   * flags a change. Null when the project has none. Safe to repeat: only a change in
   * what is found writes anything or raises anything.
   */
  check(
    scope: TenantScope,
    network: NetworkId,
    opts: CallOptions,
  ): Promise<FundingAccountRecord | null>;
  /** What the sweep asks before it prompts for a signature. */
  readonly accounts: SweepAccounts;
}

export function createFundingAccountWatch(
  options: FundingAccountWatchOptions,
): FundingAccountWatch {
  const check: FundingAccountWatch['check'] = async (scope, network, opts) => {
    const flow = options.flowFor(network);
    if (flow === null) throw new FundingInputError(['request.network (not_offered)']);
    return flow.recheck(scope, opts);
  };

  return {
    check,
    accounts: {
      async usable(request, signal) {
        // The sweep has already checked these are the ids of a tenant.
        const scope = request.scope as TenantScope;
        const account = await check(scope, request.network, {
          signal,
          correlationId: 'funding-account-watch',
        });
        return account?.status === 'active' && account.address === request.forwarder;
      },
    },
  };
}
