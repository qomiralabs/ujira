// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Contract values in and out of the mandate. A #[contracttype] struct
// crosses the boundary as a map keyed by its field names in sorted order, an
// Option as the value or void, and an enum variant as a vector holding its
// name and then its payload. Encoders validate what they are given and throw
// InvalidInputError naming the field; decoders throw InternalError, because
// a trusted mandate answering in another shape is a bug, not bad input.

import { Address, xdr } from '@stellar/stellar-sdk/base';

import { decodeAccountAddress, encodeMuxedAddress } from '../codecs/strkey.js';
import { InternalError, InvalidInputError } from '../errors.js';
import type { Bytes32, Destination } from '../types.js';

type ScVal = xdr.ScVal;

const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 4_294_967_295;
const BYTES32 = /^0x[0-9a-f]{64}$/;

function invalid(field: string): InvalidInputError {
  return new InvalidInputError({ issues: [`${field} (invalid)`] });
}

export function sym(name: string): ScVal {
  return xdr.ScVal.scvSymbol(name);
}

export function u32(field: string, n: number): ScVal {
  if (!Number.isSafeInteger(n) || n < 0 || n > U32_MAX) throw invalid(field);
  return xdr.ScVal.scvU32(n);
}

export function u64(field: string, n: bigint): ScVal {
  if (typeof n !== 'bigint' || n < 0n || n > U64_MAX) throw invalid(field);
  return xdr.ScVal.scvU64(n);
}

export function i128(field: string, n: bigint): ScVal {
  if (typeof n !== 'bigint' || n < I128_MIN || n > I128_MAX) throw invalid(field);
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: BigInt.asIntN(64, n >> 64n), lo: BigInt.asUintN(64, n) }),
  );
}

export function bytes(field: string, value: Uint8Array): ScVal {
  if (!(value instanceof Uint8Array)) throw invalid(field);
  return xdr.ScVal.scvBytes(Uint8Array.from(value));
}

export function bytes32(field: string, value: Bytes32): ScVal {
  if (typeof value !== 'string' || !BYTES32.test(value)) throw invalid(field);
  return xdr.ScVal.scvBytes(Buffer.from(value.slice(2), 'hex'));
}

/** A G or C address. Muxed forms are refused: only a destination carries a tag. */
export function address(field: string, value: string): ScVal {
  if (typeof value !== 'string' || !/^[GC]/.test(value)) throw invalid(field);
  try {
    return Address.fromString(value).toScVal();
  } catch {
    throw invalid(field);
  }
}

/** A destination as a MuxedAddress: the base address, or an M address when it has a tag. */
export function destination(field: string, d: Destination): ScVal {
  if (d.tag === null) return address(field, d.address.value);
  try {
    // Only an account can carry a tag, and only a u64 one.
    const key = decodeAccountAddress(d.address.value);
    return Address.fromString(encodeMuxedAddress(key, d.tag)).toScVal();
  } catch {
    throw invalid(field);
  }
}

export function vec(items: readonly ScVal[]): ScVal {
  return xdr.ScVal.scvVec([...items]);
}

export function option(value: ScVal | null): ScVal {
  return value ?? xdr.ScVal.scvVoid();
}

/** A contract struct: a map with symbol keys in sorted order, as the host requires. */
export function struct(fields: Readonly<Record<string, ScVal>>): ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, val]) => new xdr.ScMapEntry({ key: sym(name), val })),
  );
}

/** A unit enum variant, such as a storage key. */
export function unit(name: string): ScVal {
  return vec([sym(name)]);
}

// ---------------------------------------------------------------------------
// Decoding

function shape(): InternalError {
  return new InternalError();
}

export function fieldsOf(value: ScVal): ReadonlyMap<string, ScVal> {
  if (value.type !== 'scvMap') throw shape();
  const out = new Map<string, ScVal>();
  for (const entry of value.map ?? []) {
    if (entry.key.type !== 'scvSymbol') throw shape();
    out.set(entry.key.sym.toString(), entry.val);
  }
  return out;
}

export function field(fields: ReadonlyMap<string, ScVal>, name: string): ScVal {
  const value = fields.get(name);
  if (value === undefined) throw shape();
  return value;
}

export function asU32(value: ScVal): number {
  if (value.type !== 'scvU32') throw shape();
  return value.u32;
}

export function asU64(value: ScVal): bigint {
  if (value.type !== 'scvU64') throw shape();
  return value.u64;
}

export function asI128(value: ScVal): bigint {
  if (value.type !== 'scvI128') throw shape();
  return (value.i128.hi << 64n) | value.i128.lo;
}

export function asBool(value: ScVal): boolean {
  if (value.type !== 'scvBool') throw shape();
  return value.b;
}

export function asBytes(value: ScVal): Uint8Array {
  if (value.type !== 'scvBytes') throw shape();
  return value.bytes.value;
}

export function asBytes32(value: ScVal): Bytes32 {
  const raw = asBytes(value);
  if (raw.length !== 32) throw shape();
  return `0x${Buffer.from(raw).toString('hex')}` as Bytes32;
}

export function asAddress(value: ScVal): string {
  if (value.type !== 'scvAddress') throw shape();
  const text = Address.fromScAddress(value.address).toString();
  if (!/^[GC]/.test(text)) throw shape();
  return text;
}

export function asVec(value: ScVal): readonly ScVal[] {
  if (value.type !== 'scvVec') throw shape();
  return value.vec ?? [];
}

export function asOption(value: ScVal): ScVal | null {
  return value.type === 'scvVoid' ? null : value;
}

/** The variant name and payload of a contract enum value. */
export function asVariant(value: ScVal): {
  readonly name: string;
  readonly payload: readonly ScVal[];
} {
  const [head, ...payload] = asVec(value);
  if (head?.type !== 'scvSymbol') throw shape();
  return { name: head.sym.toString(), payload };
}
