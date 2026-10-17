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
 *   network       the network involved, or null
 *   retryable     whether the job layer may try again
 *   landed        'no' | 'yes' | 'unknown': did anything reach the chain
 *   retryAfterMs  a hint in whole milliseconds, or null
 *   waitFor       'none' | 'funding' | 'utc_day' | 'resume' | 'approval' |
 *                 'chain' | null: the event a parked job waits for
 * Defaults follow the retry table of the design: transport and rail outages
 * are retryable, a submission that may have landed is retryable with
 * landed 'unknown', everything else is final with landed 'no'. Options may
 * override retryable, landed, retryAfterMs, waitFor and network.
 *
 * MandateRuleError(specCode, specName) carries the mandate spec error.
 * INSUFFICIENT_FUNDS waits for funding, DAILY_CAP_EXCEEDED for the next UTC
 * day and MANDATE_PAUSED for a resume, all retryable; every other spec
 * error is final. specCode must be a non negative safe integer and specName
 * a non empty upper snake case name, else InvalidInputError.
 *
 * toJSON() returns the serializable ChainAdapterErrorJson stored on jobs;
 * it never includes the message, which may name an address.
 * Signer errors arrive with the signer port and are not part of this set.
 */

import { describe, expect, it } from 'vitest';

import * as index from './index.js';
import {
  CHAIN_ADAPTER_ERROR_CODES,
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

type Ctor = new (message?: string, options?: object) => ChainAdapterError;

// Code, class, retryable by default, landed by default.
const TABLE: [ChainAdapterErrorCode, Ctor, boolean, 'no' | 'unknown'][] = [
  ['INVALID_INPUT', InvalidInputError, false, 'no'],
  ['UNSUPPORTED', UnsupportedError, false, 'no'],
  ['TENANT_MISMATCH', TenantMismatchError, false, 'no'],
  ['MANDATE_UNTRUSTED', MandateUntrustedError, false, 'no'],
  ['CHAIN_UNAVAILABLE', ChainUnavailableError, true, 'no'],
  ['RPC_TIMEOUT', RpcTimeoutError, true, 'no'],
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
    const err = new Ctor('boom');
    expect(err).toBeInstanceOf(ChainAdapterError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.name).toBe(Ctor.name);
    expect(err.message).toBe('boom');
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

  it('lets options override the defaults', () => {
    const err = new RpcTimeoutError('slow', {
      network: 'stellar:testnet',
      retryAfterMs: 1500,
      waitFor: 'chain',
    });
    expect(err.network).toBe('stellar:testnet');
    expect(err.retryAfterMs).toBe(1500);
    expect(err.waitFor).toBe('chain');
    const landed = new SubmissionRejectedError('bad sequence', { landed: 'no', retryable: false });
    expect(landed.landed).toBe('no');
    const unknown = new InternalError('broadcast then crash', {
      landed: 'unknown',
      retryable: true,
    });
    expect(unknown.landed).toBe('unknown');
    expect(unknown.retryable).toBe(true);
  });

  it('keeps the cause without putting it in the JSON', () => {
    const cause = new Error('socket hang up at https://rpc.example/secret-key');
    const err = new ChainUnavailableError('rpc down', { cause, network: 'eip155:42220' });
    expect(err.cause).toBe(cause);
    expect(JSON.stringify(err.toJSON())).not.toContain('secret-key');
  });

  it('refuses a retryAfterMs that is not a whole non negative number', () => {
    for (const retryAfterMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(thrown(() => new RpcTimeoutError('x', { retryAfterMs }))).toBeInstanceOf(
        InvalidInputError,
      );
    }
  });

  it('serializes to the job form without the message', () => {
    const err = new SponsorDeniedError('principal 1234 over cap', { network: 'stellar:pubnet' });
    expect(err.toJSON()).toEqual({
      code: 'SPONSOR_DENIED',
      network: 'stellar:pubnet',
      retryable: false,
      landed: 'no',
      retryAfterMs: null,
      waitFor: 'none',
    });
    expect(JSON.stringify(err.toJSON())).not.toContain('1234');
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
