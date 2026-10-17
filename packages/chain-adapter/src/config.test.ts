// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the networks section of the routing configuration
 * (config.ts).
 *
 * parseNetworksConfig(input: unknown) validates the section with a strict
 * zod schema and returns a frozen NetworksConfig keyed by network ID. Every
 * key is optional, so a deployment can carry only the testnets, but an
 * unknown network or field is refused. Stellar networks and EVM networks
 * have their own shape, picked by the key.
 *
 * - RPC endpoints are secret references (secretRef:name), never URLs, so a
 *   provider key can never sit in the document.
 * - Stellar addresses are checked strkeys (version byte and CRC16), EVM
 *   addresses are 0x plus 40 hex characters.
 * - Fee limits in stroops and wei are decimal strings parsed to bigint, so
 *   no amount ever passes through a JavaScript number.
 * - Cross field rules: downErrorBps >= degradedErrorBps, low balance alert
 *   >= minimum balance, per transaction fee <= per principal daily fee <=
 *   global daily fee, and a failover proof on Celo only at finalized.
 *
 * A bad document throws InvalidInputError whose message names the paths
 * and issue codes only. Values never appear, because a misplaced secret is
 * exactly the kind of mistake this check exists to catch.
 * Signing key references for executors, the fee sponsor and SEP-10 arrive
 * with the signer port and are not part of this schema yet.
 */

import { describe, expect, it } from 'vitest';

import { InvalidInputError, networksConfigSchema, parseNetworksConfig } from './index.js';

const FACTORY = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SAC = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
const ISSUER = 'GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC';
// Circle's testnet USDC issuer, so the strkey check is proven on a real key.
const CIRCLE_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ADDR = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

function stellar(): Record<string, unknown> {
  return {
    enabled: true,
    rpc: [
      { url: 'secretRef:stellar_rpc_primary', weight: 2 },
      { url: 'secretRef:stellar_rpc_secondary', weight: 1 },
    ],
    maxEndpointLagSeconds: 15,
    trustedFactories: { '1': [FACTORY] },
    assets: { USDC: { sac: SAC, issuer: ISSUER } },
    deposits: { startLedger: 0, availableAt: 'included', pageEvents: 500 },
    executor: { txValiditySeconds: 60 },
    feeSponsor: {
      perPrincipalFundingAccounts: 1,
      reserveSponsorshipDailyStroops: '500000000',
      maxFeePerTxStroops: '1000000',
      perPrincipalPerMinute: 10,
      perPrincipalDailyCount: 200,
      perPrincipalDailyFeeStroops: '50000000',
      globalDailyFeeStroops: '5000000000',
      lowBalanceStroops: '1000000000',
      minBalanceStroops: '100000000',
    },
    signingWindowSeconds: 300,
    explorer: { tx: 'https://stellar.expert/explorer/public/tx/{hash}' },
    health: {
      maxHeadLagSeconds: 30,
      degradedErrorBps: 500,
      downErrorBps: 5000,
      hysteresisChecks: 3,
    },
  };
}

function celo(): Record<string, unknown> {
  return {
    enabled: true,
    rpc: [{ url: 'secretRef:celo_rpc_primary', weight: 1 }],
    maxEndpointLagSeconds: 10,
    feeCurrencyDirectory: ADDR(1),
    trustedFactories: { '1': [ADDR(2)] },
    assets: { USDC: { token: ADDR(3) }, USDm: { token: ADDR(4) } },
    finality: { depositAvailable: 'safe', receiptFinal: 'finalized', failoverProof: 'finalized' },
    deposits: { startBlock: 0, maxLogRange: 2000 },
    executor: { replaceAfterSeconds: 30, bumpPercent: 15, maxFeePerGasCapWei: '200000000000' },
    preparedTx: { maxFeePerGasCapWei: '200000000000', gasMarginBps: 2000 },
    mento: { slippageBps: 50 },
    explorer: { tx: 'https://celoscan.io/tx/{hash}' },
    health: {
      maxHeadLagSeconds: 20,
      degradedErrorBps: 500,
      downErrorBps: 5000,
      hysteresisChecks: 3,
    },
  };
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

// Sets a value at a dotted path inside a fresh copy of the base document.
function withChange(
  network: 'stellar:pubnet' | 'eip155:42220',
  dotted: string,
  value: unknown,
): Record<string, unknown> {
  const doc = network === 'stellar:pubnet' ? stellar() : celo();
  const keys = dotted.split('.');
  const last = keys.pop();
  if (last === undefined) throw new Error('empty path');
  let node = doc as Record<string, unknown>;
  for (const key of keys) node = node[key] as Record<string, unknown>;
  if (value === undefined) Reflect.deleteProperty(node, last);
  else node[last] = value;
  return { [network]: doc };
}

describe('parseNetworksConfig', () => {
  it('accepts the documented example for all four networks', () => {
    const config = parseNetworksConfig({
      'stellar:pubnet': stellar(),
      'stellar:testnet': { ...stellar(), enabled: false },
      'eip155:42220': celo(),
      'eip155:11142220': celo(),
    });
    expect(Object.keys(config).sort()).toEqual([
      'eip155:11142220',
      'eip155:42220',
      'stellar:pubnet',
      'stellar:testnet',
    ]);
    expect(config['stellar:testnet']?.enabled).toBe(false);
  });

  it('parses fee limits to bigint', () => {
    const config = parseNetworksConfig({ 'stellar:pubnet': stellar(), 'eip155:42220': celo() });
    expect(config['stellar:pubnet']?.feeSponsor.globalDailyFeeStroops).toBe(5_000_000_000n);
    expect(config['stellar:pubnet']?.feeSponsor.maxFeePerTxStroops).toBe(1_000_000n);
    expect(config['eip155:42220']?.executor.maxFeePerGasCapWei).toBe(200_000_000_000n);
    expect(config['eip155:42220']?.preparedTx.maxFeePerGasCapWei).toBe(200_000_000_000n);
  });

  it('accepts an empty section and a real testnet issuer', () => {
    expect(parseNetworksConfig({})).toEqual({});
    const doc = withChange('stellar:pubnet', 'assets.USDC.issuer', CIRCLE_TESTNET);
    expect(parseNetworksConfig(doc)['stellar:pubnet']?.assets.USDC.issuer).toBe(CIRCLE_TESTNET);
  });

  it('returns a frozen snapshot', () => {
    const config = parseNetworksConfig({ 'stellar:pubnet': stellar() });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config['stellar:pubnet'])).toBe(true);
    expect(Object.isFrozen(config['stellar:pubnet']?.rpc)).toBe(true);
    expect(Object.isFrozen(config['stellar:pubnet']?.rpc[0])).toBe(true);
  });

  it('exposes the schema for the routing document to compose', () => {
    expect(networksConfigSchema.safeParse({ 'stellar:pubnet': stellar() }).success).toBe(true);
    expect(networksConfigSchema.safeParse({ 'eip155:1': celo() }).success).toBe(false);
  });

  it.each([
    ['an unknown network', { 'eip155:1': celo() }],
    ['an EVM shape under a Stellar key', { 'stellar:pubnet': celo() }],
    ['a Stellar shape under an EVM key', { 'eip155:42220': stellar() }],
    ['an unknown field', withChange('stellar:pubnet', 'extra', 1)],
    ['a missing field', withChange('stellar:pubnet', 'health', undefined)],
    [
      'a plain RPC URL',
      withChange('stellar:pubnet', 'rpc', [{ url: 'https://rpc.example', weight: 1 }]),
    ],
    ['no RPC endpoint', withChange('eip155:42220', 'rpc', [])],
    [
      'a duplicate RPC reference',
      withChange('stellar:pubnet', 'rpc', [
        { url: 'secretRef:a', weight: 1 },
        { url: 'secretRef:a', weight: 1 },
      ]),
    ],
    ['a zero weight', withChange('eip155:42220', 'rpc', [{ url: 'secretRef:a', weight: 0 }])],
    [
      'a fractional weight',
      withChange('eip155:42220', 'rpc', [{ url: 'secretRef:a', weight: 1.5 }]),
    ],
    [
      'a bad factory checksum',
      withChange('stellar:pubnet', 'trustedFactories', { '1': [`${FACTORY.slice(0, -1)}7`] }),
    ],
    [
      'an account as a factory',
      withChange('stellar:pubnet', 'trustedFactories', { '1': [ISSUER] }),
    ],
    ['a contract as the issuer', withChange('stellar:pubnet', 'assets.USDC.issuer', SAC)],
    ['lowercase strkey', withChange('stellar:pubnet', 'assets.USDC.sac', SAC.toLowerCase())],
    [
      'an unknown spec version',
      withChange('stellar:pubnet', 'trustedFactories', { '2': [FACTORY] }),
    ],
    ['no trusted factory', withChange('eip155:42220', 'trustedFactories', { '1': [] })],
    [
      'a duplicate factory',
      withChange('eip155:42220', 'trustedFactories', { '1': [ADDR(2), ADDR(2)] }),
    ],
    ['a short EVM address', withChange('eip155:42220', 'feeCurrencyDirectory', '0x1234')],
    ['a missing USDm', withChange('eip155:42220', 'assets', { USDC: { token: ADDR(3) } })],
    ['a fee as a number', withChange('stellar:pubnet', 'feeSponsor.maxFeePerTxStroops', 1_000_000)],
    ['a negative fee', withChange('stellar:pubnet', 'feeSponsor.maxFeePerTxStroops', '-1')],
    [
      'a fee with a leading zero',
      withChange('eip155:42220', 'executor.maxFeePerGasCapWei', '0200'),
    ],
    [
      'a fee past i64',
      withChange('stellar:pubnet', 'feeSponsor.globalDailyFeeStroops', '9223372036854775808'),
    ],
    [
      'a fee past u256',
      withChange('eip155:42220', 'preparedTx.maxFeePerGasCapWei', `1${'0'.repeat(78)}`),
    ],
    ['down below degraded', withChange('stellar:pubnet', 'health.downErrorBps', 100)],
    ['bps past 10000', withChange('eip155:42220', 'health.downErrorBps', 10_001)],
    [
      'low balance below minimum',
      withChange('stellar:pubnet', 'feeSponsor.lowBalanceStroops', '1'),
    ],
    [
      'a per tx fee above the daily fee',
      withChange('stellar:pubnet', 'feeSponsor.maxFeePerTxStroops', '60000000'),
    ],
    [
      'a daily fee above the global fee',
      withChange('stellar:pubnet', 'feeSponsor.perPrincipalDailyFeeStroops', '6000000000'),
    ],
    [
      'a failover proof below finalized',
      withChange('eip155:42220', 'finality.failoverProof', 'safe'),
    ],
    ['a deposit at latest', withChange('eip155:42220', 'finality.depositAvailable', 'latest')],
    [
      'an explorer without the hash',
      withChange('stellar:pubnet', 'explorer.tx', 'https://stellar.expert/tx/'),
    ],
    [
      'an explorer over http',
      withChange('eip155:42220', 'explorer.tx', 'http://celoscan.io/tx/{hash}'),
    ],
    [
      'two hash slots',
      withChange('eip155:42220', 'explorer.tx', 'https://x.example/{hash}/{hash}'),
    ],
    ['a negative start ledger', withChange('stellar:pubnet', 'deposits.startLedger', -1)],
    ['a page above 1000 events', withChange('stellar:pubnet', 'deposits.pageEvents', 1001)],
    ['a bump below 10 percent', withChange('eip155:42220', 'executor.bumpPercent', 5)],
    ['a slippage above 10 percent', withChange('eip155:42220', 'mento.slippageBps', 1001)],
    ['enabled as a string', withChange('eip155:42220', 'enabled', 'true')],
    ['a non object', 'networks'],
    ['an array', []],
    ['null', null],
  ])('refuses %s', (_label, input) => {
    expect(thrown(() => parseNetworksConfig(input))).toBeInstanceOf(InvalidInputError);
  });

  it('names the failing paths without repeating any value', () => {
    const leaked = 'https://rpc.example/v1/sk_live_9f8e7d6c';
    const err = thrown(() =>
      parseNetworksConfig(withChange('stellar:pubnet', 'rpc', [{ url: leaked, weight: 1 }])),
    );
    expect(err).toBeInstanceOf(InvalidInputError);
    const message = (err as Error).message;
    expect(message).toContain('stellar:pubnet.rpc.0.url');
    expect(message).not.toContain('sk_live');
    expect(message).not.toContain('rpc.example');
    expect(JSON.stringify(err)).not.toContain('sk_live');
  });

  it('caps the message when many fields fail', () => {
    const err = thrown(() =>
      parseNetworksConfig({ 'stellar:pubnet': {}, 'stellar:testnet': {}, 'eip155:42220': {} }),
    );
    expect(err).toBeInstanceOf(InvalidInputError);
    expect((err as Error).message.length).toBeLessThan(1000);
  });
});
