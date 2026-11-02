// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The price of XLM in USDC, used only inside UJIRA to measure whether a take
// covers the network cost UJIRA sponsors. It is never shown on a customer line.
//
// The DEX is the first source, and the oracle the cross-check and the fallback
// when the DEX is down. Each source has its own freshness bound, since the DEX
// answers live and the oracle only publishes every few minutes, and a source
// past its bound is refused. When two fresh sources disagree by more than the
// allowed deviation, the higher USDC per XLM wins, since that prices the cost
// highest and so can only overstate a shortfall, and operations are told. With
// no fresh source there is no rate: the caller treats the payout as not covered
// rather than guess.
//
// A rate can therefore be minutes old. That is acceptable because it only ever
// feeds a shortfall estimate and the minimum derived from it, never an amount
// paid to anyone.
//
// A rate here is exact integers. It is not a core Rate: core's rates price
// fiat and settlement tokens, and XLM is neither.

import { InvalidInputError, RateUnavailableError, isChainAdapterError } from '../errors.js';
import type { NetworksConfig } from '../config.js';
import type { NetworkId } from '../networks.js';
import type { CallOptions, UnixSeconds } from '../types.js';

export type XlmRateSourceName = 'stellar_dex' | 'reflector';

/** A price as one source reported it: numerator / denominator USDC per XLM, in major units. */
export interface XlmRateObservation {
  readonly source: XlmRateSourceName;
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly observedAt: UnixSeconds;
}

export interface XlmRate {
  readonly base: 'XLM';
  readonly quote: 'USDC';
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly source: XlmRateSourceName | 'reference';
  readonly observedAt: UnixSeconds;
}

export type XlmRateSource = (opts: CallOptions) => Promise<XlmRateObservation>;

export interface XlmRateAlerts {
  /** Two fresh sources are further apart than the allowed deviation. */
  xlmRateDisagreement(e: {
    readonly network: NetworkId;
    readonly deviationBps: bigint;
    readonly used: XlmRateSourceName;
  }): void;
  /** A source failed or fell past its bound, with its error code or STALE. */
  xlmRateSourceFailed(e: {
    readonly network: NetworkId;
    readonly source: XlmRateSourceName;
    readonly code: string;
  }): void;
}

export interface XlmRateReaderOptions {
  readonly config: () => NetworksConfig;
  readonly clock: { nowSeconds(): UnixSeconds };
  readonly alerts: XlmRateAlerts;
  /** The sources of each network that has a market price. Testnet has none. */
  readonly sources: Partial<
    Readonly<Record<NetworkId, { readonly dex: XlmRateSource; readonly oracle?: XlmRateSource }>>
  >;
}

export type XlmRateReader = (network: NetworkId, opts: CallOptions) => Promise<XlmRate>;

const BPS = 10_000n;

function rateFromReference(text: string, observedAt: UnixSeconds): XlmRate {
  const [whole = '', fraction = ''] = text.split('.');
  const numerator = BigInt(`${whole}${fraction}`);
  // A configured rate of zero would price every network cost at nothing.
  if (numerator === 0n) throw new RateUnavailableError();
  return {
    base: 'XLM',
    quote: 'USDC',
    numerator,
    denominator: 10n ** BigInt(fraction.length),
    source: 'reference',
    observedAt,
  };
}

function asRate(o: XlmRateObservation): XlmRate {
  return {
    base: 'XLM',
    quote: 'USDC',
    numerator: o.numerator,
    denominator: o.denominator,
    source: o.source,
    observedAt: o.observedAt,
  };
}

/**
 * How far apart two prices are, in basis points of the lower, rounded up so a
 * difference just past the bound never reads as within it. The fractions are
 * cross multiplied, so nothing is rounded before the comparison.
 */
export function deviationBps(a: XlmRateObservation, b: XlmRateObservation): bigint {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  const [low, high] = left < right ? [left, right] : [right, left];
  if (low <= 0n) return BPS;
  return ((high - low) * BPS + low - 1n) / low;
}

function higher(a: XlmRateObservation, b: XlmRateObservation): XlmRateObservation {
  return a.numerator * b.denominator >= b.numerator * a.denominator ? a : b;
}

/** Builds xlmRate(network). */
export function createXlmRateReader(options: XlmRateReaderOptions): XlmRateReader {
  return async (network, opts) => {
    const config = options.config()[network];
    if (config === undefined)
      throw new InvalidInputError({ network, issues: ['network (invalid)'] });
    const { maxAgeSeconds, maxDeviationBps, testnetReferenceRate } = config.fees.xlmRate;
    const now = options.clock.nowSeconds();

    if (network === 'stellar:testnet') {
      if (testnetReferenceRate === undefined) throw new RateUnavailableError({ network });
      return rateFromReference(testnetReferenceRate, now);
    }

    const sources = options.sources[network];
    if (sources === undefined) throw new RateUnavailableError({ network });

    const read = async (
      name: XlmRateSourceName,
      source: XlmRateSource | undefined,
    ): Promise<XlmRateObservation | null> => {
      if (source === undefined) return null;
      try {
        const observed = await source(opts);
        const age = now - observed.observedAt;
        const bound = BigInt(maxAgeSeconds[name]);
        // A source dated ahead of the clock is no more trustworthy than a stale
        // one. Past its bound the oracle has missed a tick, and the fallback is
        // gone until it recovers, so that is reported rather than passed over.
        if (age > bound || age < -bound) {
          options.alerts.xlmRateSourceFailed({ network, source: name, code: 'STALE' });
          return null;
        }
        return observed;
      } catch (error) {
        options.alerts.xlmRateSourceFailed({
          network,
          source: name,
          code: isChainAdapterError(error) ? error.code : 'INTERNAL',
        });
        return null;
      }
    };
    const [dex, oracle] = await Promise.all([
      read('stellar_dex', sources.dex),
      read('reflector', sources.oracle),
    ]);

    if (dex === null) {
      if (oracle === null) throw new RateUnavailableError({ network });
      return asRate(oracle);
    }
    if (oracle === null) return asRate(dex);

    const apart = deviationBps(dex, oracle);
    if (apart <= BigInt(maxDeviationBps)) return asRate(dex);
    const used = higher(dex, oracle);
    options.alerts.xlmRateDisagreement({ network, deviationBps: apart, used: used.source });
    return asRate(used);
  };
}
