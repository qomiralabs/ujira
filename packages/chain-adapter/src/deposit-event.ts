// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the sweep is told about a deposit on a forwarding account. The sweep takes
// the tenant, the funding source and the route from its caller and cannot check
// them, so they come from here, built only from a deposit the adapter has already
// attributed from the ledger. A worker holding a Deposit has nothing to fill in.

import type { TokenAmount } from '@ujira/core';

import type { NetworkId } from './networks.js';
import type { Deposit, TenantScope } from './types.js';

export interface SweepDepositEvent {
  readonly scope: TenantScope;
  readonly network: NetworkId;
  readonly depositOperationId: string;
  readonly fundingSourceId: string;
  readonly mandateInstanceId: string;
  readonly route: {
    readonly forwarder: string;
    readonly mandate: string;
    /** The asset contract the ledger recorded the transfer from. */
    readonly token: string;
  };
  readonly amount: TokenAmount;
}

/** The sweep for a deposit, or null when it is not one to sweep. */
export function sweepDepositOf(network: NetworkId, deposit: Deposit): SweepDepositEvent | null {
  const { forwarding, operationId, eventIndex } = deposit;
  if (
    forwarding === undefined ||
    operationId === undefined ||
    deposit.asset === 'other' ||
    deposit.mandate.network !== network
  ) {
    return null;
  }
  return {
    scope: deposit.scope,
    network,
    // With the event's index, because one operation can pay a forwarding account
    // twice, and each transfer is swept on its own.
    depositOperationId: `${operationId}-${String(eventIndex)}`,
    fundingSourceId: forwarding.fundingSourceId,
    mandateInstanceId: forwarding.mandateInstanceId,
    route: {
      forwarder: forwarding.forwarder,
      mandate: forwarding.mandate,
      token: deposit.tokenContract,
    },
    amount: deposit.amount as TokenAmount,
  };
}
