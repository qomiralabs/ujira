// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The two places a price of XLM comes from. Endpoint URLs can carry provider
// API keys, so no error built here holds the URL, a response body or a cause
// beyond its class name, and every response is parsed before it is read.

import { z } from 'zod';

import { RateUnavailableError, isChainAdapterError } from '../errors.js';
import type { NetworkId, StellarNetworkId } from '../networks.js';
import type { UnixSeconds } from '../types.js';

import type { StellarRpc } from './rpc.js';
import { address, asI128, asOption, asU64, field, fieldsOf, sym, vec } from './scval.js';
import { readTx, returned, simulate } from './tx.js';
import type { XlmRateObservation, XlmRateSource } from './xlm-rate.js';

const DEFAULT_TIMEOUT_MS = 5_000;
/** The amount of XLM priced: enough to walk the book past dust, small enough to fill. */
const REFERENCE_XLM = 100n;

// Seven decimal places, as Horizon always writes an amount.
const HorizonAmount = z.string().regex(/^[0-9]{1,12}\.[0-9]{7}$/);

const StrictReceivePaths = z.object({
  _embedded: z.object({
    records: z.array(
      z.object({
        source_asset_code: z.string().optional(),
        source_asset_issuer: z.string().optional(),
        source_amount: HorizonAmount,
        destination_amount: HorizonAmount,
      }),
    ),
  }),
});

function stroopsOf(amount: string): bigint {
  return BigInt(amount.replace('.', ''));
}

/**
 * The USDC a strict-receive path needs to buy the reference XLM, from Horizon.
 * The cheapest path is the price, since that is what buying would cost. The
 * read is live, so it is dated by the clock.
 */
export function horizonDexSource(options: {
  readonly network: NetworkId;
  readonly horizonUrl: string;
  readonly usdcIssuer: string;
  readonly clock: { nowSeconds(): UnixSeconds };
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): XlmRateSource {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const { network } = options;
  return async (opts) => {
    const query = new URLSearchParams({
      source_assets: `USDC:${options.usdcIssuer}`,
      destination_asset_type: 'native',
      destination_amount: REFERENCE_XLM.toString(),
    });
    const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
    if (opts.signal !== undefined) signals.push(opts.signal);
    let body: unknown;
    try {
      const response = await fetchImpl(
        `${options.horizonUrl.replace(/\/+$/, '')}/paths/strict-receive?${query.toString()}`,
        { signal: AbortSignal.any(signals) },
      );
      if (!response.ok) throw new RateUnavailableError({ network });
      body = await response.json();
    } catch (error) {
      throw isChainAdapterError(error)
        ? error
        : new RateUnavailableError({ network, cause: error });
    }
    const parsed = StrictReceivePaths.safeParse(body);
    if (!parsed.success) throw new RateUnavailableError({ network });

    let cheapest: { source: bigint; destination: bigint } | null = null;
    for (const record of parsed.data._embedded.records) {
      if (record.source_asset_code !== 'USDC') continue;
      if (record.source_asset_issuer !== options.usdcIssuer) continue;
      const source = stroopsOf(record.source_amount);
      const destination = stroopsOf(record.destination_amount);
      if (source === 0n || destination === 0n) continue;
      // Compared as fractions, since the destination need not be exactly the ask.
      if (cheapest === null || source * cheapest.destination < cheapest.source * destination) {
        cheapest = { source, destination };
      }
    }
    if (cheapest === null) throw new RateUnavailableError({ network });
    return {
      source: 'stellar_dex',
      numerator: cheapest.source,
      denominator: cheapest.destination,
      observedAt: options.clock.nowSeconds(),
    };
  };
}

/**
 * lastprice(XLM) from a Reflector feed whose base asset is USDC, through
 * simulation, so no transaction is sent and no fee is paid. Its price carries
 * the feed's fixed decimals and is dated by the feed itself.
 */
export function reflectorOracleSource(options: {
  readonly network: StellarNetworkId;
  readonly rpc: StellarRpc;
  /** The feed contract. Its base asset must be USDC. */
  readonly feed: string;
  /** The XLM asset contract, which names the asset to the feed. */
  readonly xlmContract: string;
  /** Reflector feeds fix this at deployment; the live one is 14. */
  readonly decimals?: number;
}): XlmRateSource {
  const { network, rpc, feed } = options;
  const denominator = 10n ** BigInt(options.decimals ?? 14);
  return async (opts): Promise<XlmRateObservation> => {
    const asset = vec([sym('Stellar'), address('asset', options.xlmContract)]);
    let price: bigint;
    let timestamp: bigint;
    try {
      const sim = await simulate(
        rpc,
        network,
        readTx(network, { contract: feed, fn: 'lastprice', args: [asset] }),
        feed,
        opts,
      );
      const value = asOption(returned(sim));
      if (value === null) throw new RateUnavailableError({ network });
      const fields = fieldsOf(value);
      price = asI128(field(fields, 'price'));
      timestamp = asU64(field(fields, 'timestamp'));
    } catch (error) {
      throw isChainAdapterError(error) && error.code === 'RATE_UNAVAILABLE'
        ? error
        : new RateUnavailableError({ network, cause: error });
    }
    if (price <= 0n) throw new RateUnavailableError({ network });
    return {
      source: 'reflector',
      numerator: price,
      denominator,
      observedAt: timestamp as UnixSeconds,
    };
  };
}
