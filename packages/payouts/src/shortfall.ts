// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Whether a payout's take covers the network cost UJIRA sponsors for it. On a
// very small payout it may not. UJIRA absorbs that shortfall within a monthly
// budget per network, and once the budget is spent the minimum for wallet and
// mobile money payouts rises to break-even until the month resets.
//
// None of this reaches a customer. Stroops and USDC on Stellar are both scale
// 7, so a stroop and a USDC minor unit convert by the rate alone.

import { isChainAdapterError } from '@ujira/chain-adapter';
import type { NetworkId, XlmRate, XlmRateReader } from '@ujira/chain-adapter';

import type { EstimateNetworkFee, FeeEstimateOp } from './fee-estimates.js';

const BPS = 10_000n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** A network cost in USDC minor units, rounded up once, so a cost is never understated. */
export function costInUsdcMinor(stroops: bigint, rate: Pick<XlmRate, 'numerator' | 'denominator'>) {
  return ceilDiv(stroops * rate.numerator, rate.denominator);
}

export type NetworkShortfall =
  | {
      readonly status: 'measured';
      /** True when the take covers the whole estimated cost. */
      readonly covered: boolean;
      readonly costStroops: bigint;
      readonly costUsdcMinor: bigint;
      readonly shortfallStroops: bigint;
      readonly shortfallUsdcMinor: bigint;
    }
  | {
      /** No fresh price, so nothing shows the take covers the cost. */
      readonly status: 'rate_unavailable';
      readonly covered: false;
      readonly costStroops: bigint;
    };

export interface ShortfallPayout {
  readonly network: NetworkId;
  readonly op: FeeEstimateOp;
  readonly legCount: number;
  /** The take on this payout, in USDC minor units. */
  readonly takeUsdcMinor: bigint;
  /** The request-time simulation, used when there is no estimate yet. */
  readonly simulation?: Parameters<EstimateNetworkFee>[3];
}

export interface ShortfallPorts {
  readonly estimateNetworkFee: EstimateNetworkFee;
  readonly xlmRate: XlmRateReader;
}

/**
 * The cost the take does not cover: max(0, cost - take), in both units. Rent is
 * part of the resource fee, so the cost is the resource fee and the inclusion
 * fee share, both with the margin the estimator applies.
 */
export async function networkShortfall(
  payout: ShortfallPayout,
  ports: ShortfallPorts,
  opts: Parameters<XlmRateReader>[1],
): Promise<NetworkShortfall> {
  const estimate = await ports.estimateNetworkFee(
    payout.network,
    payout.op,
    payout.legCount,
    payout.simulation,
  );
  const costStroops = estimate.resourceFeeStroops + estimate.inclusionFeeStroops;
  let rate: XlmRate;
  try {
    rate = await ports.xlmRate(payout.network, opts);
  } catch (error) {
    if (isChainAdapterError(error) && error.code === 'RATE_UNAVAILABLE') {
      return { status: 'rate_unavailable', covered: false, costStroops };
    }
    throw error;
  }
  const costUsdcMinor = costInUsdcMinor(costStroops, rate);
  const shortfallUsdcMinor =
    costUsdcMinor > payout.takeUsdcMinor ? costUsdcMinor - payout.takeUsdcMinor : 0n;
  // The take is rounded down into stroops, the side that cannot hide a
  // shortfall, and the two units then always agree on whether there is one.
  const takeStroops = (payout.takeUsdcMinor * rate.denominator) / rate.numerator;
  const shortfallStroops = costStroops > takeStroops ? costStroops - takeStroops : 0n;
  return {
    status: 'measured',
    covered: shortfallUsdcMinor === 0n,
    costStroops,
    costUsdcMinor,
    shortfallStroops,
    shortfallUsdcMinor,
  };
}

/** The smallest payout whose take covers the cost: ceil(cost x 10000 / take bps). */
export function breakEvenMinimum(estimatedCostUsdcMinor: bigint, takeBps: bigint): bigint {
  if (takeBps <= 0n) throw new RangeError('a take of zero never breaks even');
  return ceilDiv(estimatedCostUsdcMinor * BPS, takeBps);
}

/** The methods a spent budget raises the minimum for. */
export const BREAK_EVEN_METHODS: ReadonlySet<string> = new Set(['stellar_wallet', 'mobile_money']);

export interface ShortfallAccountingPorts {
  /** The monthly counter in the adapter, from createUncoveredBudget. */
  readonly budget: {
    record(network: NetworkId, stroops: bigint): Promise<bigint>;
    covers(network: NetworkId, stroops: bigint): Promise<boolean>;
  };
  /** The UTC month now, as the budget keys it. */
  readonly month: () => string;
  /** Marks the alert for a network and month. False when it was already sent. */
  readonly markBudgetAlert: (network: NetworkId, month: string) => Promise<boolean>;
  readonly alertBudgetSpent: (e: { readonly network: NetworkId; readonly month: string }) => void;
}

/** The accounting around a shortfall: the monthly budget and the minimum it controls. */
export function shortfallAccounting(ports: ShortfallAccountingPorts) {
  return {
    /** Counts a shortfall against the month's budget. Returns the month's total. */
    record: (network: NetworkId, shortfallStroops: bigint): Promise<bigint> =>
      ports.budget.record(network, shortfallStroops),

    /**
     * The minimum for a payout by this method. It is the method's floor while
     * the budget can absorb this payout's shortfall, and for every method the
     * budget does not govern. Once the budget is spent, wallet and mobile money
     * rise to break-even, and operations hear about it once per month.
     */
    minimum: async (input: {
      readonly network: NetworkId;
      readonly method: string;
      readonly floorUsdcMinor: bigint;
      readonly takeBps: bigint;
      readonly estimatedCostUsdcMinor: bigint;
      readonly shortfallStroops: bigint;
    }): Promise<bigint> => {
      if (!BREAK_EVEN_METHODS.has(input.method)) return input.floorUsdcMinor;
      if (await ports.budget.covers(input.network, input.shortfallStroops)) {
        return input.floorUsdcMinor;
      }
      const month = ports.month();
      if (await ports.markBudgetAlert(input.network, month)) {
        ports.alertBudgetSpent({ network: input.network, month });
      }
      const breakEven = breakEvenMinimum(input.estimatedCostUsdcMinor, input.takeBps);
      return breakEven > input.floorUsdcMinor ? breakEven : input.floorUsdcMinor;
    },
  };
}
