// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { MANDATE_ERRORS, isMandateErrorName, mandateErrorName } from './mandate-errors.js';
import type { MandateErrorName } from './mandate-errors.js';
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
  'SIGNER_UNAVAILABLE',
  'SIGNER_DENIED',
  'SIGNER_ADDRESS_MISMATCH',
  'SPONSOR_DENIED',
  'SPONSOR_UNFUNDED',
  'ACTIVATION_BUDGET_EXHAUSTED',
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

/**
 * Why a destination was refused. The set is the same on every chain, and a
 * chain need not produce every reason: Stellar addresses name no network,
 * so Stellar never gives WRONG_NETWORK.
 */
export const DESTINATION_PARSE_REASONS = Object.freeze([
  'MALFORMED',
  'CHECKSUM',
  'ZERO_ADDRESS',
  'MEMO_NOT_ID',
  'TAG_NOT_SUPPORTED',
  'TAG_OUT_OF_RANGE',
  'WRONG_NETWORK',
] as const);

export type DestinationParseReason = (typeof DESTINATION_PARSE_REASONS)[number];

const PARSE_REASONS: ReadonlySet<unknown> = new Set<unknown>(DESTINATION_PARSE_REASONS);

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
  readonly specName?: MandateErrorName;
  readonly issues?: readonly string[];
  readonly reason?: DestinationParseReason;
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
  // A signer failure always comes before broadcast, so nothing has landed.
  // An outage is worth waiting out; a refusal or a key that controls the
  // wrong account is a security event and never retried.
  SIGNER_UNAVAILABLE: { retryable: true, landed: 'no', message: 'Signer unavailable' },
  SIGNER_DENIED: { retryable: false, landed: 'no', message: 'Signer refused the payload' },
  SIGNER_ADDRESS_MISMATCH: {
    retryable: false,
    landed: 'no',
    message: 'Signer key does not control the pinned address',
  },
  SPONSOR_DENIED: { retryable: false, landed: 'no', message: 'Fee sponsorship denied' },
  SPONSOR_UNFUNDED: { retryable: false, landed: 'no', message: 'Fee sponsor is underfunded' },
  ACTIVATION_BUDGET_EXHAUSTED: {
    retryable: false,
    landed: 'no',
    message: 'Monthly activation budget is spent',
  },
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

// The class names below, kept in step by a test.
const ADAPTER_ERROR_NAMES = [
  'InvalidInputError',
  'MemoOnContractCallError',
  'UnsupportedError',
  'TenantMismatchError',
  'MandateUntrustedError',
  'MandateRuleError',
  'ChainUnavailableError',
  'RpcTimeoutError',
  'RpcLaggingError',
  'RpcRateLimitedError',
  'SubmissionRejectedError',
  'SubmissionUnknownError',
  'SignedPayloadMismatchError',
  'SigningRequestExpiredError',
  'SignerUnavailableError',
  'SignerDeniedError',
  'SignerAddressMismatchError',
  'SponsorDeniedError',
  'SponsorUnfundedError',
  'ActivationBudgetExhaustedError',
  'ExecutorUnfundedError',
  'DestinationInvalidError',
  'UnsupportedMemoDestinationError',
  'QuoteExpiredError',
  'QuoteUnavailableError',
  'LiquidityUnavailableError',
  'RailUnavailableError',
  'RailRejectedError',
  'RailTimeoutError',
  'RailActionRequiredError',
  'CrossChainLiveError',
  'ReorgedError',
  'InternalError',
];

// Class names worth keeping: the runtime's own and this module's. Any
// other name is caller text and could itself be a secret.
const KNOWN_CAUSE_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'FetchError',
  ...ADAPTER_ERROR_NAMES,
]);

// The name is read once: it may be a getter, and a getter must not get a
// second chance to answer differently or to run again.
function causeName(cause: unknown): string {
  let name: unknown;
  try {
    // instanceof runs getPrototypeOf, which a Proxy can make throw, so it
    // sits inside the try with the name read.
    if (!(cause instanceof Error)) return 'Error';
    name = cause.name;
  } catch {
    return 'Error';
  }
  return typeof name === 'string' && KNOWN_CAUSE_NAMES.has(name) ? name : 'Error';
}

function redact(cause: unknown): Error {
  const kind = causeName(cause);
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

// "path (code)": the path is field names, indexes, network IDs and, where an
// operator needs it to fix a config, a host name; the code a lower snake
// case reason. Neither has room for a value.
const ISSUE = /^[A-Za-z0-9_.:-]{1,96} \([a-z_]{1,48}\)$/;
const MAX_ISSUES = 10;

export interface InvalidInputErrorOptions extends ChainAdapterErrorOptions {
  /** What was wrong and where, as "path (code)". Never the value itself. */
  readonly issues?: readonly string[];
  /** Set when a destination was refused, so a caller can say why without reading the issues. */
  readonly reason?: DestinationParseReason;
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

// The options only InvalidInputError takes; the base class reads the rest.
const INVALID_INPUT_OPTIONS: ReadonlySet<string> = new Set(['issues', 'reason']);

function withoutOwnOptions(read: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(read).filter(([key]) => !INVALID_INPUT_OPTIONS.has(key)),
  );
}

// Each class spells its name, because minifiers rename classes and the name
// is what shows up in logs and error trackers.

export class InvalidInputError extends ChainAdapterError {
  // Widened to string so a narrower kind of invalid input can name itself.
  override readonly name: string = 'InvalidInputError';
  readonly issues: readonly string[];
  /** Why a destination was refused, or null for any other invalid input. */
  readonly reason: DestinationParseReason | null;

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
    const reason = read?.['reason'];
    if (reason !== undefined && !PARSE_REASONS.has(reason)) {
      throw new InvalidInputError({ issues: ['errorOptions.reason (invalid)'] });
    }
    super('INVALID_INPUT', read === undefined ? options : withoutOwnOptions(read));
    this.issues = issues;
    this.reason = (reason as DestinationParseReason | undefined) ?? null;
  }

  override toJSON(): ChainAdapterErrorJson {
    const json = { ...super.toJSON(), issues: this.issues };
    return this.reason === null ? json : { ...json, reason: this.reason };
  }
}

/**
 * A Stellar transaction that runs contract code carries a memo. The network
 * refuses every such transaction, so it is stopped before it is signed or
 * sent instead of surfacing later as a failed payout. It is invalid input
 * by code, so callers that branch on the code need no new case.
 */
export class MemoOnContractCallError extends InvalidInputError {
  override readonly name: string = 'MemoOnContractCallError';

  constructor(options?: { readonly network?: NetworkId | null }) {
    super({ network: options?.network ?? null, issues: ['memo (contract_call)'] });
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

/** The signer could not be reached or did not answer in time. Retried with backoff. */
export class SignerUnavailableError extends ChainAdapterError {
  override readonly name = 'SignerUnavailableError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('SIGNER_UNAVAILABLE', options);
  }
}

/** The signer's policy or the key manager refused. Never retried. */
export class SignerDeniedError extends ChainAdapterError {
  override readonly name = 'SignerDeniedError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('SIGNER_DENIED', options);
  }
}

/** A key controls an account other than its pinned one. Stops the service at startup. */
export class SignerAddressMismatchError extends ChainAdapterError {
  override readonly name = 'SignerAddressMismatchError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('SIGNER_ADDRESS_MISMATCH', options);
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

/** The principal's activations and funding accounts reached the month's budget. */
export class ActivationBudgetExhaustedError extends ChainAdapterError {
  override readonly name = 'ActivationBudgetExhaustedError';
  constructor(options?: ChainAdapterErrorOptions) {
    super('ACTIVATION_BUDGET_EXHAUSTED', options);
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

/**
 * Shown to a recipient whose destination needs a text or hash memo. Plain
 * fixed text, so a widget or an API can show it as it is.
 */
export const UNSUPPORTED_MEMO_DESTINATION_MESSAGE =
  'This destination needs a text or hash memo, which a payout from a mandate cannot carry. Choose another payout method, or an address that needs no memo or only a numeric one.';

/**
 * A destination that needs a text or hash memo. A contract cannot attach a
 * transaction memo and a muxed tag holds only a 64 bit number, so it could
 * never be paid; it is refused when the destination is captured, not found
 * at payout time. It is invalid input with reason MEMO_NOT_ID, so callers
 * that branch on the code or the reason need no new case.
 */
export class UnsupportedMemoDestinationError extends InvalidInputError {
  override readonly name: string = 'UnsupportedMemoDestinationError';

  constructor(options: { readonly network: NetworkId | null; readonly path: string }) {
    super({
      network: options.network,
      reason: 'MEMO_NOT_ID',
      issues: [`${options.path} (memo_not_id)`],
    });
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
const MANDATE_RULE_WAITS: Readonly<Partial<Record<MandateErrorName, WaitFor>>> = Object.freeze({
  INSUFFICIENT_FUNDS: 'funding',
  DAILY_CAP_EXCEEDED: 'utc_day',
  MANDATE_PAUSED: 'resume',
});

/**
 * A mandate contract refusal, carrying the contract's own error code and
 * name. Both must be a pair from the vendored spec table: a code the table
 * does not hold is not a rule we know, and is reported as InternalError by
 * whoever decodes it (see mandateRuleErrorOf).
 */
export class MandateRuleError extends ChainAdapterError {
  override readonly name = 'MandateRuleError';
  readonly specCode: number;
  readonly specName: MandateErrorName;

  constructor(specCode: number, specName: MandateErrorName, options?: ChainAdapterErrorOptions) {
    const valid = isMandateErrorName(specName) && MANDATE_ERRORS[specName] === specCode;
    const waitFor = valid ? MANDATE_RULE_WAITS[specName] : undefined;
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

/**
 * The error for a code the mandate contract returned: the named rule when
 * the vendored table holds the code, and InternalError when it does not,
 * since a code we cannot name is a contract we do not understand.
 */
export function mandateRuleErrorOf(
  specCode: number,
  options?: ChainAdapterErrorOptions,
): MandateRuleError | InternalError {
  const name = mandateErrorName(specCode);
  return name === undefined
    ? new InternalError(options)
    : new MandateRuleError(specCode, name, options);
}
