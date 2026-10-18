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
  /** Recorded by kind only; see RedactedCause. */
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
  readonly issues?: readonly string[];
}

interface Defaults {
  readonly retryable: boolean;
  readonly landed: Landed;
  readonly message: string;
}

// Transport and rail outages are worth another try. A submission that may
// have landed is retryable too, but only after the step function reconciles
// by hash. An RPC timeout defaults to landed unknown for the same reason: if
// the call was a send it may have gone through, and assuming it did not is
// how a payout goes out twice.
// Messages are fixed text per code: callers branch on the code, and a
// message built from input could carry an address, a tenant or a provider
// response into a log or an error tracker, so no constructor takes one.
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
  RPC_TIMEOUT: { retryable: true, landed: 'unknown', message: 'RPC call timed out' },
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

/** The fixed message for each code. */
export const CHAIN_ADAPTER_ERROR_MESSAGES: Readonly<Record<ChainAdapterErrorCode, string>> =
  Object.freeze(
    Object.fromEntries(
      CHAIN_ADAPTER_ERROR_CODES.map((code) => [code, DEFAULTS[code].message]),
    ) as Record<ChainAdapterErrorCode, string>,
  );

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

// Options are plain data read from own data properties, so a getter or a
// prototype cannot answer differently from what was checked.
function readOptions(options: unknown): Record<string, unknown> | undefined {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return undefined;
  }
  const proto: unknown = Object.getPrototypeOf(options);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    copy[key] = descriptor.value;
  }
  return copy;
}

function badOption(options: Record<string, unknown>): string | undefined {
  const { network, landed, retryAfterMs, waitFor, retryable } = options;
  if (network !== undefined && network !== null && !isNetworkId(network)) return 'network';
  if (landed !== undefined && !LANDED.has(landed)) return 'landed';
  if (waitFor !== undefined && !WAIT_FOR.has(waitFor)) return 'waitFor';
  if (retryable !== undefined && typeof retryable !== 'boolean') return 'retryable';
  if (
    retryAfterMs !== undefined &&
    retryAfterMs !== null &&
    !(typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0)
  ) {
    return 'retryAfterMs';
  }
  return undefined;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * What an error keeps of its cause: only the cause's class name, under a
 * fixed message, with no stack of its own text, no fields and no chain.
 * Transport and config errors routinely quote URLs that carry API keys,
 * and loggers, console and error trackers all print `cause`, so the
 * original is never attached.
 */
class RedactedCause extends Error {
  override readonly name = 'RedactedCause';
}

function redact(cause: unknown): Error {
  const kind = cause instanceof Error && IDENTIFIER.test(cause.name) ? cause.name : 'Error';
  const redacted = new RedactedCause(`Cause redacted: ${kind}`);
  // The stack would only point at this file, and dropping it keeps the
  // printed form to the fixed message.
  redacted.stack = `RedactedCause: Cause redacted: ${kind}`;
  return redacted;
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
    rawOptions: unknown,
    fallback: { readonly retryable?: boolean; readonly waitFor?: WaitFor } = {},
  ) {
    const defaults = DEFAULTS[code];
    // An error that cannot be stored on a job would be lost exactly when it
    // matters, so bad options fail where they are written.
    const options = readOptions(rawOptions);
    const bad = options === undefined ? 'options' : badOption(options);
    if (bad !== undefined) {
      throw new InvalidInputError({ issues: [`errorOptions.${bad} (invalid)`] });
    }
    const read = options as ChainAdapterErrorOptions;
    super(defaults.message, read.cause === undefined ? undefined : { cause: redact(read.cause) });
    this.code = code;
    this.network = read.network ?? null;
    this.retryable = read.retryable ?? fallback.retryable ?? defaults.retryable;
    this.landed = read.landed ?? defaults.landed;
    this.retryAfterMs = read.retryAfterMs ?? null;
    // null is a real value here, distinct from leaving the option out.
    this.waitFor = read.waitFor !== undefined ? read.waitFor : (fallback.waitFor ?? 'none');
  }

  /** The job form. */
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

// "path (code)": the path is field names, indexes and network IDs, and the
// code a lower snake case reason. Neither has room for a value.
const ISSUE = /^[A-Za-z0-9_.:]{1,96} \([a-z_]{1,48}\)$/;
const MAX_ISSUES = 10;

export interface InvalidInputErrorOptions extends ChainAdapterErrorOptions {
  /** What was wrong and where, as "path (code)". Never the value itself. */
  readonly issues?: readonly string[];
}

function readIssues(read: Record<string, unknown>): readonly string[] | undefined {
  const list = read['issues'] ?? [];
  if (
    !Array.isArray(list) ||
    list.length > MAX_ISSUES ||
    !list.every((issue): issue is string => typeof issue === 'string' && ISSUE.test(issue))
  ) {
    return undefined;
  }
  return Object.freeze([...list]);
}

function withoutIssues(read: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(read).filter(([key]) => key !== 'issues'));
}

// Each class spells its name, because minifiers rename classes and the name
// is what shows up in logs and error trackers.

export class InvalidInputError extends ChainAdapterError {
  override readonly name = 'InvalidInputError';
  readonly issues: readonly string[];

  constructor(options?: InvalidInputErrorOptions) {
    // Options that are not plain data go to the base constructor as they
    // are, so it refuses them the same way as for every other class.
    const read = readOptions(options);
    const issues = read === undefined ? [] : readIssues(read);
    if (issues === undefined) {
      // A malformed list is a bug at the throw site; replacing it keeps
      // whatever it held out of the error.
      throw new InvalidInputError({ issues: ['errorOptions.issues (invalid)'] });
    }
    super('INVALID_INPUT', read === undefined ? options : withoutIssues(read));
    this.issues = issues;
  }

  override toJSON(): ChainAdapterErrorJson {
    return { ...super.toJSON(), issues: this.issues };
  }
}

export class UnsupportedError extends ChainAdapterError {
  override readonly name = 'UnsupportedError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('UNSUPPORTED', options);
  }
}

export class TenantMismatchError extends ChainAdapterError {
  override readonly name = 'TenantMismatchError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('TENANT_MISMATCH', options);
  }
}

export class MandateUntrustedError extends ChainAdapterError {
  override readonly name = 'MandateUntrustedError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('MANDATE_UNTRUSTED', options);
  }
}

export class ChainUnavailableError extends ChainAdapterError {
  override readonly name = 'ChainUnavailableError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('CHAIN_UNAVAILABLE', options);
  }
}

/**
 * An RPC call that did not answer in time. Defaults to landed unknown, since
 * a send may have gone through; a read that sent nothing passes landed
 * 'no'.
 */
export class RpcTimeoutError extends ChainAdapterError {
  override readonly name = 'RpcTimeoutError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('RPC_TIMEOUT', options);
  }
}

/** Every endpoint is behind the height a read needs. Nothing was sent. */
export class RpcLaggingError extends ChainAdapterError {
  override readonly name = 'RpcLaggingError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('RPC_LAGGING', options);
  }
}

/** The endpoint refused the call, so nothing was accepted. */
export class RpcRateLimitedError extends ChainAdapterError {
  override readonly name = 'RpcRateLimitedError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('RPC_RATE_LIMITED', options);
  }
}

/** Definitely not landed: bad sequence, fee too low, malformed, failed simulation. */
export class SubmissionRejectedError extends ChainAdapterError {
  override readonly name = 'SubmissionRejectedError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('SUBMISSION_REJECTED', options);
  }
}

/** May have landed. Reconcile by hash and mandate state before any retry. */
export class SubmissionUnknownError extends ChainAdapterError {
  override readonly name = 'SubmissionUnknownError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('SUBMISSION_UNKNOWN', options);
  }
}

export class SignedPayloadMismatchError extends ChainAdapterError {
  override readonly name = 'SignedPayloadMismatchError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('SIGNED_PAYLOAD_MISMATCH', options);
  }
}

export class SigningRequestExpiredError extends ChainAdapterError {
  override readonly name = 'SigningRequestExpiredError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('SIGNING_REQUEST_EXPIRED', options);
  }
}

export class SponsorDeniedError extends ChainAdapterError {
  override readonly name = 'SponsorDeniedError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('SPONSOR_DENIED', options);
  }
}

export class SponsorUnfundedError extends ChainAdapterError {
  override readonly name = 'SponsorUnfundedError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('SPONSOR_UNFUNDED', options);
  }
}

export class ExecutorUnfundedError extends ChainAdapterError {
  override readonly name = 'ExecutorUnfundedError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('EXECUTOR_UNFUNDED', options);
  }
}

/** Bad address, missing trustline, or a tag the destination needs but the network cannot carry. */
export class DestinationInvalidError extends ChainAdapterError {
  override readonly name = 'DestinationInvalidError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('DESTINATION_INVALID', options);
  }
}

export class QuoteExpiredError extends ChainAdapterError {
  override readonly name = 'QuoteExpiredError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('QUOTE_EXPIRED', options);
  }
}

export class QuoteUnavailableError extends ChainAdapterError {
  override readonly name = 'QuoteUnavailableError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('QUOTE_UNAVAILABLE', options);
  }
}

export class LiquidityUnavailableError extends ChainAdapterError {
  override readonly name = 'LiquidityUnavailableError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('LIQUIDITY_UNAVAILABLE', options);
  }
}

export class RailUnavailableError extends ChainAdapterError {
  override readonly name = 'RailUnavailableError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('RAIL_UNAVAILABLE', options);
  }
}

export class RailRejectedError extends ChainAdapterError {
  override readonly name = 'RailRejectedError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('RAIL_REJECTED', options);
  }
}

export class RailTimeoutError extends ChainAdapterError {
  override readonly name = 'RailTimeoutError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('RAIL_TIMEOUT', options);
  }
}

export class RailActionRequiredError extends ChainAdapterError {
  override readonly name = 'RailActionRequiredError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('RAIL_ACTION_REQUIRED', options);
  }
}

/** Failover refused: the attempt on the other network is not provably dead. */
export class CrossChainLiveError extends ChainAdapterError {
  override readonly name = 'CrossChainLiveError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('CROSS_CHAIN_LIVE', options);
  }
}

export class ReorgedError extends ChainAdapterError {
  override readonly name = 'ReorgedError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('REORGED', options);
  }
}

export class InternalError extends ChainAdapterError {
  override readonly name = 'InternalError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('INTERNAL', options);
  }
}

// The mandate errors a job can wait out. Any other mandate error is final;
// TRANSFER_FAILED goes down the leg fallback path instead of a retry.
const MANDATE_RULE_WAITS: ReadonlyMap<string, WaitFor> = new Map([
  ['INSUFFICIENT_FUNDS', 'funding'],
  ['DAILY_CAP_EXCEEDED', 'utc_day'],
  ['MANDATE_PAUSED', 'resume'],
]);

const SPEC_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** A mandate contract refusal, carrying the contract's own error code and name. */
export class MandateRuleError extends ChainAdapterError {
  override readonly name = 'MandateRuleError';
  readonly specCode: number;
  readonly specName: string;

  constructor(specCode: number, specName: string, options?: ChainAdapterErrorOptions) {
    const valid =
      Number.isSafeInteger(specCode) &&
      specCode >= 0 &&
      typeof specName === 'string' &&
      specName.length <= 64 &&
      SPEC_NAME.test(specName);
    const waitFor = valid ? MANDATE_RULE_WAITS.get(specName) : undefined;
    super('MANDATE_RULE', options, {
      retryable: waitFor !== undefined,
      waitFor: waitFor ?? 'none',
    });
    if (!valid) throw new InvalidInputError({ issues: ['mandateRule (invalid)'] });
    this.specCode = specCode;
    this.specName = specName;
  }

  override toJSON(): ChainAdapterErrorJson {
    return { ...super.toJSON(), specCode: this.specCode, specName: this.specName };
  }
}
