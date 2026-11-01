// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

import { STRKEY_VERSION, isAccountAddress, isContractAddress, isStrkey } from './codecs/strkey.js';
import { InvalidInputError } from './errors.js';

// The networks section of the routing configuration. Only this package
// reads it; the router validates the chain agnostic sections itself.
// Signing keys appear as pinned key references, never as secrets.

const STROOPS_MAX = 2n ** 63n - 1n;
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

const bps = z.int().min(0).max(10_000);

// A typo in a factory or issuer would make every mandate look untrusted, or
// worse, trust the wrong contract, so the checksum is verified here rather
// than left to the first RPC call.
const stellarAccount = z.string().refine(isAccountAddress, {
  message: 'not a Stellar account',
});
const stellarContract = z.string().refine(isContractAddress, {
  message: 'not a Stellar contract',
});

// A signing key as configuration names it: the key manager it lives in,
// its ID there, and the account it must control. The address is pinned so
// the signer's own answer can be checked against it before any work starts.
// Key IDs are names, so anything shaped like a URL or a Stellar secret seed
// is refused: either would put a credential in the document.
const keyRef = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  keyId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/)
    .refine((id) => !id.includes('//') && !isStrkey(id, STRKEY_VERSION.seed), {
      message: 'not a key name',
    }),
  address: stellarAccount,
});

const anchorId = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);

const sep10Keys = z
  .array(z.strictObject({ anchorId, key: keyRef }))
  .max(64)
  .refine((list) => new Set(list.map((e) => e.anchorId)).size === list.length, {
    message: 'duplicate anchor',
  });

function uniqueList<T extends z.ZodType<string>>(item: T) {
  return z
    .array(item)
    .min(1)
    .max(16)
    .refine((list) => new Set(list).size === list.length, {
      message: 'duplicate entry',
    });
}

// Explorer links are templates filled at read time, so stored references
// never change when an explorer does.
// These links go into public receipts, so a template may not carry
// credentials: no userinfo, no query and no fragment, where explorer API
// keys usually sit, and no path segment that looks like one (key=value, or
// a long run of letters and digits). The hash belongs in the path, and the
// template may hold no other placeholder. A short key in the path cannot
// be told from an ordinary segment and is not detected.
const HASH_TOKEN = '{hash}';
const KEY_LIKE_SEGMENT = /=|%3d|%3f|%26/i;
const LONG_TOKEN = /^(?=[^/]*[0-9])(?=[^/]*[A-Za-z])[A-Za-z0-9_-]{20,}$/;

function isExplorerTemplate(template: string): boolean {
  if (!template.startsWith('https://') || template.split(HASH_TOKEN).length !== 2) return false;
  const rest = template.replace(HASH_TOKEN, '');
  if (/[{}]/.test(rest) || /hashslot/i.test(rest) || rest.includes('?') || rest.includes('#')) {
    return false;
  }
  // The template may not contain the stand in itself, so the only HASHSLOT
  // in the filled URL is the hash, and it must be a whole path segment.
  const filled = template.replace(HASH_TOKEN, 'HASHSLOT');
  if (!URL.canParse(filled)) return false;
  const url = new URL(filled);
  const segments = url.pathname.split('/');
  return (
    url.username === '' &&
    url.password === '' &&
    segments.includes('HASHSLOT') &&
    !segments.some((segment) => KEY_LIKE_SEGMENT.test(segment) || LONG_TOKEN.test(segment))
  );
}

const explorer = z.strictObject({
  tx: z
    .string()
    .max(256)
    .refine(isExplorerTemplate, { message: 'https template with one {hash} in the path' }),
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
    key: keyRef,
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

const stellarNetwork = z
  .strictObject({
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
    executor: z.strictObject({
      txValiditySeconds: z.int().min(10).max(300),
      // The channel account pool. Jobs lease one key at a time from it.
      keys: z.array(keyRef).min(1).max(256),
    }),
    feeSponsor,
    // UJIRA's login key for each anchor it pays out through.
    sep10: sep10Keys,
    signingWindowSeconds: z.int().min(30).max(SECONDS_PER_HOUR),
    // The operations team's pause-only guardian, added to new mandates
    // unless the principal opts out. An address only: the key is held by
    // people, not by the signer. Optional so a network can run before one
    // is assigned; creation then needs an explicit opt out.
    operationsGuardian: stellarAccount.optional(),
  })
  .superRefine((network, ctx) => {
    // One key, one role. The signer picks its policy from the ref it is
    // asked under, so a key that served two roles could be asked to sign
    // one role's payload under the other role's looser policy.
    const placed: { path: (string | number)[]; key: z.output<typeof keyRef> }[] = [
      ...network.executor.keys.map((key, index) => ({ path: ['executor', 'keys', index], key })),
      { path: ['feeSponsor', 'key'], key: network.feeSponsor.key },
      ...network.sep10.map((entry, index) => ({ path: ['sep10', index, 'key'], key: entry.key })),
    ];
    const addresses = new Set<string>();
    const ids = new Set<string>();
    for (const { path, key } of placed) {
      const id = JSON.stringify([key.provider, key.keyId]);
      if (addresses.has(key.address) || ids.has(id)) {
        ctx.addIssue({ code: 'custom', message: 'key used twice', path });
      }
      addresses.add(key.address);
      ids.add(id);
    }
    // The guardian can only pause. If it were also a key UJIRA signs with,
    // that key could pause and spend, which is what the split prevents.
    if (network.operationsGuardian !== undefined && addresses.has(network.operationsGuardian)) {
      ctx.addIssue({ code: 'custom', message: 'key used twice', path: ['operationsGuardian'] });
    }
  });

/** zod schema for the networks section, for the routing document to compose. */
export const networksConfigSchema = z.strictObject({
  'stellar:pubnet': stellarNetwork.optional(),
  'stellar:testnet': stellarNetwork.optional(),
});

type DeepReadonly<T> = T extends bigint | string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : { readonly [K in keyof T]: DeepReadonly<T[K]> };

export type NetworksConfig = DeepReadonly<z.output<typeof networksConfigSchema>>;
export type StellarNetworkConfig = NonNullable<NetworksConfig['stellar:pubnet']>;
/** A pinned signing key: provider, the key's ID there, and the account it controls. */
export type KeyRef = StellarNetworkConfig['feeSponsor']['key'];

const MAX_LISTED_ISSUES = 10;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Every key the schema declares, at any depth. Issue paths name only these,
// array indexes and positions, so no key taken from the input is ever
// echoed, however harmless it looks.
function declaredKeys(schema: z.ZodType, into: Set<string>): Set<string> {
  if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape)) {
      into.add(key);
      // zod types the shape loosely; every value in it is a schema.
      declaredKeys(child as z.ZodType, into);
    }
  } else if (schema instanceof z.ZodOptional) {
    declaredKeys(schema.unwrap() as z.ZodType, into);
  } else if (schema instanceof z.ZodArray) {
    declaredKeys(schema.element as z.ZodType, into);
  } else if (schema instanceof z.ZodPipe) {
    declaredKeys(schema.in as z.ZodType, into);
  }
  return into;
}

const DECLARED_KEYS: ReadonlySet<string> = declaredKeys(networksConfigSchema, new Set());
const ARRAY_INDEX = /^(?:0|[1-9][0-9]{0,8})$/;
const MAX_PATH_LENGTH = 96;
const MAX_DEPTH = 16;

/**
 * Appends one segment, or leaves the path as it is when the segment would
 * take it past the issue length. Paths are never cut mid segment.
 */
function extend(path: string, segment: string): string {
  const longer = `${path}.${segment}`;
  return longer.length <= MAX_PATH_LENGTH ? longer : path;
}

/** A declared key keeps its name; anything else is named by its position. */
function segmentFor(key: string, position: number, inArray: boolean): string {
  if (inArray ? ARRAY_INDEX.test(key) : DECLARED_KEYS.has(key)) return key;
  return `key_${String(position)}`;
}

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
  const inArray = Array.isArray(value);
  const plain = inArray ? proto === Array.prototype : proto === Object.prototype || proto === null;
  if (!plain) return `${path} (not_plain)`;
  const keys = Reflect.ownKeys(value).filter((key) => !(inArray && key === 'length'));
  for (const [position, key] of keys.entries()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)) {
      return `${path} (not_plain)`;
    }
    const next = extend(path, segmentFor(key, position, inArray));
    const inner = notPlainData(descriptor.value, next, depth + 1);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

function issuePath(path: readonly PropertyKey[]): string {
  // zod paths hold declared keys and array indexes only. Anything else is
  // named by its position as a backstop, so nothing could ever be echoed.
  return path.reduce<string>(
    (built, segment, position) =>
      extend(
        built,
        typeof segment === 'number'
          ? String(segment)
          : segmentFor(String(segment), position, false),
      ),
    'networks',
  );
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
