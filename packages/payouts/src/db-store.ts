// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The payout method source over the database's payout methods: where the chain
// adapter reads each leg's destination. Its own entry point, so a service that only
// takes the chain side, or a test, does not load a driver.

import { chainOf, isChainAdapterError, readBindableDestination } from '@ujira/chain-adapter';
import type { Destination, NetworkId, PayoutMethodSource } from '@ujira/chain-adapter';
import { payoutMethods } from '@ujira/db';
import type { Database } from '@ujira/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads under the paying tenant's own session, so another project's method is never found. */
export function createDbPayoutMethodSource(
  db: Pick<Database, 'tenant'>,
  network: NetworkId,
): PayoutMethodSource {
  return {
    async destination(scope, methodId) {
      if (!UUID.test(methodId)) return null;
      const found = await db
        .tenant(scope)
        .transaction(async (tx) => payoutMethods.payable(tx, methodId, chainOf(network)));
      return found === undefined ? null : destinationOf(network, found);
    },
  };
}

// Onboarding stores an M address with the id inside it and the same id as the tag, or
// an account with its tag beside it. Either reads as the account and the tag. One that
// does not read, or whose id and tag disagree, is no destination anyone chose.
function destinationOf(
  network: NetworkId,
  found: { readonly destinationAddress: string; readonly destinationTag: bigint | null },
): Destination | null {
  const address = found.destinationAddress;
  const tag = found.destinationTag;
  const input =
    tag === null || address.startsWith('M')
      ? { address }
      : { address, memoType: 'id' as const, memo: tag.toString() };
  try {
    const read = readBindableDestination(network, input).destination;
    return read.tag === tag ? read : null;
  } catch (error) {
    if (isChainAdapterError(error)) return null;
    throw error;
  }
}
