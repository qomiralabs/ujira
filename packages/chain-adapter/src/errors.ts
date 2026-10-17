// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { isNetworkId } from './networks.js';
import type { NetworkId } from './networks.js';

export const CHAIN_ADAPTER_ERROR_CODES = Object.freeze([
  'INVALID_INPUT',
  'UNSUPPORTED',
  'TENANT_MISMATCH',
  'MANDATE_UNTRUSTED',
  'MANDATE_RULE',
  'CHAIN_UNAVAILABLE',
  'RPC_TIMEOUT',
  'RPC_LAGGING',
  'RPC_RATE_LIMITED',
  'SUBMISSION_REJECTED',
  'SUBMISSION_UNKNOWN',
  'SIGNED_PAYLOAD_MISMATCH',
  'SIGNING_REQUEST_EXPIRED',
  'SPONSOR_DENIED',
  'SPONSOR_UNFUNDED',
  'EXECUTOR_UNFUNDED',
  'DESTINATION_INVALID',
  'QUOTE_EXPIRED',
  'QUOTE_UNAVAILABLE',
  'LIQUIDITY_UNAVAILABLE',
  'RAIL_UNAVAILABLE',
  'RAIL_REJECTED',
  'RAIL_TIMEOUT',
  'RAIL_ACTION_REQUIRED',
  'CROSS_CHAIN_LIVE',
  'REORGED',
  'INTERNAL',
] as const);

export type ChainAdapterErrorCode = (typeof CHAIN_ADAPTER_ERROR_CODES)[number];

/** Whether anything reached the chain. 'unknown' means reconcile before any retry. */
export type Landed = 'no' | 'yes' | 'unknown';

/** The event a parked job waits for before it runs again. */
export type WaitFor = 'none' | 'funding' | 'utc_day' | 'resume' | 'approval' | 'chain' | null;

export interface ChainAdapterErrorOptions {
  readonly network?: NetworkId | null;
  readonly retryable?: boolean;
  readonly landed?: Landed;
  readonly retryAfterMs?: number | null;
  readonly waitFor?: WaitFor;
  readonly cause?: unknown;
}

/** Serializable form stored on jobs and returned in batch items. */
export interface ChainAdapterErrorJson {
  readonly code: ChainAdapterErrorCode;
  readonly network: NetworkId | null;
  readonly retryable: boolean;
  readonly landed: Landed;
  readonly retryAfterMs: number | null;
  readonly waitFor: WaitFor;
  readonly specCode?: number;
  readonly specName?: string;
}

interface Defaults {
  readonly retryable: boolean;
  readonly landed: Landed;
  readonly message: string;
}

// Transport and rail outages are worth another try. A submission that may
// have landed is retryable too, but only after the step function reconciles
// by hash, which is why it is the one code that defaults to landed unknown.
// Messages are fixed text: callers branch on the code, and a message built
// from input could carry an address or a provider response into a log.
const DEFAULTS: Readonly<Record<ChainAdapterErrorCode, Defaults>> = {
  INVALID_INPUT: { retryable: false, landed: 'no', message: 'Invalid input' },
  UNSUPPORTED: { retryable: false, landed: 'no', message: 'Not supported on this network' },
  TENANT_MISMATCH: { retryable: false, landed: 'no', message: 'Mandate belongs to another tenant' },
  MANDATE_UNTRUSTED: {
    retryable: false,
    landed: 'no',
    message: 'Mandate was not created by a trusted factory',
  },
  MANDATE_RULE: { retryable: false, landed: 'no', message: 'Mandate rule refused the call' },
  CHAIN_UNAVAILABLE: { retryable: true, landed: 'no', message: 'Chain unavailable' },
  RPC_TIMEOUT: { retryable: true, landed: 'no', message: 'RPC call timed out' },
  RPC_LAGGING: { retryable: true, landed: 'no', message: 'RPC endpoint is behind' },
  RPC_RATE_LIMITED: {
    retryable: true,
    landed: 'no',
    message: 'RPC endpoint rate limited the call',
  },
  SUBMISSION_REJECTED: { retryable: false, landed: 'no', message: 'Submission rejected' },
  SUBMISSION_UNKNOWN: { retryable: true, landed: 'unknown', message: 'Submission outcome unknown' },
  SIGNED_PAYLOAD_MISMATCH: {
    retryable: false,
    landed: 'no',
    message: 'Signed payload differs from the request',
  },
  SIGNING_REQUEST_EXPIRED: { retryable: false, landed: 'no', message: 'Signing request expired' },
  SPONSOR_DENIED: { retryable: false, landed: 'no', message: 'Fee sponsorship denied' },
  SPONSOR_UNFUNDED: { retryable: false, landed: 'no', message: 'Fee sponsor is underfunded' },
  EXECUTOR_UNFUNDED: { retryable: false, landed: 'no', message: 'Executor is underfunded' },
  DESTINATION_INVALID: {
    retryable: false,
    landed: 'no',
    message: 'Destination cannot receive this payout',
  },
  QUOTE_EXPIRED: { retryable: true, landed: 'no', message: 'Quote expired' },
  QUOTE_UNAVAILABLE: { retryable: false, landed: 'no', message: 'Quote unavailable' },
  LIQUIDITY_UNAVAILABLE: { retryable: false, landed: 'no', message: 'Liquidity unavailable' },
  RAIL_UNAVAILABLE: { retryable: true, landed: 'no', message: 'Delivery rail unavailable' },
  RAIL_REJECTED: { retryable: false, landed: 'no', message: 'Delivery rail rejected the transfer' },
  RAIL_TIMEOUT: { retryable: true, landed: 'no', message: 'Delivery rail timed out' },
  RAIL_ACTION_REQUIRED: { retryable: false, landed: 'no', message: 'Delivery rail needs action' },
  CROSS_CHAIN_LIVE: {
    retryable: false,
    landed: 'no',
    message: 'Attempt is live on another network',
  },
  REORGED: { retryable: false, landed: 'no', message: 'Transaction was reorganized away' },
  INTERNAL: { retryable: false, landed: 'no', message: 'Internal chain adapter error' },
};

const LANDED: ReadonlySet<unknown> = new Set<unknown>(['no', 'yes', 'unknown']);
const WAIT_FOR: ReadonlySet<unknown> = new Set<unknown>([
  'none',
  'funding',
  'utc_day',
  'resume',
  'approval',
  'chain',
  null,
]);

function checkOptions(options: ChainAdapterErrorOptions): string | undefined {
  const { network, landed, retryAfterMs, waitFor, retryable } = options;
  if (network !== undefined && network !== null && !isNetworkId(network)) return 'network';
  if (landed !== undefined && !LANDED.has(landed)) return 'landed';
  if (waitFor !== undefined && !WAIT_FOR.has(waitFor)) return 'waitFor';
  if (retryable !== undefined && typeof retryable !== 'boolean') return 'retryable';
  if (
    retryAfterMs !== undefined &&
    retryAfterMs !== null &&
    !(Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0)
  ) {
    return 'retryAfterMs';
  }
  return undefined;
}

/** Base of every adapter failure. Branch on `code`, never on the message. */
export abstract class ChainAdapterError extends Error {
  readonly code: ChainAdapterErrorCode;
  readonly network: NetworkId | null;
  readonly retryable: boolean;
  readonly landed: Landed;
  readonly retryAfterMs: number | null;
  readonly waitFor: WaitFor;

  protected constructor(
    code: ChainAdapterErrorCode,
    message: string | undefined,
    options: ChainAdapterErrorOptions,
  ) {
    const defaults = DEFAULTS[code];
    super(
      message ?? defaults.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    // An error that cannot be stored on a job would be lost exactly when it
    // matters, so bad options fail where they are written.
    const bad = checkOptions(options);
    if (bad !== undefined) {
      throw new InvalidInputError(`Invalid chain adapter error option: ${bad}`);
    }
    this.code = code;
    this.network = options.network ?? null;
    this.retryable = options.retryable ?? defaults.retryable;
    this.landed = options.landed ?? defaults.landed;
    this.retryAfterMs = options.retryAfterMs ?? null;
    // null is a real value here, distinct from leaving the option out.
    this.waitFor = options.waitFor === undefined ? 'none' : options.waitFor;
  }

  /** The job form. The message stays out, since it may name an address. */
  toJSON(): ChainAdapterErrorJson {
    return {
      code: this.code,
      network: this.network,
      retryable: this.retryable,
      landed: this.landed,
      retryAfterMs: this.retryAfterMs,
      waitFor: this.waitFor,
    };
  }
}

export function isChainAdapterError(value: unknown): value is ChainAdapterError {
  return value instanceof ChainAdapterError;
}

// Each class spells its name, because minifiers rename classes and the name
// is what shows up in logs and error trackers.

export class InvalidInputError extends ChainAdapterError {
  override readonly name = 'InvalidInputError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('INVALID_INPUT', message, options);
  }
}

export class UnsupportedError extends ChainAdapterError {
  override readonly name = 'UnsupportedError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('UNSUPPORTED', message, options);
  }
}

export class TenantMismatchError extends ChainAdapterError {
  override readonly name = 'TenantMismatchError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('TENANT_MISMATCH', message, options);
  }
}

export class MandateUntrustedError extends ChainAdapterError {
  override readonly name = 'MandateUntrustedError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('MANDATE_UNTRUSTED', message, options);
  }
}

export class ChainUnavailableError extends ChainAdapterError {
  override readonly name = 'ChainUnavailableError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('CHAIN_UNAVAILABLE', message, options);
  }
}

export class RpcTimeoutError extends ChainAdapterError {
  override readonly name = 'RpcTimeoutError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('RPC_TIMEOUT', message, options);
  }
}

export class RpcLaggingError extends ChainAdapterError {
  override readonly name = 'RpcLaggingError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('RPC_LAGGING', message, options);
  }
}

export class RpcRateLimitedError extends ChainAdapterError {
  override readonly name = 'RpcRateLimitedError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('RPC_RATE_LIMITED', message, options);
  }
}

/** Definitely not landed: bad sequence, fee too low, malformed, failed simulation. */
export class SubmissionRejectedError extends ChainAdapterError {
  override readonly name = 'SubmissionRejectedError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('SUBMISSION_REJECTED', message, options);
  }
}

/** May have landed. Reconcile by hash and mandate state before any retry. */
export class SubmissionUnknownError extends ChainAdapterError {
  override readonly name = 'SubmissionUnknownError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('SUBMISSION_UNKNOWN', message, options);
  }
}

export class SignedPayloadMismatchError extends ChainAdapterError {
  override readonly name = 'SignedPayloadMismatchError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('SIGNED_PAYLOAD_MISMATCH', message, options);
  }
}

export class SigningRequestExpiredError extends ChainAdapterError {
  override readonly name = 'SigningRequestExpiredError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('SIGNING_REQUEST_EXPIRED', message, options);
  }
}

export class SponsorDeniedError extends ChainAdapterError {
  override readonly name = 'SponsorDeniedError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('SPONSOR_DENIED', message, options);
  }
}

export class SponsorUnfundedError extends ChainAdapterError {
  override readonly name = 'SponsorUnfundedError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('SPONSOR_UNFUNDED', message, options);
  }
}

export class ExecutorUnfundedError extends ChainAdapterError {
  override readonly name = 'ExecutorUnfundedError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('EXECUTOR_UNFUNDED', message, options);
  }
}

/** Bad address, missing trustline, or a tag the destination needs but the network cannot carry. */
export class DestinationInvalidError extends ChainAdapterError {
  override readonly name = 'DestinationInvalidError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('DESTINATION_INVALID', message, options);
  }
}

export class QuoteExpiredError extends ChainAdapterError {
  override readonly name = 'QuoteExpiredError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('QUOTE_EXPIRED', message, options);
  }
}

export class QuoteUnavailableError extends ChainAdapterError {
  override readonly name = 'QuoteUnavailableError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('QUOTE_UNAVAILABLE', message, options);
  }
}

export class LiquidityUnavailableError extends ChainAdapterError {
  override readonly name = 'LiquidityUnavailableError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('LIQUIDITY_UNAVAILABLE', message, options);
  }
}

export class RailUnavailableError extends ChainAdapterError {
  override readonly name = 'RailUnavailableError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('RAIL_UNAVAILABLE', message, options);
  }
}

export class RailRejectedError extends ChainAdapterError {
  override readonly name = 'RailRejectedError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('RAIL_REJECTED', message, options);
  }
}

export class RailTimeoutError extends ChainAdapterError {
  override readonly name = 'RailTimeoutError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('RAIL_TIMEOUT', message, options);
  }
}

export class RailActionRequiredError extends ChainAdapterError {
  override readonly name = 'RailActionRequiredError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('RAIL_ACTION_REQUIRED', message, options);
  }
}

/** Failover refused: the attempt on the other network is not provably dead. */
export class CrossChainLiveError extends ChainAdapterError {
  override readonly name = 'CrossChainLiveError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('CROSS_CHAIN_LIVE', message, options);
  }
}

export class ReorgedError extends ChainAdapterError {
  override readonly name = 'ReorgedError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('REORGED', message, options);
  }
}

export class InternalError extends ChainAdapterError {
  override readonly name = 'InternalError';
  constructor(message?: string, options: ChainAdapterErrorOptions = {}) {
    super('INTERNAL', message, options);
  }
}

// The mandate errors a job can wait out. Any other spec error is final;
// TRANSFER_FAILED goes down the leg fallback path instead of a retry.
const MANDATE_RULE_WAITS: ReadonlyMap<string, WaitFor> = new Map([
  ['INSUFFICIENT_FUNDS', 'funding'],
  ['DAILY_CAP_EXCEEDED', 'utc_day'],
  ['MANDATE_PAUSED', 'resume'],
]);

const SPEC_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** A mandate contract refusal, carrying the code and name from the spec error table. */
export class MandateRuleError extends ChainAdapterError {
  override readonly name = 'MandateRuleError';
  readonly specCode: number;
  readonly specName: string;

  constructor(specCode: number, specName: string, options: ChainAdapterErrorOptions = {}) {
    const valid =
      Number.isSafeInteger(specCode) &&
      specCode >= 0 &&
      typeof specName === 'string' &&
      specName.length <= 64 &&
      SPEC_NAME.test(specName);
    const waitFor = valid ? MANDATE_RULE_WAITS.get(specName) : undefined;
    super('MANDATE_RULE', undefined, {
      retryable: waitFor !== undefined,
      waitFor: waitFor ?? 'none',
      ...options,
    });
    if (!valid) throw new InvalidInputError('Invalid mandate spec error');
    this.specCode = specCode;
    this.specName = specName;
  }

  override toJSON(): ChainAdapterErrorJson {
    return { ...super.toJSON(), specCode: this.specCode, specName: this.specName };
  }
}
