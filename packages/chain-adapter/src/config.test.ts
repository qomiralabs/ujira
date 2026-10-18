// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the networks section of the routing configuration
 * (config.ts).
 *
 * parseNetworksConfig(input: unknown) validates the section with a strict
 * zod schema and returns a frozen NetworksConfig keyed by network ID. Every
 * key is optional, so a deployment can carry only the testnets, but an
 * unknown network or field is refused.
 *
 * - RPC endpoints are secret references (secretRef:name), never URLs, so a
 *   provider key can never sit in the document.
 * - Stellar addresses are checked strkeys (version byte and CRC16).
 * - The input must be plain data: objects with Object.prototype or a null
 *   prototype, arrays, and own data properties only. An inherited field or
 *   a getter is refused before the schema reads anything.
 * - Fee limits in stroops are decimal strings parsed to bigint, so
 *   no amount ever passes through a JavaScript number.
 * - Cross field rules: downErrorBps >= degradedErrorBps, low balance alert
 *   >= minimum balance, per transaction fee <= per principal daily fee <=
 *   global daily fee.
 *
 * A bad document throws InvalidInputError with a fixed message whose issues
 * name the paths and issue codes only. Values never appear, because a misplaced secret is
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

// A Stellar entry whose health section comes from its prototype, not its
// own fields.
function inheritsHealth(): object {
  const { health, ...rest } = stellar();
  return Object.assign(Object.create({ health }) as object, rest);
}

function deeplyNested(levels: number): object {
  let node: object = {};
  for (let i = 0; i < levels; i += 1) node = { inner: node };
  return node;
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
  network: 'stellar:pubnet' | 'stellar:testnet',
  dotted: string,
  value: unknown,
): Record<string, unknown> {
  const doc = stellar();
  const keys = dotted.split('.');
  const last = keys.pop();
  if (last === undefined) throw new Error('empty path');
  let node = doc;
  for (const key of keys) node = node[key] as Record<string, unknown>;
  if (value === undefined) Reflect.deleteProperty(node, last);
  else node[last] = value;
  return { [network]: doc };
}

describe('parseNetworksConfig', () => {
  it('accepts the documented example for both networks', () => {
    const config = parseNetworksConfig({
      'stellar:pubnet': stellar(),
      'stellar:testnet': { ...stellar(), enabled: false },
    });
    expect(Object.keys(config).sort()).toEqual(['stellar:pubnet', 'stellar:testnet']);
    expect(config['stellar:testnet']?.enabled).toBe(false);
  });

  it('parses fee limits to bigint', () => {
    const config = parseNetworksConfig({ 'stellar:pubnet': stellar() });
    expect(config['stellar:pubnet']?.feeSponsor.globalDailyFeeStroops).toBe(5_000_000_000n);
    expect(config['stellar:pubnet']?.feeSponsor.maxFeePerTxStroops).toBe(1_000_000n);
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
    expect(networksConfigSchema.safeParse({ 'stellar:futurenet': stellar() }).success).toBe(false);
  });

  it.each([
    ['an unknown network', { 'stellar:futurenet': stellar() }],
    ['an unknown field', withChange('stellar:pubnet', 'extra', 1)],
    ['a missing field', withChange('stellar:pubnet', 'health', undefined)],
    [
      'a plain RPC URL',
      withChange('stellar:pubnet', 'rpc', [{ url: 'https://rpc.example', weight: 1 }]),
    ],
    ['no RPC endpoint', withChange('stellar:testnet', 'rpc', [])],
    [
      'a duplicate RPC reference',
      withChange('stellar:pubnet', 'rpc', [
        { url: 'secretRef:a', weight: 1 },
        { url: 'secretRef:a', weight: 1 },
      ]),
    ],
    ['a zero weight', withChange('stellar:testnet', 'rpc', [{ url: 'secretRef:a', weight: 0 }])],
    [
      'a fractional weight',
      withChange('stellar:testnet', 'rpc', [{ url: 'secretRef:a', weight: 1.5 }]),
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
    ['no trusted factory', withChange('stellar:testnet', 'trustedFactories', { '1': [] })],
    [
      'a getter',
      {
        get 'stellar:pubnet'() {
          return stellar();
        },
      },
    ],
    ['an inherited network', Object.create({ 'stellar:testnet': stellar() }) as unknown],
    ['an inherited nested field', { 'stellar:testnet': inheritsHealth() }],
    ['nesting past sixteen levels', { 'stellar:testnet': deeplyNested(20) }],
    [
      'a getter under a key that is never echoed',
      {
        'stellar:pubnet': {
          'not a key!': {
            get x() {
              return 1;
            },
          },
        },
      },
    ],
    ['a class instance', { 'stellar:testnet': Object.assign(new Date(0), stellar()) }],
    ['a fee as a number', withChange('stellar:pubnet', 'feeSponsor.maxFeePerTxStroops', 1_000_000)],
    ['a negative fee', withChange('stellar:pubnet', 'feeSponsor.maxFeePerTxStroops', '-1')],
    [
      'a fee past i64',
      withChange('stellar:pubnet', 'feeSponsor.globalDailyFeeStroops', '9223372036854775808'),
    ],
    ['down below degraded', withChange('stellar:pubnet', 'health.downErrorBps', 100)],
    ['bps past 10000', withChange('stellar:testnet', 'health.downErrorBps', 10_001)],
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
      'an explorer without the hash',
      withChange('stellar:pubnet', 'explorer.tx', 'https://stellar.expert/tx/'),
    ],
    [
      'an explorer with userinfo',
      withChange('stellar:pubnet', 'explorer.tx', 'https://user:APIKEY@stellar.expert/tx/{hash}'),
    ],
    [
      'an explorer with a username only',
      withChange('stellar:pubnet', 'explorer.tx', 'https://APIKEY@stellar.expert/tx/{hash}'),
    ],
    [
      'an explorer with an api key',
      withChange(
        'stellar:testnet',
        'explorer.tx',
        'https://explorer.example/tx/{hash}?apikey=APIKEY',
      ),
    ],
    [
      'an explorer with a token',
      withChange(
        'stellar:testnet',
        'explorer.tx',
        'https://explorer.example/tx/{hash}?token=APIKEY',
      ),
    ],
    [
      'an explorer with a long key shaped path segment',
      withChange(
        'stellar:testnet',
        'explorer.tx',
        'https://explorer.example/AbC123xyz789QWE456rty0/tx/{hash}',
      ),
    ],
    [
      'an explorer with key= in the path',
      withChange('stellar:testnet', 'explorer.tx', 'https://explorer.example/apikey=abc/tx/{hash}'),
    ],
    [
      'an explorer with an encoded query in the path',
      withChange(
        'stellar:testnet',
        'explorer.tx',
        'https://explorer.example/tx%3Fapikey%3Dabc/{hash}',
      ),
    ],
    [
      'an explorer that writes the placeholder literally',
      withChange('stellar:testnet', 'explorer.tx', 'https://{hash}.evil.io/HASHSLOT'),
    ],
    [
      'an explorer with the placeholder word in the path',
      withChange('stellar:testnet', 'explorer.tx', 'https://explorer.example/hashslot/tx/{hash}'),
    ],
    [
      'an explorer with another placeholder',
      withChange('stellar:testnet', 'explorer.tx', 'https://explorer.example/{network}/tx/{hash}'),
    ],
    [
      'an explorer with a password only',
      withChange('stellar:pubnet', 'explorer.tx', 'https://:APIKEY@stellar.expert/tx/{hash}'),
    ],
    [
      'an explorer with an empty query',
      withChange('stellar:testnet', 'explorer.tx', 'https://explorer.example/tx/{hash}?'),
    ],
    [
      'an explorer with an empty fragment',
      withChange('stellar:testnet', 'explorer.tx', 'https://explorer.example/tx/{hash}#'),
    ],
    [
      'an explorer with the hash in the host',
      withChange('stellar:testnet', 'explorer.tx', 'https://{hash}.explorer.example/tx'),
    ],
    [
      'an explorer that is not a URL',
      withChange('stellar:testnet', 'explorer.tx', 'https://[{hash}'),
    ],
    [
      'an explorer with any query',
      withChange('stellar:testnet', 'explorer.tx', 'https://explorer.example/tx/{hash}?ref=ujira'),
    ],
    [
      'an explorer with the hash in the query',
      withChange('stellar:testnet', 'explorer.tx', 'https://explorer.example/tx?hash={hash}'),
    ],
    [
      'an explorer with a fragment',
      withChange('stellar:testnet', 'explorer.tx', 'https://explorer.example/tx/{hash}#key=APIKEY'),
    ],
    [
      'an explorer over http',
      withChange('stellar:testnet', 'explorer.tx', 'http://explorer.example/tx/{hash}'),
    ],
    [
      'two hash slots',
      withChange('stellar:testnet', 'explorer.tx', 'https://x.example/{hash}/{hash}'),
    ],
    ['a negative start ledger', withChange('stellar:pubnet', 'deposits.startLedger', -1)],
    ['a page above 1000 events', withChange('stellar:pubnet', 'deposits.pageEvents', 1001)],
    ['enabled as a string', withChange('stellar:testnet', 'enabled', 'true')],
    ['a non object', 'networks'],
    ['an array', []],
    ['null', null],
  ])('refuses %s', (_label, input) => {
    expect(thrown(() => parseNetworksConfig(input))).toBeInstanceOf(InvalidInputError);
  });

  it('accepts ordinary explorer templates', () => {
    for (const tx of [
      'https://stellar.expert/explorer/public/tx/{hash}',
      'https://explorer.example/tx/{hash}',
      'https://stellar.expert/explorer/testnet/tx/{hash}',
      'https://explorer.example/v2/tx/{hash}/details',
    ]) {
      const doc = withChange('stellar:testnet', 'explorer.tx', tx);
      expect(parseNetworksConfig(doc)['stellar:testnet']?.explorer.tx).toBe(tx);
    }
  });

  it('names the failing paths without repeating any value', () => {
    const leaked = 'https://rpc.example/v1/sk_live_9f8e7d6c';
    const err = thrown(() =>
      parseNetworksConfig(withChange('stellar:pubnet', 'rpc', [{ url: leaked, weight: 1 }])),
    );
    expect(err).toBeInstanceOf(InvalidInputError);
    const { message, issues } = err as InvalidInputError;
    expect(issues.join(' ')).toContain('stellar:pubnet.rpc.0.url');
    for (const text of [message, ...issues, JSON.stringify(err), String((err as Error).stack)]) {
      expect(text).not.toContain('sk_live');
      expect(text).not.toContain('rpc.example');
    }
  });

  it('reports a non plain node by its path, and never an unsafe key', () => {
    const deep = thrown(() => parseNetworksConfig({ 'stellar:testnet': deeplyNested(20) }));
    expect((deep as InvalidInputError).issues[0]).toMatch(
      // inner is not a schema key, so each level is named by position.
      /^networks\.stellar:testnet(\.key_0)+ \(too_deep\)$/,
    );
    const getter = thrown(() =>
      parseNetworksConfig({
        'stellar:pubnet': {
          'sk_live key': {
            get x() {
              return 1;
            },
          },
        },
      }),
    );
    expect((getter as InvalidInputError).issues).toEqual([
      'networks.stellar:pubnet.key_0 (not_plain)',
    ]);
    // A key that looks like a safe segment is still never echoed unless the
    // schema declares it.
    // Built at run time so no token shaped literal sits in the source: the
    // alphabet a to z plus 012345, 32 characters that pass the safe segment
    // pattern.
    const token = String.fromCharCode(...Array.from({ length: 26 }, (_, i) => 97 + i)) + '012345';
    const echoed = thrown(() =>
      parseNetworksConfig({
        'stellar:pubnet': {
          enabled: true,
          [token]: {
            get x() {
              return 1;
            },
          },
        },
      }),
    );
    const issues = (echoed as InvalidInputError).issues;
    expect(issues).toEqual(['networks.stellar:pubnet.key_1 (not_plain)']);
    expect(issues.join(' ')).not.toContain(token);
    // Declared keys keep their names.
    const declared = thrown(() =>
      parseNetworksConfig({
        'stellar:testnet': {
          ...stellar(),
          health: {
            get maxHeadLagSeconds() {
              return 50;
            },
          },
        },
      }),
    );
    expect((declared as InvalidInputError).issues).toEqual([
      'networks.stellar:testnet.health (not_plain)',
    ]);
  });

  it('keeps issue paths whole and within the issue length', () => {
    for (const levels of [2, 10, 16]) {
      const err = thrown(() =>
        parseNetworksConfig({ 'stellar:testnet': { ...stellar(), health: deeplyNested(levels) } }),
      ) as InvalidInputError;
      for (const issue of err.issues) {
        const [path = ''] = issue.split(' ');
        expect(path.length).toBeLessThanOrEqual(96);
        for (const segment of path.split('.')) expect(segment).toMatch(/^[A-Za-z0-9_:]+$/);
      }
    }
  });

  it('caps the message when many fields fail', () => {
    const err = thrown(() => parseNetworksConfig({ 'stellar:pubnet': {}, 'stellar:testnet': {} }));
    expect(err).toBeInstanceOf(InvalidInputError);
    expect((err as InvalidInputError).issues).toHaveLength(10);
  });
});
