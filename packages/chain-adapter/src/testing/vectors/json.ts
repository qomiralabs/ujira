// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// JSON values as the vectors and traces hold them, with the equality the
// contracts' comparator uses: objects compare as maps, whatever the key
// order, and lists compare in order.

export type Json = null | boolean | number | string | Json[] | JsonObject;

export interface JsonObject {
  [key: string]: Json;
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The member at `key`, or null when there is none, as serde_json indexes. */
export function at(value: Json | undefined, key: string): Json {
  return isObject(value) ? (value[key] ?? null) : null;
}

export function equal(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
    );
  }
  return false;
}

export function show(value: Json | undefined): string {
  return JSON.stringify(value ?? null);
}

/** An amount written as a decimal string, if it is one an i128 can hold. */
export function amountOf(value: Json | undefined): bigint | undefined {
  if (typeof value !== 'string' || !/^-?[0-9]{1,39}$/.test(value)) return undefined;
  const n = BigInt(value);
  return n >= -(1n << 127n) && n < 1n << 127n ? n : undefined;
}
