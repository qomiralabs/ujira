// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The ledger entries a mandate needs alive to be usable, as Stellar ledger
// keys. A mandate's money is not in the mandate: it is the asset contract's
// persistent Balance entry for the mandate address, with its own time to
// live. If that lapses the funds are archived, not lost, but every call
// needs a restore first and views show them gone, so it is kept alive with
// the mandate's own instance, code and persistent entries.
//
// Payout records and tombstones are deliberately absent. They live until
// their payout expires plus a day and then archive, which is safe because
// an archived tombstone still counts as present. Extending them here would
// keep every payout ever made alive at UJIRA's cost.

import { Address, xdr } from '@stellar/stellar-base';
import { z } from 'zod';

import { isAccountAddress, isContractAddress } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import type { Bytes32 } from '../types.js';

/** What each key keeps alive. */
export type KeepAliveKind = 'instance' | 'code' | 'balance' | 'allowed' | 'daily';

export interface KeepAliveKey {
  readonly kind: KeepAliveKind;
  /** The LedgerKey as base64 XDR, the form RPC getLedgerEntries takes. */
  readonly xdr: string;
}

/** One allowlist entry as the mandate stores it: by recipient, base address and tag. */
export interface AllowedEntry {
  readonly recipientRef: Bytes32;
  /** A G or C address; an M address is stored as its base and its tag. */
  readonly address: string;
  /** No tag and a tag of zero are different entries. */
  readonly tag: bigint | null;
}

export interface KeepAliveTarget {
  /** The mandate's C address. */
  readonly mandate: string;
  /** The settlement asset contract's C address. */
  readonly asset: string;
  /** The SHA-256 of the mandate's Wasm, in hex, as its instance names it. */
  readonly wasmHash: string;
  /** Every allowlist entry the mandate holds. */
  readonly allowed: readonly AllowedEntry[];
  /** Every recipient with a day usage entry. */
  readonly daily: readonly Bytes32[];
}

const U64_MAX = (1n << 64n) - 1n;
const BYTES32 = /^0x[0-9a-f]{64}$/;
// Enough for any mandate's allowlist; it only bounds one call's work.
const MAX_ENTRIES = 10_000;

const bytes32 = z.string().regex(BYTES32);

const targetSchema = z.strictObject({
  mandate: z.string().refine(isContractAddress),
  asset: z.string().refine(isContractAddress),
  wasmHash: z.string().regex(/^[0-9a-f]{64}$/),
  allowed: z
    .array(
      z.strictObject({
        recipientRef: bytes32,
        address: z.string().refine((a) => isAccountAddress(a) || isContractAddress(a)),
        tag: z.bigint().min(0n).max(U64_MAX).nullable(),
      }),
    )
    .max(MAX_ENTRIES),
  daily: z.array(bytes32).max(MAX_ENTRIES),
});

function persistentData(contract: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

// A contracttype enum variant is stored as a vector of its name and fields.
function variant(name: string, ...fields: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), ...fields]);
}

function refBytes(ref: string): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(ref.slice(2), 'hex'));
}

/**
 * The keys to keep alive for one mandate, each once, in a stable order:
 * instance, code, the asset Balance entry, then allowlist and day usage
 * entries. Throws InvalidInputError, naming paths only, for a target it
 * cannot key.
 */
export function keepAliveKeys(target: KeepAliveTarget): readonly KeepAliveKey[] {
  const parsed = targetSchema.safeParse(target);
  if (!parsed.success) {
    throw new InvalidInputError({
      issues: parsed.error.issues
        .slice(0, 10)
        .map((issue) => `target.${issue.path.map(String).join('.') || 'root'} (${issue.code})`),
    });
  }
  const t = parsed.data;
  const keys: [KeepAliveKind, xdr.LedgerKey][] = [
    ['instance', persistentData(t.mandate, xdr.ScVal.scvLedgerKeyContractInstance())],
    [
      'code',
      xdr.LedgerKey.contractCode(
        new xdr.LedgerKeyContractCode({ hash: Buffer.from(t.wasmHash, 'hex') }),
      ),
    ],
    [
      'balance',
      persistentData(t.asset, variant('Balance', Address.fromString(t.mandate).toScVal())),
    ],
    ...t.allowed.map((entry): [KeepAliveKind, xdr.LedgerKey] => [
      'allowed',
      persistentData(
        t.mandate,
        variant(
          'Allowed',
          refBytes(entry.recipientRef),
          Address.fromString(entry.address).toScVal(),
          entry.tag === null
            ? xdr.ScVal.scvVoid()
            : xdr.ScVal.scvU64(xdr.Uint64.fromString(entry.tag.toString())),
        ),
      ),
    ]),
    ...t.daily.map((ref): [KeepAliveKind, xdr.LedgerKey] => [
      'daily',
      persistentData(t.mandate, variant('Daily', refBytes(ref))),
    ]),
  ];
  const seen = new Set<string>();
  const out: KeepAliveKey[] = [];
  for (const [kind, key] of keys) {
    const text = key.toXDR('base64');
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(Object.freeze({ kind, xdr: text }));
  }
  return Object.freeze(out);
}
