// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/**
 * Reads one option, exactly once. A key the caller did not set that would
 * resolve through Object.prototype counts as absent, so a polluted prototype
 * (Object.prototype.rounding = 'ceil') cannot change money output. Keys on
 * the caller's own object, or answered by a proxy, are read normally.
 */
export function readOption(options: object, key: string): unknown {
  if (!Object.hasOwn(options, key) && key in Object.prototype) return undefined;
  return (options as Record<string, unknown>)[key];
}
