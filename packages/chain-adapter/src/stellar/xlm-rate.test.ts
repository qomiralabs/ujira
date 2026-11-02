// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The Horizon response and the oracle simulation are real, recorded from
// mainnet with public read-only calls on 2026-11-02.

import { describe, expect, it } from 'vitest';

import type { NetworksConfig } from '../config.js';
import { RateUnavailableError } from '../errors.js';
import type { NetworkId } from '../networks.js';
import type { UnixSeconds } from '../types.js';

import horizonRecorded from './fixtures/pubnet-horizon-strict-receive.json' with { type: 'json' };
import oracleRecorded from './fixtures/pubnet-reflector-lastprice.json' with { type: 'json' };
import type { RawSimulation, StellarRpc } from './rpc.js';
import { horizonDexSource, reflectorOracleSource } from './xlm-rate-sources.js';
import { createXlmRateReader, deviationBps } from './xlm-rate.js';
import type { XlmRateAlerts, XlmRateObservation, XlmRateSource } from './xlm-rate.js';

const NOW = 1_793_597_200n;
const OPTS = { correlationId: 'xlm-rate-test' };
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const clock = { nowSeconds: () => NOW as UnixSeconds };

function configOf(
  xlmRate: { maxAgeSeconds?: number; maxDeviationBps?: number; testnetReferenceRate?: string } = {},
): NetworksConfig {
  const fees = {
    uncoveredNetworkCost: { monthlyBudgetStroops: 0n },
    networkFee: { marginBps: 1_200 },
    xlmRate: { maxAgeSeconds: 60, maxDeviationBps: 200, ...xlmRate },
  };
  return {
    'stellar:pubnet': { fees },
    'stellar:testnet': { fees },
  } as unknown as NetworksConfig;
}

function observed(
  source: XlmRateObservation['source'],
  numerator: bigint,
  denominator: bigint,
  ageSeconds = 0n,
): XlmRateSource {
  return () =>
    Promise.resolve({
      source,
      numerator,
      denominator,
      observedAt: (NOW - ageSeconds) as UnixSeconds,
    });
}

function reader(
  sources: { dex: XlmRateSource; oracle?: XlmRateSource },
  config: NetworksConfig = configOf(),
) {
  const sent: { kind: string; e: unknown }[] = [];
  const alerts: XlmRateAlerts = {
    xlmRateDisagreement: (e) => sent.push({ kind: 'disagreement', e }),
    xlmRateSourceFailed: (e) => sent.push({ kind: 'failed', e }),
  };
  const read = createXlmRateReader({
    config: () => config,
    clock,
    alerts,
    sources: { 'stellar:pubnet': sources },
  });
  return { read: (network: NetworkId = 'stellar:pubnet') => read(network, OPTS), sent };
}

const dexFetch =
  (body: unknown, status = 200): typeof globalThis.fetch =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

function dexSource(fetchImpl: typeof globalThis.fetch) {
  return horizonDexSource({
    network: 'stellar:pubnet',
    horizonUrl: 'https://horizon.example/',
    usdcIssuer: USDC_ISSUER,
    clock,
    fetch: fetchImpl,
  });
}

describe('the DEX source', () => {
  it('rate equals strict-receive source amount over destination amount', async () => {
    // 16.8790420 USDC for 100.0000000 XLM, as Horizon answered.
    await expect(dexSource(dexFetch(horizonRecorded))(OPTS)).resolves.toEqual({
      source: 'stellar_dex',
      numerator: 168_790_420n,
      denominator: 1_000_000_000n,
      observedAt: NOW,
    });
  });

  it('asks for USDC paths to the reference XLM amount', async () => {
    let url = '';
    await dexSource((input) => {
      url = input as string;
      return Promise.resolve(new Response(JSON.stringify(horizonRecorded)));
    })(OPTS);
    expect(url).toBe(
      `https://horizon.example/paths/strict-receive?source_assets=USDC%3A${USDC_ISSUER}&destination_asset_type=native&destination_amount=100`,
    );
  });

  it('takes the cheapest path, and only USDC from the configured issuer', async () => {
    const record = (code: string, issuer: string, source: string) => ({
      source_asset_code: code,
      source_asset_issuer: issuer,
      source_amount: source,
      destination_amount: '100.0000000',
    });
    const body = {
      _embedded: {
        records: [
          record('USDC', USDC_ISSUER, '18.0000000'),
          record('USDC', USDC_ISSUER, '16.0000000'),
          record('USDC', 'GOTHERISSUER', '1.0000000'),
          record('EURC', USDC_ISSUER, '2.0000000'),
          record('USDC', USDC_ISSUER, '0.0000000'),
        ],
      },
    };
    await expect(dexSource(dexFetch(body))(OPTS)).resolves.toMatchObject({
      numerator: 160_000_000n,
    });
  });

  it('refuses no path, a bad status, a malformed body and a failed call, and quotes none of them', async () => {
    const empty = { _embedded: { records: [] } };
    const secret = 'https://user:key@horizon.example/';
    for (const fetchImpl of [
      dexFetch(empty),
      dexFetch(horizonRecorded, 503),
      dexFetch({ _embedded: { records: [{ source_amount: 'not a number' }] } }),
      () => Promise.reject(new Error(`could not reach ${secret}`)),
    ] as (typeof globalThis.fetch)[]) {
      const error: unknown = await dexSource(fetchImpl)(OPTS).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateUnavailableError);
      expect(JSON.stringify(error)).not.toContain('key@');
      expect((error as Error).message).not.toContain('key@');
    }
  });
});

describe('the oracle source', () => {
  const rpcAnswering = (result: unknown): StellarRpc =>
    ({
      simulateTransaction: () => Promise.resolve(result as RawSimulation),
    }) as unknown as StellarRpc;
  const source = (rpc: StellarRpc) =>
    reflectorOracleSource({
      network: 'stellar:pubnet',
      rpc,
      feed: oracleRecorded.oracle,
      xlmContract: oracleRecorded.asset,
    });

  it('reads the recorded lastprice as price over 10^14, dated by the feed', async () => {
    await expect(source(rpcAnswering(oracleRecorded.result))(OPTS)).resolves.toEqual({
      source: 'reflector',
      numerator: 16_819_240_715_150n,
      denominator: 100_000_000_000_000n,
      observedAt: 1_793_597_100n,
    });
  });

  it('turns a failed simulation into no rate', async () => {
    const failing = {
      simulateTransaction: () => Promise.reject(new Error('connection refused')),
    } as unknown as StellarRpc;
    await expect(source(failing)(OPTS)).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe('xlmRate', () => {
  it('uses the DEX when both sources are fresh and agree', async () => {
    const { read, sent } = reader({
      dex: observed('stellar_dex', 17n, 100n),
      oracle: observed('reflector', 171n, 1_000n),
    });
    await expect(read()).resolves.toMatchObject({
      base: 'XLM',
      quote: 'USDC',
      numerator: 17n,
      denominator: 100n,
      source: 'stellar_dex',
      observedAt: NOW,
    });
    expect(sent).toEqual([]);
  });

  it('a source 61 seconds old is refused and the other is used', async () => {
    const staleOracle = reader({
      dex: observed('stellar_dex', 17n, 100n),
      oracle: observed('reflector', 99n, 100n, 61n),
    });
    await expect(staleOracle.read()).resolves.toMatchObject({ source: 'stellar_dex' });
    const staleDex = reader({
      dex: observed('stellar_dex', 99n, 100n, 61n),
      oracle: observed('reflector', 18n, 100n),
    });
    await expect(staleDex.read()).resolves.toMatchObject({ source: 'reflector', numerator: 18n });
    // Stale is routine for a feed that ticks every five minutes, so it is not alerted.
    expect([...staleOracle.sent, ...staleDex.sent]).toEqual([]);
  });

  it('accepts a source exactly at the bound, and refuses one dated far ahead', async () => {
    const { read } = reader({ dex: observed('stellar_dex', 17n, 100n, 60n) });
    await expect(read()).resolves.toMatchObject({ source: 'stellar_dex' });
    const ahead = reader({ dex: observed('stellar_dex', 17n, 100n, -61n) });
    await expect(ahead.read()).rejects.toBeInstanceOf(RateUnavailableError);
  });

  it('sources 201 bps apart give the higher USDC per XLM and one alert', async () => {
    const { read, sent } = reader({
      dex: observed('stellar_dex', 10_000n, 10_000n),
      oracle: observed('reflector', 10_201n, 10_000n),
    });
    await expect(read()).resolves.toMatchObject({ source: 'reflector', numerator: 10_201n });
    expect(sent).toEqual([
      {
        kind: 'disagreement',
        e: { network: 'stellar:pubnet', deviationBps: 201n, used: 'reflector' },
      },
    ]);
    const dexHigher = reader({
      dex: observed('stellar_dex', 10_201n, 10_000n),
      oracle: observed('reflector', 10_000n, 10_000n),
    });
    await expect(dexHigher.read()).resolves.toMatchObject({ source: 'stellar_dex' });
    expect(dexHigher.sent).toHaveLength(1);
  });

  it('sources exactly 200 bps apart still count as agreeing', async () => {
    const { read, sent } = reader({
      dex: observed('stellar_dex', 10_000n, 10_000n),
      oracle: observed('reflector', 10_200n, 10_000n),
    });
    await expect(read()).resolves.toMatchObject({ source: 'stellar_dex' });
    expect(sent).toEqual([]);
  });

  it('compares prices with different denominators exactly', () => {
    const a: XlmRateObservation = {
      source: 'stellar_dex',
      numerator: 1n,
      denominator: 3n,
      observedAt: NOW as UnixSeconds,
    };
    const b: XlmRateObservation = { ...a, numerator: 2n, denominator: 6n };
    expect(deviationBps(a, b)).toBe(0n);
    expect(deviationBps(a, { ...a, numerator: 0n })).toBe(10_000n);
  });

  it('returns RATE_UNAVAILABLE with no fresh source, and with no sources at all', async () => {
    const { read } = reader({
      dex: observed('stellar_dex', 17n, 100n, 120n),
      oracle: observed('reflector', 17n, 100n, 120n),
    });
    await expect(read()).rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' });
    const none = createXlmRateReader({
      config: configOf,
      clock,
      alerts: { xlmRateDisagreement: () => undefined, xlmRateSourceFailed: () => undefined },
      sources: {},
    });
    await expect(none('stellar:pubnet', OPTS)).rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' });
  });

  it('uses the other source when one fails, and says which failed', async () => {
    const { read, sent } = reader({
      dex: () => Promise.reject(new RateUnavailableError()),
      oracle: observed('reflector', 17n, 100n),
    });
    await expect(read()).resolves.toMatchObject({ source: 'reflector' });
    expect(sent).toEqual([
      {
        kind: 'failed',
        e: { network: 'stellar:pubnet', source: 'stellar_dex', code: 'RATE_UNAVAILABLE' },
      },
    ]);
    const unknown = reader({
      dex: observed('stellar_dex', 17n, 100n),
      oracle: () => Promise.reject(new Error('anything')),
    });
    await expect(unknown.read()).resolves.toMatchObject({ source: 'stellar_dex' });
    expect(unknown.sent[0]).toMatchObject({ e: { source: 'reflector', code: 'INTERNAL' } });
  });

  it('testnet returns the configured reference with source reference', async () => {
    const { read, sent } = reader(
      { dex: () => Promise.reject(new Error('never asked')) },
      configOf({ testnetReferenceRate: '0.125' }),
    );
    await expect(read('stellar:testnet')).resolves.toEqual({
      base: 'XLM',
      quote: 'USDC',
      numerator: 125n,
      denominator: 1_000n,
      source: 'reference',
      observedAt: NOW,
    });
    expect(sent).toEqual([]);
  });

  it('testnet with no usable reference has no rate', async () => {
    const unset = reader({ dex: observed('stellar_dex', 1n, 1n) });
    await expect(unset.read('stellar:testnet')).rejects.toMatchObject({
      code: 'RATE_UNAVAILABLE',
    });
    const zero = reader(
      { dex: observed('stellar_dex', 1n, 1n) },
      configOf({ testnetReferenceRate: '0' }),
    );
    await expect(zero.read('stellar:testnet')).rejects.toMatchObject({
      code: 'RATE_UNAVAILABLE',
    });
  });

  it('refuses a network outside the configuration', async () => {
    const read = createXlmRateReader({
      config: () => ({}),
      clock,
      alerts: { xlmRateDisagreement: () => undefined, xlmRateSourceFailed: () => undefined },
      sources: {},
    });
    await expect(read('stellar:pubnet', OPTS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
