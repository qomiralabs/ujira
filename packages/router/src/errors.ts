// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export const ROUTING_CONFIG_ERROR_CODES = Object.freeze([
  'ROUTING_CONFIG_INVALID',
  'ROUTING_CONFIG_UNAVAILABLE',
  'ROUTING_CONFIG_VERSION_NOT_FOUND',
  'ROUTING_CONFIG_STORE_TIMEOUT',
  'ROUTING_CONFIG_STORE_FAILED',
] as const);

export type RoutingConfigErrorCode = (typeof ROUTING_CONFIG_ERROR_CODES)[number];

// Messages are fixed per class. A message built from the document could
// carry a misplaced secret into a log, which is the mistake validation is
// there to catch.

/** Base of every routing configuration failure. Branch on `code`. */
export abstract class RoutingConfigError extends Error {
  abstract readonly code: RoutingConfigErrorCode;
}

/** The document failed validation. Issues name a path and a reason, never a value. */
export class RoutingConfigInvalidError extends RoutingConfigError {
  override readonly name = 'RoutingConfigInvalidError';
  readonly code = 'ROUTING_CONFIG_INVALID';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('Routing configuration is invalid');
    this.issues = Object.freeze([...issues]);
  }
}

/** No valid configuration has been loaded yet, so nothing can be routed. */
export class RoutingConfigUnavailableError extends RoutingConfigError {
  override readonly name = 'RoutingConfigUnavailableError';
  readonly code = 'ROUTING_CONFIG_UNAVAILABLE';

  constructor() {
    super('No routing configuration is loaded');
  }
}

export class RoutingConfigVersionNotFoundError extends RoutingConfigError {
  override readonly name = 'RoutingConfigVersionNotFoundError';
  readonly code = 'ROUTING_CONFIG_VERSION_NOT_FOUND';

  constructor() {
    super('Routing configuration version not found');
  }
}

export class RoutingConfigStoreTimeoutError extends RoutingConfigError {
  override readonly name = 'RoutingConfigStoreTimeoutError';
  readonly code = 'ROUTING_CONFIG_STORE_TIMEOUT';

  constructor() {
    super('Routing configuration store timed out');
  }
}

/** The store failed. The original error is kept as the cause. */
export class RoutingConfigStoreError extends RoutingConfigError {
  override readonly name = 'RoutingConfigStoreError';
  readonly code = 'ROUTING_CONFIG_STORE_FAILED';

  constructor(cause: unknown) {
    super('Routing configuration store failed', { cause });
  }
}

export function isRoutingConfigError(value: unknown): value is RoutingConfigError {
  return value instanceof RoutingConfigError;
}
