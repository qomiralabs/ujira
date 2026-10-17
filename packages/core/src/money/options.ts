// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/**
 * True only for a plain record: an object whose prototype is Object.prototype
 * or null. Class instances, arrays and objects built on another object are
 * refused, so no field can come from a prototype the caller did not write. A
 * proxy reports its target's prototype, so a proxy over a plain object passes.
 */
export function isPlainRecord(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reads one field of a plain record, exactly once. On a plain record the only
 * possible inherited source is Object.prototype, so a key the caller did not
 * set that resolves there counts as absent and a polluted prototype can never
 * supply it. Own keys, and keys a proxy answers, are read normally.
 */
export function readOwnField(record: object, key: string): unknown {
  if (!Object.hasOwn(record, key) && key in Object.prototype) return undefined;
  return (record as Record<string, unknown>)[key];
}
