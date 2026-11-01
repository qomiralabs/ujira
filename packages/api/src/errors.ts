// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The one place that decides what a failure looks like on the wire. Handlers
// throw ApiError for what they know, and anything else they let escape (an
// adapter error, a database outage, a bug) is mapped here, so two endpoints
// can never answer the same failure with different codes.

import { PROBLEM_CODES, PROBLEM_TITLES } from '@ujira/api-schema';
import type { FieldError, ProblemCode } from '@ujira/api-schema';
import { ChainAdapterError } from '@ujira/chain-adapter';
import type { ChainAdapterErrorCode } from '@ujira/chain-adapter';
import {
  DatabaseConfigError,
  DatabaseUnavailableError,
  SessionStateError,
  TenantContextError,
} from '@ujira/db';

/**
 * Seconds a client should wait before retrying, for each code that is worth
 * a retry. A thrown error can ask for longer, never for none.
 */
export const RETRY_AFTER_SECONDS: Readonly<Partial<Record<ProblemCode, number>>> = Object.freeze({
  RATE_LIMITED: 1,
  DB_UNAVAILABLE: 5,
  CHAIN_UNAVAILABLE: 5,
  REQUEST_TIMEOUT: 2,
});

export interface ApiErrorOptions {
  /** Shown to the client, so fixed text only: never a value from the request or a dependency. */
  readonly detail?: string;
  readonly errors?: readonly FieldError[];
  readonly retryAfterSeconds?: number;
}

/** A failure with a stable code. The message is the code's fixed title. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ProblemCode;
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: readonly FieldError[];
  /** Null for a code that is not worth retrying. */
  readonly retryAfterSeconds: number | null;

  constructor(code: ProblemCode, options: ApiErrorOptions = {}) {
    super(PROBLEM_TITLES[code]);
    this.code = code;
    this.status = PROBLEM_CODES[code];
    this.detail = options.detail;
    this.errors = Object.freeze([...(options.errors ?? [])]);
    const base = RETRY_AFTER_SECONDS[code];
    const asked = options.retryAfterSeconds;
    this.retryAfterSeconds =
      base === undefined
        ? null
        : asked !== undefined && Number.isSafeInteger(asked) && asked > base
          ? asked
          : base;
  }
}

/**
 * What each adapter failure means to an API client. A record over every
 * code, so a code added to the adapter does not compile until someone
 * decides how the API answers it.
 *
 * - Outages that pass on their own are CHAIN_UNAVAILABLE with Retry-After.
 * - A mandate of another tenant is NOT_FOUND, never a hint that it exists.
 * - Signer, sponsor and executor trouble is ours, not the client's, so it is
 *   INTERNAL with no detail.
 */
export const ADAPTER_ERROR_MAP: Readonly<Record<ChainAdapterErrorCode, ProblemCode>> =
  Object.freeze({
    INVALID_INPUT: 'INVALID_REQUEST',
    UNSUPPORTED: 'INVALID_REQUEST',
    TENANT_MISMATCH: 'NOT_FOUND',
    MANDATE_UNTRUSTED: 'MANDATE_REFUSED',
    MANDATE_RULE: 'MANDATE_REFUSED',
    CHAIN_UNAVAILABLE: 'CHAIN_UNAVAILABLE',
    RPC_TIMEOUT: 'CHAIN_UNAVAILABLE',
    RPC_LAGGING: 'CHAIN_UNAVAILABLE',
    RPC_RATE_LIMITED: 'CHAIN_UNAVAILABLE',
    SUBMISSION_REJECTED: 'INTERNAL',
    SUBMISSION_UNKNOWN: 'CHAIN_UNAVAILABLE',
    SIGNED_PAYLOAD_MISMATCH: 'INTERNAL',
    SIGNING_REQUEST_EXPIRED: 'INTERNAL',
    SIGNER_UNAVAILABLE: 'CHAIN_UNAVAILABLE',
    SIGNER_DENIED: 'INTERNAL',
    SIGNER_ADDRESS_MISMATCH: 'INTERNAL',
    SPONSOR_DENIED: 'INTERNAL',
    SPONSOR_UNFUNDED: 'INTERNAL',
    EXECUTOR_UNFUNDED: 'INTERNAL',
    DESTINATION_INVALID: 'DESTINATION_INVALID',
    QUOTE_EXPIRED: 'QUOTE_UNAVAILABLE',
    QUOTE_UNAVAILABLE: 'QUOTE_UNAVAILABLE',
    LIQUIDITY_UNAVAILABLE: 'QUOTE_UNAVAILABLE',
    RAIL_UNAVAILABLE: 'CHAIN_UNAVAILABLE',
    RAIL_REJECTED: 'INTERNAL',
    RAIL_TIMEOUT: 'CHAIN_UNAVAILABLE',
    RAIL_ACTION_REQUIRED: 'INTERNAL',
    CROSS_CHAIN_LIVE: 'INTERNAL',
    REORGED: 'INTERNAL',
    INTERNAL: 'INTERNAL',
  });

// Errors of the database package and what they mean to a client. Only the
// outage is the client's business; the rest are bugs on our side.
const DATABASE_ERRORS: readonly (readonly [new (...args: never[]) => Error, ProblemCode])[] = [
  [DatabaseUnavailableError, 'DB_UNAVAILABLE'],
  [DatabaseConfigError, 'INTERNAL'],
  [TenantContextError, 'INTERNAL'],
  [SessionStateError, 'INTERNAL'],
];

export const DATABASE_ERROR_CLASSES: readonly string[] = Object.freeze(
  DATABASE_ERRORS.map(([type]) => type.name),
);

function secondsFrom(ms: number | null): number | undefined {
  return ms === null ? undefined : Math.ceil(ms / 1000);
}

/**
 * The API form of anything thrown. Unknown errors become INTERNAL; the
 * caller logs the original's class name, and nothing of it reaches the
 * client.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ChainAdapterError) {
    const retryAfterSeconds = secondsFrom(error.retryAfterMs);
    return new ApiError(
      ADAPTER_ERROR_MAP[error.code],
      retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
    );
  }
  for (const [type, code] of DATABASE_ERRORS) {
    if (error instanceof type) return new ApiError(code);
  }
  return new ApiError('INTERNAL');
}

/** Raised at startup when the route table cannot be served as written. */
export class RouteRegistryError extends Error {
  override readonly name = 'RouteRegistryError';
}

/** The API's settings did not parse. Names the setting, never its value. */
export class ApiConfigError extends Error {
  override readonly name = 'ApiConfigError';
}
