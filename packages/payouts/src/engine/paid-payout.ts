// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a receipt is built from, read from the database once a payout is paid. The chain
// confirms the rest when the receipt is issued, so nothing here is taken on trust from it.

import type { ChainAdapterRegistry, NetworkId, PayoutId, TenantScope } from '@ujira/chain-adapter';
import { moneyAt, type Money, type TokenAmount } from '@ujira/core';
import {
  liveLegs,
  mandates,
  payoutAttempts,
  payoutEngine,
  payoutLegs,
  payouts,
  recipients,
  type Database,
} from '@ujira/db';
import type { PaidPayout } from '@ujira/receipts';

const BPS = 10_000n;

// Enough of an address to recognise it by, and no more.
function masked(address: string): string {
  return address.length <= 8 ? address : `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// A receipt states what was asked in fiat at its minor unit, and a payout asked for in the
// token has none. Read at par as US dollars, as a wallet quote reads it, and only when that
// is whole cents: rounding would put a figure on a receipt that nobody asked for.
export class RequestedNotWholeCentsError extends Error {
  override readonly name = 'RequestedNotWholeCentsError';

  constructor() {
    super('the amount asked for is not a whole number of cents');
  }
}

const CENTS = 2;

function atPar(requested: TokenAmount): Money {
  const step = 10n ** BigInt(Math.max(requested.scale - CENTS, 0));
  if (requested.amount % step !== 0n) throw new RequestedNotWholeCentsError();
  return moneyAt(requested.amount / step, 'USD', CENTS);
}

export function databasePaidPayout(
  db: Database,
  adapters: ChainAdapterRegistry,
): (scope: TenantScope, payoutId: string) => Promise<PaidPayout | null> {
  return async (scope, payoutId) => {
    const found = await db.tenant(scope).transaction(async (tx) => {
      const payout = await payouts.get(tx, payoutId);
      if (payout?.status !== 'paid') return null;
      const attempt = (await payoutAttempts.forPayout(tx, payoutId)).find(
        (one) => one.status === 'final',
      );
      if (attempt?.onChainPayoutId == null) return null;
      return {
        payout,
        attempt,
        legs: liveLegs(await payoutLegs.forAttempt(tx, attempt.id)),
        mandate: await mandates.get(tx, payout.mandateId),
        instance: await payoutEngine.instance(tx, attempt.mandateInstanceId),
        recipient: await recipients.get(tx, payout.recipientId),
      };
    });
    if (found === null) return null;
    const { payout, attempt, legs, mandate, instance, recipient } = found;
    if (mandate === undefined || instance === undefined || recipient === undefined) return null;
    const network = instance.network as NetworkId;
    const adapter = adapters.get(network);
    const total = attempt.total;
    const requested: Money =
      payout.requested.kind === 'fiat' ? payout.requested : atPar(payout.requested);
    return {
      scope,
      id: payout.id,
      chainPayoutId: attempt.onChainPayoutId as PayoutId,
      taskId: null,
      mandate: {
        id: mandate.id,
        name: mandate.name,
        ref: { network, address: adapter.parseAddress(instance.contractAddress), specVersion: 1 },
      },
      recipientRef: recipient.recipientRef.toString('hex'),
      requested,
      total,
      fee: {
        amount: attempt.fee,
        bps: total.amount === 0n ? 0 : Number((attempt.fee.amount * BPS) / total.amount),
      },
      legs: legs.map((leg, index) => ({
        index,
        method: leg.method as PaidPayout['legs'][number]['method'],
        destination: { masked: masked(leg.destinationAddress), tag: leg.destinationTag },
        received: leg.delivery?.receive ?? null,
        railFee: leg.fee,
      })),
    };
  };
}
