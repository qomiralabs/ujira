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
 * Defaults follow the retry table of the design: transport and rail outages
 * are retryable; everything else is final with landed 'no'. Two codes
 * default to landed 'unknown': SUBMISSION_UNKNOWN, and RPC_TIMEOUT, because
 * a timeout on a send may have landed. A read that sent nothing passes
 * landed 'no'. RPC_LAGGING and RPC_RATE_LIMITED mean nothing was accepted.
 *
 * InvalidInputError also takes `issues`: at most ten strings of the form
 * "path (code)", where path is letters, digits, '_', '.' and ':' and code
 * is lower snake case. They say what was wrong without saying what it was.
 *
 * MandateRuleError(specCode, specName, options?) carries the mandate spec
 * error. INSUFFICIENT_FUNDS waits for funding, DAILY_CAP_EXCEEDED for the
 * next UTC day and MANDATE_PAUSED for a resume, all retryable; every other
 * spec error is final. specCode must be a non negative safe integer and
 * specName a non empty upper snake case name, else InvalidInputError.
 *
 * toJSON() returns the serializable ChainAdapterErrorJson stored on jobs.
 * Signer errors arrive with the signer port and are not part of this set.
 */

import { describe, expect, it } from 'vitest';

import * as index from './index.js';
import {
  CHAIN_ADAPTER_ERROR_CODES,
  CHAIN_ADAPTER_ERROR_MESSAGES,
  ChainAdapterError,
  ChainUnavailableError,
  CrossChainLiveError,
  DestinationInvalidError,
  ExecutorUnfundedError,
  InternalError,
  InvalidInputError,
  LiquidityUnavailableError,
  MandateRuleError,
  MandateUntrustedError,
  QuoteExpiredError,
  QuoteUnavailableError,
  RailActionRequiredError,
  RailRejectedError,
  RailTimeoutError,
  RailUnavailableError,
  ReorgedError,
  RpcLaggingError,
  RpcRateLimitedError,
  RpcTimeoutError,
  SignedPayloadMismatchError,
  SigningRequestExpiredError,
  SponsorDeniedError,
  SponsorUnfundedError,
  SubmissionRejectedError,
  SubmissionUnknownError,
  TenantMismatchError,
  UnsupportedError,
  isChainAdapterError,
} from './index.js';
import type { ChainAdapterErrorCode } from './index.js';

type Ctor = new (options?: object) => ChainAdapterError;

// Code, class, retryable by default, landed by default.
const TABLE: [ChainAdapterErrorCode, Ctor, boolean, 'no' | 'unknown'][] = [
  ['INVALID_INPUT', InvalidInputError, false, 'no'],
  ['UNSUPPORTED', UnsupportedError, false, 'no'],
  ['TENANT_MISMATCH', TenantMismatchError, false, 'no'],
  ['MANDATE_UNTRUSTED', MandateUntrustedError, false, 'no'],
  ['CHAIN_UNAVAILABLE', ChainUnavailableError, true, 'no'],
  ['RPC_TIMEOUT', RpcTimeoutError, true, 'unknown'],
  ['RPC_LAGGING', RpcLaggingError, true, 'no'],
  ['RPC_RATE_LIMITED', RpcRateLimitedError, true, 'no'],
  ['SUBMISSION_REJECTED', SubmissionRejectedError, false, 'no'],
  ['SUBMISSION_UNKNOWN', SubmissionUnknownError, true, 'unknown'],
  ['SIGNED_PAYLOAD_MISMATCH', SignedPayloadMismatchError, false, 'no'],
  ['SIGNING_REQUEST_EXPIRED', SigningRequestExpiredError, false, 'no'],
  ['SPONSOR_DENIED', SponsorDeniedError, false, 'no'],
  ['SPONSOR_UNFUNDED', SponsorUnfundedError, false, 'no'],
  ['EXECUTOR_UNFUNDED', ExecutorUnfundedError, false, 'no'],
  ['DESTINATION_INVALID', DestinationInvalidError, false, 'no'],
  ['QUOTE_EXPIRED', QuoteExpiredError, true, 'no'],
  ['QUOTE_UNAVAILABLE', QuoteUnavailableError, false, 'no'],
  ['LIQUIDITY_UNAVAILABLE', LiquidityUnavailableError, false, 'no'],
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

  it('keeps the cause without putting it in the JSON', () => {
    const cause = new Error('socket hang up at https://rpc.example/secret-key');
    const err = new ChainUnavailableError({ cause, network: 'eip155:42220' });
    expect(err.cause).toBe(cause);
    expect(JSON.stringify(err.toJSON())).not.toContain('secret-key');
  });

  it('refuses a retryAfterMs that is not a whole non negative number', () => {
    for (const retryAfterMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(thrown(() => new RpcTimeoutError({ retryAfterMs }))).toBeInstanceOf(InvalidInputError);
    }
  });

  it('refuses options that could not be stored on a job', () => {
    const bad: object[] = [
      { network: 'eip155:1' },
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
    ['DAILY_CAP_EXCEEDED', 44, true, 'utc_day'],
    ['MANDATE_PAUSED', 10, true, 'resume'],
    ['TRANSFER_FAILED', 50, false, 'none'],
    ['ROLE_CONFLICT', 7, false, 'none'],
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

  it('refuses a malformed spec code or name', () => {
    for (const [code, name] of [
      [-1, 'X'],
      [1.5, 'X'],
      [1, ''],
      [1, 'lower_case'],
      [1, 'HAS SPACE'],
    ] as const) {
      expect(thrown(() => new MandateRuleError(code, name))).toBeInstanceOf(InvalidInputError);
    }
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
