// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

import { InvalidInputError } from './errors.js';
import { isEip55Address } from './keccak.js';

// The networks section of the routing configuration. Only this package
// reads it; the router validates the chain agnostic sections itself.
// Signing keys join this schema with the signer port, as pinned key
// references rather than secrets.

const STROOPS_MAX = 2n ** 63n - 1n;
const WEI_MAX = 2n ** 256n - 1n;
const SECONDS_PER_HOUR = 3600;

// A reference into the secret manager. Provider URLs embed API keys, so the
// document holds names only and never a URL.
const secretRef = z.string().regex(/^secretRef:[a-z][a-z0-9_]{0,63}$/);

const rpcList = z
  .array(z.strictObject({ url: secretRef, weight: z.int().min(1).max(100) }))
  .min(1)
  .max(8)
  .refine((list) => new Set(list.map((e) => e.url)).size === list.length, {
    message: 'duplicate endpoint',
  });

// Fee limits are decimal strings so no amount passes through a number.
function decimalAmount(max: bigint) {
  return z
    .string()
    .regex(/^(?:0|[1-9][0-9]{0,77})$/)
    .transform((text) => BigInt(text))
    .refine((value) => value <= max, { message: 'out of range' });
}
const stroops = decimalAmount(STROOPS_MAX);
const wei = decimalAmount(WEI_MAX);

const bps = z.int().min(0).max(10_000);

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STRKEY_ACCOUNT = 6 << 3;
const STRKEY_CONTRACT = 2 << 3;

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// A typo in a factory or issuer would make every mandate look untrusted, or
// worse, trust the wrong contract, so the checksum is verified here rather
// than left to the first RPC call.
function isStrkey(text: string, version: number): boolean {
  if (!/^[A-Z2-7]{56}$/.test(text)) return false;
  const bytes = new Uint8Array(35);
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const char of text) {
    // Only the low bits not yet emitted matter, so the buffer stays small.
    buffer = ((buffer << 5) | BASE32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[at] = (buffer >> bits) & 0xff;
      at += 1;
    }
  }
  // 56 characters carry 280 bits, exactly 35 bytes, so nothing is left over.
  const body = bytes.subarray(0, 33);
  const crc = crc16Xmodem(body);
  return bytes[0] === version && bytes[33] === (crc & 0xff) && bytes[34] === crc >> 8;
}

const stellarAccount = z.string().refine((s) => isStrkey(s, STRKEY_ACCOUNT), {
  message: 'not a Stellar account',
});
const stellarContract = z.string().refine((s) => isStrkey(s, STRKEY_CONTRACT), {
  message: 'not a Stellar contract',
});
// The same reasoning as for strkeys: an address with a wrong letter is
// another account, so the EIP-55 checksum must hold. The zero address is
// where tokens go to be burned and is never a factory or a token.
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const evmAddress = z
  .string()
  .refine((s) => s !== ZERO_ADDRESS && isEip55Address(s), { message: 'not a checksummed address' });

// Duplicates are compared through `normalize`, so two spellings of one EVM
// address count as one.
function uniqueList<T extends z.ZodType<string>>(item: T, normalize = (v: string) => v) {
  return z
    .array(item)
    .min(1)
    .max(16)
    .refine((list) => new Set(list.map(normalize)).size === list.length, {
      message: 'duplicate entry',
    });
}

// Explorer links are templates filled at read time, so stored references
// never change when an explorer does.
const explorer = z.strictObject({
  tx: z
    .string()
    .max(256)
    .refine(
      (t) =>
        t.startsWith('https://') &&
        t.split('{hash}').length === 2 &&
        URL.canParse(t.replace('{hash}', 'h')),
      { message: 'https template with one {hash}' },
    ),
});

const health = z
  .strictObject({
    maxHeadLagSeconds: z.int().min(1).max(SECONDS_PER_HOUR),
    degradedErrorBps: bps,
    downErrorBps: bps,
    hysteresisChecks: z.int().min(1).max(100),
  })
  .refine((h) => h.downErrorBps >= h.degradedErrorBps, {
    message: 'down below degraded',
    path: ['downErrorBps'],
  });

const common = {
  enabled: z.boolean(),
  rpc: rpcList,
  maxEndpointLagSeconds: z.int().min(1).max(SECONDS_PER_HOUR),
  explorer,
  health,
};

const feeSponsor = z
  .strictObject({
    perPrincipalFundingAccounts: z.int().min(0).max(10),
    reserveSponsorshipDailyStroops: stroops,
    maxFeePerTxStroops: stroops,
    perPrincipalPerMinute: z.int().min(1).max(10_000),
    perPrincipalDailyCount: z.int().min(1).max(1_000_000),
    perPrincipalDailyFeeStroops: stroops,
    globalDailyFeeStroops: stroops,
    lowBalanceStroops: stroops,
    minBalanceStroops: stroops,
  })
  .refine((f) => f.maxFeePerTxStroops <= f.perPrincipalDailyFeeStroops, {
    message: 'per transaction fee above the daily fee',
    path: ['maxFeePerTxStroops'],
  })
  .refine((f) => f.perPrincipalDailyFeeStroops <= f.globalDailyFeeStroops, {
    message: 'principal daily fee above the global fee',
    path: ['perPrincipalDailyFeeStroops'],
  })
  .refine((f) => f.lowBalanceStroops >= f.minBalanceStroops, {
    message: 'alert below the minimum balance',
    path: ['lowBalanceStroops'],
  });

const stellarNetwork = z.strictObject({
  ...common,
  trustedFactories: z.strictObject({ '1': uniqueList(stellarContract) }),
  assets: z.strictObject({
    USDC: z.strictObject({ sac: stellarContract, issuer: stellarAccount }),
  }),
  deposits: z.strictObject({
    startLedger: z.int().min(0).max(4_294_967_295),
    // Stellar has no reorgs, so inclusion is final; both spellings are allowed.
    availableAt: z.enum(['included', 'final']),
    pageEvents: z.int().min(1).max(1000),
  }),
  executor: z.strictObject({ txValiditySeconds: z.int().min(10).max(300) }),
  feeSponsor,
  signingWindowSeconds: z.int().min(30).max(SECONDS_PER_HOUR),
});

const evmNetwork = z.strictObject({
  ...common,
  feeCurrencyDirectory: evmAddress,
  trustedFactories: z.strictObject({
    '1': uniqueList(evmAddress, (v) => v.toLowerCase()),
  }),
  assets: z.strictObject({
    USDC: z.strictObject({ token: evmAddress }),
    USDm: z.strictObject({ token: evmAddress }),
  }),
  finality: z.strictObject({
    depositAvailable: z.enum(['safe', 'finalized']),
    receiptFinal: z.enum(['safe', 'finalized']),
    // Failover sends the next attempt to another network, which is only safe
    // once this one can never land. Anything short of finalized can reorg.
    failoverProof: z.literal('finalized'),
  }),
  deposits: z.strictObject({
    startBlock: z.int().min(0),
    maxLogRange: z.int().min(1).max(10_000),
  }),
  executor: z.strictObject({
    replaceAfterSeconds: z.int().min(5).max(600),
    // Nodes refuse a replacement that bumps the fee by less than 10 percent.
    bumpPercent: z.int().min(10).max(100),
    maxFeePerGasCapWei: wei,
  }),
  preparedTx: z.strictObject({ maxFeePerGasCapWei: wei, gasMarginBps: bps }),
  mento: z.strictObject({ slippageBps: z.int().min(0).max(1000) }),
});

/** zod schema for the networks section, for the routing document to compose. */
export const networksConfigSchema = z.strictObject({
  'stellar:pubnet': stellarNetwork.optional(),
  'stellar:testnet': stellarNetwork.optional(),
  'eip155:42220': evmNetwork.optional(),
  'eip155:11142220': evmNetwork.optional(),
});

type DeepReadonly<T> = T extends bigint | string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : { readonly [K in keyof T]: DeepReadonly<T[K]> };

export type NetworksConfig = DeepReadonly<z.output<typeof networksConfigSchema>>;
export type StellarNetworkConfig = NonNullable<NetworksConfig['stellar:pubnet']>;
export type EvmNetworkConfig = NonNullable<NetworksConfig['eip155:42220']>;

const MAX_LISTED_ISSUES = 10;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Paths are built from schema keys and indexes only. A key that does not
// fit the safe issue shape is reported as its parent rather than echoed.
const SAFE_SEGMENT = /^[A-Za-z0-9_:]{1,32}$/;

const MAX_DEPTH = 16;

/**
 * The first place `value` stops being plain data, or undefined. zod reads
 * fields with ordinary property access, which follows prototypes and runs
 * getters, so anything but own data properties on plain objects and arrays
 * is refused before the schema looks at it.
 */
function notPlainData(value: unknown, path: string, depth: number): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (depth > MAX_DEPTH) return `${path} (too_deep)`;
  const proto: unknown = Object.getPrototypeOf(value);
  const plain = Array.isArray(value)
    ? proto === Array.prototype
    : proto === Object.prototype || proto === null;
  if (!plain) return `${path} (not_plain)`;
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)) {
      return `${path} (not_plain)`;
    }
    // A key that does not look like a schema key is never echoed; the
    // issue then points at its parent.
    // Paths stop growing at the issue length limit rather than being cut
    // mid segment.
    const longer = `${path}.${key}`;
    const next = SAFE_SEGMENT.test(key) && longer.length <= 96 ? longer : path;
    const inner = notPlainData(descriptor.value, next, depth + 1);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

function issuePath(path: readonly PropertyKey[]): string {
  // zod paths hold schema keys and indexes only; the filter is a backstop
  // so nothing else could ever be echoed.
  const parts = path.map(String).filter((segment) => SAFE_SEGMENT.test(segment));
  return ['networks', ...parts].join('.').slice(0, 96);
}

/**
 * Validates the networks section and returns a frozen snapshot. A bad
 * document throws InvalidInputError whose issues name paths and issue codes
 * only, never a value.
 */
export function parseNetworksConfig(input: unknown): NetworksConfig {
  const unsafe = notPlainData(input, 'networks', 0);
  if (unsafe !== undefined) {
    throw new InvalidInputError({ issues: [unsafe] });
  }
  const result = networksConfigSchema.safeParse(input);
  if (!result.success) {
    // zod messages can quote what was received, and a misplaced secret is
    // exactly the mistake this catches, so only paths and codes are kept.
    const issues = result.error.issues
      .slice(0, MAX_LISTED_ISSUES)
      .map((issue) => `${issuePath(issue.path)} (${issue.code})`);
    throw new InvalidInputError({ issues });
  }
  return deepFreeze(result.data);
}
