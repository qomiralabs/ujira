// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// JSON between the signer services and their clients. The port carries
// bigints and byte arrays, which JSON has no form for, so each travels as a
// one key object: {"$bigint": "decimal"} or {"$bytes": "base64"}. Anything
// that only looks like one is left as an object, and the schema on the
// other side refuses it.

const BIGINT = /^-?(?:0|[1-9][0-9]{0,77})$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The most bytes a request or response body may hold. */
export const MAX_WIRE_BYTES = 256 * 1024;

export function toWire(value: unknown): string {
  return JSON.stringify(value, function replace(this: Record<string, unknown>, key, inner) {
    // The value before toJSON ran, so a Buffer is seen as bytes.
    const raw = this[key];
    if (typeof raw === 'bigint') return { $bigint: raw.toString() };
    if (raw instanceof Uint8Array) return { $bytes: Buffer.from(raw).toString('base64') };
    return inner as unknown;
  });
}

function revive(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1) return value;
  const tagged = value as Record<string, unknown>;
  const big = tagged['$bigint'];
  if (typeof big === 'string' && BIGINT.test(big)) return BigInt(big);
  const bytes = tagged['$bytes'];
  if (typeof bytes === 'string' && BASE64.test(bytes)) {
    return Uint8Array.from(Buffer.from(bytes, 'base64'));
  }
  return value;
}

/** The value a wire text holds, or undefined when it is not JSON. */
export function fromWire(text: string): unknown {
  try {
    return JSON.parse(text, revive) as unknown;
  } catch {
    return undefined;
  }
}
