// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the chain adapter errors (errors.ts, exported from the
 * package root).
 *
 * Every adapter failure is a subclass of ChainAdapterError, one concrete
 * class per code. Callers branch on `code`, never on the message.
 *   code          stable string, one of CHAIN_ADAPTER_ERROR_CODES
 *   name          the class name, spelled out so minified builds keep it
 *   message       fixed text per code, CHAIN_ADAPTER_ERROR_MESSAGES[code].
 *                 No constructor takes a message, so no address, tenant or
 *                 provider text can reach a log or an error tracker
 *   network       the network involved, or null
 *   retryable     whether the job layer may try again
 *   landed        'no' | 'yes' | 'unknown': did anything reach the chain
 *   retryAfterMs  a hint in whole milliseconds, or null
 *   waitFor       'none' | 'funding' | 'utc_day' | 'resume' | 'approval' |
 *                 'chain' | null: the event a parked job waits for
 * Constructors take one optional plain object of options (network,
 * retryable, landed, retryAfterMs, waitFor, cause). Anything else, null and
 * strings included, and any option that could not be stored on a job,
 * throws InvalidInputError.
 *
 * Defaults: transport, rail and signer outages, and an expired quote, are
 * retryable; everything else is final with landed 'no'. Two codes
 * default to landed 'unknown': SUBMISSION_UNKNOWN, and RPC_TIMEOUT, because
 * a timeout on a send may have landed. A read that sent nothing passes
 * landed 'no'. RPC_LAGGING and RPC_RATE_LIMITED mean nothing was accepted.
 *
 * InvalidInputError also takes `issues`: at most ten strings of the form
 * "path (code)", where path is letters, digits, '_', '.' and ':' and code
 * is lower snake case. They say what was wrong without saying what it was.
 * A refused destination also sets `reason`, one of
 * DESTINATION_PARSE_REASONS, which toJSON carries; it is null otherwise and
 * any other value throws InvalidInputError.
 *
 * MandateRuleError(specCode, specName, options?) carries the mandate contract's
 * error. INSUFFICIENT_FUNDS waits for funding, DAILY_CAP_EXCEEDED for the
 * next UTC day and MANDATE_PAUSED for a resume, all retryable; every other
 * mandate error is final. specCode must be a non negative safe integer and
 * specName a non empty upper snake case name, else InvalidInputError.
 *
 * The signer errors (SIGNER_UNAVAILABLE, SIGNER_DENIED and
 * SIGNER_ADDRESS_MISMATCH) are in the same set; how a job retries them is
 * pinned in retry.test.ts.
 *
 * toJSON() returns the serializable ChainAdapterErrorJson stored on jobs.
 */

import { format, inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import * as index from './index.js';
import {
  ActivationBudgetExhaustedError,
  CHAIN_ADAPTER_ERROR_CODES,
  CHAIN_ADAPTER_ERROR_MESSAGES,
  DESTINATION_PARSE_REASONS,
  ChainAdapterError,
  ChainUnavailableError,
  CrossChainLiveError,
  DestinationInvalidError,
  ExecutorUnfundedError,
  InternalError,
  InvalidInputError,
  LiquidityUnavailableError,
  MandateRuleError,
  MandatePendingError,
  MandateUntrustedError,
  QuoteExpiredError,
  QuoteUnavailableError,
  RailActionRequiredError,
  RailRejectedError,
  RailTimeoutError,
  RailUnavailableError,
  RateUnavailableError,
  ReorgedError,
  RpcLaggingError,
  RpcRateLimitedError,
  RpcTimeoutError,
  SignedPayloadMismatchError,
  SignerAddressMismatchError,
  SignerDeniedError,
  SignerUnavailableError,
  SigningRequestExpiredError,
  SponsorDeniedError,
  SponsorUnfundedError,
  SubmissionRejectedError,
  SubmissionUnknownError,
  TenantMismatchError,
  MANDATE_ERRORS,
  MANDATE_ERROR_NAMES,
  UnsupportedError,
  isChainAdapterError,
  mandateRuleErrorOf,
} from './index.js';
import type { ChainAdapterErrorCode } from './index.js';

type Ctor = new (options?: object) => ChainAdapterError;

// Code, class, retryable by default, landed by default.
const TABLE: [ChainAdapterErrorCode, Ctor, boolean, 'no' | 'unknown'][] = [
  ['INVALID_INPUT', InvalidInputError, false, 'no'],
  ['UNSUPPORTED', UnsupportedError, false, 'no'],
  ['TENANT_MISMATCH', TenantMismatchError, false, 'no'],
  ['MANDATE_UNTRUSTED', MandateUntrustedError, false, 'no'],
  ['MANDATE_PENDING', MandatePendingError, true, 'no'],
  ['CHAIN_UNAVAILABLE', ChainUnavailableError, true, 'no'],
  ['RPC_TIMEOUT', RpcTimeoutError, true, 'unknown'],
  ['RPC_LAGGING', RpcLaggingError, true, 'no'],
  ['RPC_RATE_LIMITED', RpcRateLimitedError, true, 'no'],
  ['SUBMISSION_REJECTED', SubmissionRejectedError, false, 'no'],
  ['SUBMISSION_UNKNOWN', SubmissionUnknownError, true, 'unknown'],
  ['SIGNED_PAYLOAD_MISMATCH', SignedPayloadMismatchError, false, 'no'],
  ['SIGNING_REQUEST_EXPIRED', SigningRequestExpiredError, false, 'no'],
  ['SIGNER_UNAVAILABLE', SignerUnavailableError, true, 'no'],
  ['SIGNER_DENIED', SignerDeniedError, false, 'no'],
  ['SIGNER_ADDRESS_MISMATCH', SignerAddressMismatchError, false, 'no'],
  ['SPONSOR_DENIED', SponsorDeniedError, false, 'no'],
  ['ACTIVATION_BUDGET_EXHAUSTED', ActivationBudgetExhaustedError, false, 'no'],
  ['SPONSOR_UNFUNDED', SponsorUnfundedError, false, 'no'],
  ['EXECUTOR_UNFUNDED', ExecutorUnfundedError, false, 'no'],
  ['DESTINATION_INVALID', DestinationInvalidError, false, 'no'],
  ['QUOTE_EXPIRED', QuoteExpiredError, true, 'no'],
  ['QUOTE_UNAVAILABLE', QuoteUnavailableError, false, 'no'],
  ['LIQUIDITY_UNAVAILABLE', LiquidityUnavailableError, false, 'no'],
  ['RATE_UNAVAILABLE', RateUnavailableError, true, 'no'],
  ['RAIL_UNAVAILABLE', RailUnavailableError, true, 'no'],
  ['RAIL_REJECTED', RailRejectedError, false, 'no'],
  ['RAIL_TIMEOUT', RailTimeoutError, true, 'no'],
  ['RAIL_ACTION_REQUIRED', RailActionRequiredError, false, 'no'],
  ['CROSS_CHAIN_LIVE', CrossChainLiveError, false, 'no'],
  ['REORGED', ReorgedError, false, 'no'],
  ['INTERNAL', InternalError, false, 'no'],
];

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('chain adapter errors', () => {
  it.each(TABLE)('every error class has code and name: %s', (code, Ctor, retryable, landed) => {
    const err = new Ctor();
    expect(err).toBeInstanceOf(ChainAdapterError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.name).toBe(Ctor.name);
    expect(err.message).toBe(CHAIN_ADAPTER_ERROR_MESSAGES[code]);
    expect(err.retryable).toBe(retryable);
    expect(err.landed).toBe(landed);
    expect(err.network).toBeNull();
    expect(err.retryAfterMs).toBeNull();
    expect(isChainAdapterError(err)).toBe(true);
  });

  it('covers every code exactly once, plus MANDATE_RULE', () => {
    const codes = [...TABLE.map(([code]) => code), 'MANDATE_RULE'].sort();
    expect([...CHAIN_ADAPTER_ERROR_CODES].sort()).toEqual(codes);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.isFrozen(CHAIN_ADAPTER_ERROR_CODES)).toBe(true);
  });

  it('exports every class from the package root', () => {
    const exported = index as Record<string, unknown>;
    for (const [, Ctor] of TABLE) expect(exported[Ctor.name]).toBe(Ctor);
    expect(exported['MandateRuleError']).toBe(MandateRuleError);
  });

  it('gives every code its own fixed message', () => {
    const messages = CHAIN_ADAPTER_ERROR_CODES.map((code) => CHAIN_ADAPTER_ERROR_MESSAGES[code]);
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) expect(message).toMatch(/^[A-Z][A-Za-z ]+$/);
    expect(Object.isFrozen(CHAIN_ADAPTER_ERROR_MESSAGES)).toBe(true);
  });

  it('defaults landed to unknown only where a send may have landed', () => {
    const unknown = TABLE.filter(([, Ctor]) => new Ctor().landed === 'unknown').map(([c]) => c);
    expect(unknown).toEqual(['RPC_TIMEOUT', 'SUBMISSION_UNKNOWN']);
    expect(new RpcTimeoutError({ landed: 'no' }).landed).toBe('no');
  });

  it('takes no free text: a string or null in place of the options throws', () => {
    for (const bad of ['principal 1234 over cap', null, 7, ['x']]) {
      expect(thrown(() => new SponsorDeniedError(bad as never))).toBeInstanceOf(InvalidInputError);
      expect(
        thrown(() => new MandateRuleError(43, 'INSUFFICIENT_FUNDS', bad as never)),
      ).toBeInstanceOf(InvalidInputError);
    }
    expect(
      thrown(() => new RpcTimeoutError(Object.create({ landed: 'no' }) as never)),
    ).toBeInstanceOf(InvalidInputError);
    const getter = {
      get landed() {
        return 'no';
      },
    };
    expect(thrown(() => new RpcTimeoutError(getter as never))).toBeInstanceOf(InvalidInputError);
    expect(thrown(() => new InvalidInputError(getter as never))).toBeInstanceOf(InvalidInputError);
  });

  it('carries safe issue strings on InvalidInputError, and refuses any other', () => {
    const err = new InvalidInputError({ issues: ['stellar:pubnet.rpc.0.url (invalid_format)'] });
    expect(err.issues).toEqual(['stellar:pubnet.rpc.0.url (invalid_format)']);
    expect(Object.isFrozen(err.issues)).toBe(true);
    expect(err.message).toBe(CHAIN_ADAPTER_ERROR_MESSAGES.INVALID_INPUT);
    expect(err.toJSON()).toMatchObject({ code: 'INVALID_INPUT', issues: err.issues });
    expect(new InvalidInputError().issues).toEqual([]);
    for (const issues of [
      ['https://rpc.example/key (invalid_format)'],
      ['path'],
      ['path (Has Upper)'],
      ['a b (code)'],
      Array.from({ length: 11 }, () => 'x (y)'),
      'x (y)',
      [7],
    ]) {
      expect(thrown(() => new InvalidInputError({ issues } as never))).toBeInstanceOf(
        InvalidInputError,
      );
    }
  });

  it('carries a destination parse reason on InvalidInputError, and refuses any other', () => {
    const err = new InvalidInputError({
      network: 'stellar:testnet',
      reason: 'CHECKSUM',
      issues: ['destination.address (checksum)'],
    });
    expect(err.reason).toBe('CHECKSUM');
    expect(err.network).toBe('stellar:testnet');
    expect(err.toJSON()).toMatchObject({
      code: 'INVALID_INPUT',
      reason: 'CHECKSUM',
      issues: ['destination.address (checksum)'],
    });
    expect(new InvalidInputError().reason).toBeNull();
    expect(new InvalidInputError().toJSON()).not.toHaveProperty('reason');
    for (const reason of ['checksum', 'NOT_A_REASON', 7, null]) {
      const bad = thrown(() => new InvalidInputError({ reason } as never));
      expect(bad).toBeInstanceOf(InvalidInputError);
      expect((bad as InvalidInputError).issues).toEqual(['errorOptions.reason (invalid)']);
    }
    expect(DESTINATION_PARSE_REASONS).toHaveLength(7);
    expect(Object.isFrozen(DESTINATION_PARSE_REASONS)).toBe(true);
  });

  it('lets options override the defaults', () => {
    const err = new RpcTimeoutError({
      network: 'stellar:testnet',
      retryAfterMs: 1500,
      waitFor: 'chain',
    });
    expect(err.network).toBe('stellar:testnet');
    expect(err.retryAfterMs).toBe(1500);
    expect(err.waitFor).toBe('chain');
    const landed = new SubmissionRejectedError({ landed: 'no', retryable: false });
    expect(landed.landed).toBe('no');
    const unknown = new InternalError({
      landed: 'unknown',
      retryable: true,
    });
    expect(unknown.landed).toBe('unknown');
    expect(unknown.retryable).toBe(true);
  });

  it('never carries a cause that could print a secret', () => {
    // Transport and config errors routinely quote URLs with keys in them.
    const MARKER = 'SUPERSECRETKEY123';
    const inner = new Error(`fetch failed for https://rpc.example/v3/${MARKER}`, {
      cause: new Error(`retry of ${MARKER}`),
    });
    Object.assign(inner, { url: `https://rpc.example/v3/${MARKER}`, config: { key: MARKER } });
    for (const err of [
      new ChainUnavailableError({ cause: inner, network: 'stellar:testnet' }),
      new RpcTimeoutError({ cause: inner }),
      new InvalidInputError({ cause: inner }),
      new MandateRuleError(43, 'INSUFFICIENT_FUNDS', { cause: inner }),
      new RpcTimeoutError({ cause: MARKER }),
      new RpcTimeoutError({ cause: { message: MARKER } }),
    ]) {
      const printed = [
        format('%o', err),
        format('%s', err),
        format(err),
        inspect(err, { depth: Infinity, showHidden: true }),
        JSON.stringify(err),
        JSON.stringify(err.toJSON()),
        String(err),
        String(err.stack),
      ];
      // Walk the whole chain the way an error tracker does.
      for (let link: unknown = err; link !== undefined && link !== null;) {
        printed.push(inspect(link, { depth: Infinity, showHidden: true }));
        link = (link as { cause?: unknown }).cause;
      }
      for (const text of printed) expect(text).not.toContain(MARKER);
    }
  });

  it('keeps only the kind of the cause, under a fixed message', () => {
    const err = new ChainUnavailableError({ cause: new TypeError('fetch failed: key=abc') });
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).name).toBe('RedactedCause');
    expect((err.cause as Error).message).toBe('Cause redacted: TypeError');
    expect((err.cause as Error & { cause?: unknown }).cause).toBeUndefined();
    // A cause whose name is not a plain identifier is not named at all,
    // since the name is caller text too.
    const named = new Error('x');
    named.name = 'key=abc def';
    const odd = new RpcTimeoutError({ cause: named });
    expect((odd.cause as Error).message).toBe('Cause redacted: Error');
    // Only expected class names are kept. A name shaped like an identifier
    // can still be a secret.
    const MARKER = 'SUPERSECRETKEY123';
    const planted = new Error('x');
    planted.name = MARKER;
    const hidden = new RpcTimeoutError({ cause: planted });
    expect((hidden.cause as Error).message).toBe('Cause redacted: Error');
    expect(inspect(hidden, { depth: Infinity, showHidden: true })).not.toContain(MARKER);
    // A getter that returns the secret is read at most once and not kept.
    let reads = 0;
    const getterCause = new Error('x');
    Object.defineProperty(getterCause, 'name', {
      get() {
        reads += 1;
        return MARKER;
      },
    });
    const viaGetter = new RpcTimeoutError({ cause: getterCause });
    expect(reads).toBeLessThanOrEqual(1);
    // A Proxy whose prototype lookup throws cannot even be checked as an
    // Error, so it is recorded as one without being read.
    const hostile = new Proxy(new Error('x'), {
      getPrototypeOf() {
        throw new Error(MARKER);
      },
    });
    const viaProxy = new RpcTimeoutError({ cause: hostile });
    expect((viaProxy.cause as Error).message).toBe('Cause redacted: Error');
    expect(inspect(viaProxy, { depth: Infinity, showHidden: true })).not.toContain(MARKER);
    const throwing = new Error('x');
    Object.defineProperty(throwing, 'name', {
      get() {
        throw new Error(MARKER);
      },
    });
    expect((new RpcTimeoutError({ cause: throwing }).cause as Error).message).toBe(
      'Cause redacted: Error',
    );
    // Every adapter error class is an expected name, so wrapping one keeps it.
    for (const [, Ctor] of TABLE) {
      const inner = new Ctor();
      expect((new InternalError({ cause: inner }).cause as Error).message).toBe(
        `Cause redacted: ${inner.name}`,
      );
    }
    const rule = new MandateRuleError(43, 'INSUFFICIENT_FUNDS');
    expect((new InternalError({ cause: rule }).cause as Error).message).toBe(
      'Cause redacted: MandateRuleError',
    );
    expect((viaGetter.cause as Error).message).toBe('Cause redacted: Error');
    expect(inspect(viaGetter, { depth: Infinity, showHidden: true })).not.toContain(MARKER);
    for (const name of [
      'RangeError',
      'SyntaxError',
      'AggregateError',
      'AbortError',
      'TimeoutError',
      'FetchError',
      'RpcTimeoutError',
    ]) {
      const known = new Error('x');
      known.name = name;
      expect((new ChainUnavailableError({ cause: known }).cause as Error).message).toBe(
        `Cause redacted: ${name}`,
      );
    }
    expect(new RpcTimeoutError({ cause: 'text' }).cause).toBeInstanceOf(Error);
    expect(new RpcTimeoutError().cause).toBeUndefined();
  });

  it('refuses a retryAfterMs that is not a whole non negative number', () => {
    for (const retryAfterMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(thrown(() => new RpcTimeoutError({ retryAfterMs }))).toBeInstanceOf(InvalidInputError);
    }
  });

  it('refuses options that could not be stored on a job', () => {
    const bad: object[] = [
      { network: 'stellar:futurenet' },
      { landed: 'maybe' },
      { waitFor: 'tomorrow' },
      { retryable: 'yes' },
    ];
    for (const options of bad) {
      expect(thrown(() => new RpcTimeoutError(options))).toBeInstanceOf(InvalidInputError);
    }
    expect(new RpcTimeoutError({ network: null, waitFor: null }).waitFor).toBeNull();
  });

  it('serializes to the job form without the message', () => {
    const err = new SponsorDeniedError({ network: 'stellar:pubnet' });
    expect(err.toJSON()).toEqual({
      code: 'SPONSOR_DENIED',
      network: 'stellar:pubnet',
      retryable: false,
      landed: 'no',
      retryAfterMs: null,
      waitFor: 'none',
    });
    expect(JSON.stringify(err.toJSON())).not.toContain('message');
  });
});

describe('MandateRuleError', () => {
  it.each([
    ['INSUFFICIENT_FUNDS', 43, true, 'funding'],
    ['DAILY_CAP_EXCEEDED', 42, true, 'utc_day'],
    ['MANDATE_PAUSED', 22, true, 'resume'],
    ['TRANSFER_FAILED', 72, false, 'none'],
    ['ROLE_CONFLICT', 11, false, 'none'],
  ] as const)(
    'maps %s to retryable %s waiting for %s',
    (specName, specCode, retryable, waitFor) => {
      const err = new MandateRuleError(specCode, specName);
      expect(err).toBeInstanceOf(ChainAdapterError);
      expect(err.name).toBe('MandateRuleError');
      expect(err.code).toBe('MANDATE_RULE');
      expect(err.specCode).toBe(specCode);
      expect(err.specName).toBe(specName);
      expect(err.retryable).toBe(retryable);
      expect(err.waitFor).toBe(waitFor);
      expect(err.landed).toBe('no');
      expect(err.toJSON()).toMatchObject({ code: 'MANDATE_RULE', specCode, specName });
    },
  );

  it('refuses a name the spec table does not hold, or a code that is not its own', () => {
    for (const [code, name] of [
      [-1, 'X'],
      [1.5, 'X'],
      [1, ''],
      [1, 'lower_case'],
      [99, 'NOT_A_SPEC_RULE'],
      [43, 'DAILY_CAP_EXCEEDED'],
      [10, 'ROLE_CONFLICT'],
      [43, 'toString'],
    ] as const) {
      expect(thrown(() => new MandateRuleError(code, name as never))).toBeInstanceOf(
        InvalidInputError,
      );
    }
  });

  it('names a returned code from the table, and calls one it cannot name internal', () => {
    for (const name of MANDATE_ERROR_NAMES) {
      const err = mandateRuleErrorOf(MANDATE_ERRORS[name]);
      expect(err).toBeInstanceOf(MandateRuleError);
      expect(err).toMatchObject({ specName: name, specCode: MANDATE_ERRORS[name] });
    }
    const unknown = mandateRuleErrorOf(1, { network: 'stellar:testnet' });
    expect(unknown).toBeInstanceOf(InternalError);
    expect(unknown.network).toBe('stellar:testnet');
  });
});

describe('isChainAdapterError', () => {
  it('is false for anything else', () => {
    for (const value of [
      new Error('x'),
      null,
      undefined,
      'INVALID_INPUT',
      { code: 'INVALID_INPUT' },
    ]) {
      expect(isChainAdapterError(value)).toBe(false);
    }
  });
});
