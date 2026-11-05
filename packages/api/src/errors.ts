// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The one place that decides what a failure looks like on the wire. Handlers
// throw ApiError for what they know, and anything else they let escape (an
// adapter error, a database outage, a bug) is mapped here, so two endpoints
// can never answer the same failure with different codes.

import { PROBLEM_CODES, PROBLEM_TITLES } from '@ujira/api-schema';
import type { FieldError, ProblemCode, ProblemFix } from '@ujira/api-schema';
import {
  ChainAdapterError,
  InvalidInputError,
  MandateRuleError,
  UNSUPPORTED_MEMO_DESTINATION_MESSAGE,
  UnsupportedMemoDestinationError,
} from '@ujira/chain-adapter';
import type { ChainAdapterErrorCode, MandateErrorName } from '@ujira/chain-adapter';
import {
  DatabaseConfigError,
  DatabaseUnavailableError,
  SessionStateError,
  TenantContextError,
} from '@ujira/db';
import { MandatePolicyError, PolicyStoreError, PrincipalKeyRiskError } from '@ujira/mandates';
import type { MandatePolicyErrorCode } from '@ujira/mandates';

/**
 * Seconds a client should wait before retrying, for each code that is worth
 * a retry. A thrown error can ask for longer, never for none.
 */
export const RETRY_AFTER_SECONDS: Readonly<Partial<Record<ProblemCode, number>>> = Object.freeze({
  RATE_LIMITED: 1,
  // A person has to set one up, so there is no point hurrying.
  OPERATIONS_GUARDIAN_NOT_CONFIGURED: 300,
  IDEMPOTENCY_IN_PROGRESS: 1,
  DB_UNAVAILABLE: 5,
  CHAIN_UNAVAILABLE: 5,
  REQUEST_TIMEOUT: 2,
  // Providers retry on their own schedule; this only tells them not to hurry.
  WEBHOOK_UNAVAILABLE: 60,
});

export interface ApiErrorOptions {
  /** Shown to the client, so fixed text only: never a value from the request or a dependency. */
  readonly detail?: string;
  readonly errors?: readonly FieldError[];
  readonly retryAfterSeconds?: number;
  /** What the client can do about it, from a closed list. */
  readonly fixes?: readonly ProblemFix[];
}

/** A failure with a stable code. The message is the code's fixed title. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ProblemCode;
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: readonly FieldError[];
  readonly fixes: readonly ProblemFix[];
  /** Null for a code that is not worth retrying. */
  readonly retryAfterSeconds: number | null;

  constructor(code: ProblemCode, options: ApiErrorOptions = {}) {
    super(PROBLEM_TITLES[code]);
    this.code = code;
    this.status = PROBLEM_CODES[code];
    this.detail = options.detail;
    this.errors = Object.freeze([...(options.errors ?? [])]);
    this.fixes = Object.freeze([...(options.fixes ?? [])]);
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
    // Refined per rule by MANDATE_ERROR_MAP below.
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
    ACTIVATION_BUDGET_EXHAUSTED: 'INTERNAL',
    SPONSOR_UNFUNDED: 'INTERNAL',
    EXECUTOR_UNFUNDED: 'INTERNAL',
    DESTINATION_INVALID: 'DESTINATION_INVALID',
    QUOTE_EXPIRED: 'QUOTE_UNAVAILABLE',
    QUOTE_UNAVAILABLE: 'QUOTE_UNAVAILABLE',
    LIQUIDITY_UNAVAILABLE: 'QUOTE_UNAVAILABLE',
    // The price of the native asset is internal, and passes when a source returns.
    RATE_UNAVAILABLE: 'CHAIN_UNAVAILABLE',
    RAIL_UNAVAILABLE: 'CHAIN_UNAVAILABLE',
    RAIL_REJECTED: 'INTERNAL',
    RAIL_TIMEOUT: 'CHAIN_UNAVAILABLE',
    RAIL_ACTION_REQUIRED: 'INTERNAL',
    CROSS_CHAIN_LIVE: 'INTERNAL',
    REORGED: 'INTERNAL',
    INTERNAL: 'INTERNAL',
  });

/**
 * What each mandate refusal means to an API client, by its spec name. A
 * record over the generated spec table, so a rule added to the vendored
 * spec does not compile until someone decides how the API answers it.
 *
 * - Limits, state and recipient rules the principal set are MANDATE_REFUSED.
 * - Malformed amounts, legs, batches and configuration are the request's.
 * - What only our own services can cause (a missing role, a reused payout
 *   id, a bad attestation from our attester, a failed transfer, a broken
 *   invariant) is INTERNAL.
 */
export const MANDATE_ERROR_MAP: Readonly<Record<MandateErrorName, ProblemCode>> = Object.freeze({
  UNAUTHORIZED: 'INTERNAL',
  ROLE_CONFLICT: 'INVALID_REQUEST',
  ROLE_SET_FULL: 'INVALID_REQUEST',
  MANDATE_REVOKED: 'MANDATE_REFUSED',
  MANDATE_EXPIRED: 'MANDATE_REFUSED',
  MANDATE_PAUSED: 'MANDATE_REFUSED',
  ALREADY_PAUSED: 'MANDATE_REFUSED',
  NOT_PAUSED: 'MANDATE_REFUSED',
  MANDATE_ACTIVE: 'MANDATE_REFUSED',
  PRINCIPAL_CHANGE_PENDING: 'MANDATE_REFUSED',
  SWEEP_GRACE_PERIOD: 'MANDATE_REFUSED',
  AMOUNT_INVALID: 'INVALID_AMOUNT',
  LEGS_INVALID: 'INVALID_REQUEST',
  LEGS_SUM_MISMATCH: 'INVALID_REQUEST',
  BATCH_INVALID: 'INVALID_REQUEST',
  CONFIG_INVALID: 'INVALID_REQUEST',
  // The deadline is ours and the request reached the chain late; a retry
  // gets a fresh one.
  REQUEST_DEADLINE_PASSED: 'CHAIN_UNAVAILABLE',
  BUDGET_EXCEEDED: 'MANDATE_REFUSED',
  PAYMENT_CAP_EXCEEDED: 'MANDATE_REFUSED',
  DAILY_CAP_EXCEEDED: 'MANDATE_REFUSED',
  INSUFFICIENT_FUNDS: 'MANDATE_REFUSED',
  BUDGET_BELOW_RESERVED: 'MANDATE_REFUSED',
  NOTHING_TO_SWEEP: 'MANDATE_REFUSED',
  FEE_EXCEEDS_CAP: 'MANDATE_REFUSED',
  RECIPIENT_NOT_ALLOWED: 'MANDATE_REFUSED',
  ATTESTATION_INVALID: 'INTERNAL',
  ATTESTATION_EXPIRED: 'MANDATE_REFUSED',
  POLICY_CHANGED: 'MANDATE_REFUSED',
  WRONG_RECIPIENT_MODE: 'MANDATE_REFUSED',
  PAYOUT_ID_EXISTS: 'INTERNAL',
  PAYOUT_NOT_FOUND: 'NOT_FOUND',
  PAYOUT_WRONG_STATUS: 'MANDATE_REFUSED',
  PAYOUT_LAPSED: 'MANDATE_REFUSED',
  ALREADY_APPROVED: 'MANDATE_REFUSED',
  AGENT_REMOVED: 'MANDATE_REFUSED',
  ASSET_NOT_SUPPORTED: 'INVALID_REQUEST',
  WRONG_ASSET: 'INVALID_REQUEST',
  TRANSFER_FAILED: 'INTERNAL',
  INTERNAL_INVARIANT: 'INTERNAL',
});

/**
 * What each mandate policy refusal means to an API client. A record over every
 * code, so one added to the rules does not compile until someone decides.
 *
 * - The guardian rule and the custody rule are the client's to change.
 * - No operations guardian being set up is our gap, not the client's mistake:
 *   its request was valid. So it is a 503 that says to come back, and it is logged
 *   as a failure of ours, though a principal can also opt out to go ahead now.
 * - A policy store outage is treated as what caused it.
 */
export const MANDATE_POLICY_ERROR_MAP: Readonly<
  Record<Exclude<MandatePolicyErrorCode, 'POLICY_STORE_FAILED'>, ProblemCode>
> = Object.freeze({
  CUSTODY_GUARD: 'CUSTODY_GUARD',
  PRINCIPAL_KEY_RISK: 'PRINCIPAL_KEY_RISK',
  OPERATIONS_GUARDIAN_NOT_CONFIGURED: 'OPERATIONS_GUARDIAN_NOT_CONFIGURED',
  POLICY_STORE_TIMEOUT: 'DB_UNAVAILABLE',
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

const DESTINATION_REFUSED_DETAIL =
  'This destination cannot receive payouts. Check the address and memo, or choose another payout method.';

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
  // A destination the adapter refused is the client's to fix with another
  // destination or method, so it is a 422 that says so, not a bare 400.
  if (error instanceof InvalidInputError && error.reason !== null) {
    return new ApiError('DESTINATION_INVALID', {
      detail:
        error instanceof UnsupportedMemoDestinationError
          ? UNSUPPORTED_MEMO_DESTINATION_MESSAGE
          : DESTINATION_REFUSED_DETAIL,
      errors: [{ field: 'destination', code: 'invalid_value' }],
    });
  }
  if (error instanceof ChainAdapterError) {
    const retryAfterSeconds = secondsFrom(error.retryAfterMs);
    const code =
      error instanceof MandateRuleError
        ? MANDATE_ERROR_MAP[error.specName]
        : ADAPTER_ERROR_MAP[error.code];
    return new ApiError(code, retryAfterSeconds === undefined ? {} : { retryAfterSeconds });
  }
  for (const [type, code] of DATABASE_ERRORS) {
    if (error instanceof type) return new ApiError(code);
  }
  if (error instanceof PolicyStoreError) return toApiError(error.cause);
  if (error instanceof PrincipalKeyRiskError) {
    return new ApiError('PRINCIPAL_KEY_RISK', { fixes: error.fixes });
  }
  if (error instanceof MandatePolicyError) {
    return new ApiError(
      MANDATE_POLICY_ERROR_MAP[error.code as keyof typeof MANDATE_POLICY_ERROR_MAP],
    );
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
