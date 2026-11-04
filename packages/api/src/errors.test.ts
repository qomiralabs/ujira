// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { PROBLEM_CODES, PROBLEM_TITLES, Problem, buildProblem } from '@ujira/api-schema';
import type { ProblemCode } from '@ujira/api-schema';
import {
  CHAIN_ADAPTER_ERROR_CODES,
  ActivationBudgetExhaustedError,
  MANDATE_ERRORS,
  MANDATE_ERROR_NAMES,
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
  UnsupportedError,
} from '@ujira/chain-adapter';
import type { ChainAdapterError } from '@ujira/chain-adapter';
import {
  DatabaseConfigError,
  DatabaseUnavailableError,
  SessionStateError,
  TenantContextError,
} from '@ujira/db';
import { describe, expect, it } from 'vitest';

import {
  ADAPTER_ERROR_MAP,
  ApiError,
  MANDATE_ERROR_MAP,
  DATABASE_ERROR_CLASSES,
  RETRY_AFTER_SECONDS,
  toApiError,
} from './errors.js';

// One instance of every adapter error class, so the mapping is proven on
// real errors and not only on the table.
const ADAPTER_ERRORS: readonly ChainAdapterError[] = [
  new InvalidInputError(),
  new UnsupportedError(),
  new TenantMismatchError(),
  new MandateUntrustedError(),
  new MandatePendingError(),
  new MandateRuleError(42, 'DAILY_CAP_EXCEEDED'),
  new ChainUnavailableError(),
  new RpcTimeoutError(),
  new RpcLaggingError(),
  new RpcRateLimitedError(),
  new SubmissionRejectedError(),
  new SubmissionUnknownError(),
  new SignedPayloadMismatchError(),
  new SigningRequestExpiredError(),
  new SignerUnavailableError(),
  new SignerDeniedError(),
  new SignerAddressMismatchError(),
  new SponsorDeniedError(),
  new SponsorUnfundedError(),
  new ActivationBudgetExhaustedError(),
  new ExecutorUnfundedError(),
  new DestinationInvalidError(),
  new QuoteExpiredError(),
  new QuoteUnavailableError(),
  new LiquidityUnavailableError(),
  new RailUnavailableError(),
  new RailRejectedError(),
  new RailTimeoutError(),
  new RailActionRequiredError(),
  new CrossChainLiveError(),
  new ReorgedError(),
  new InternalError(),
];

const DATABASE_ERRORS: readonly (readonly [Error, ProblemCode])[] = [
  [new DatabaseUnavailableError('08006'), 'DB_UNAVAILABLE'],
  [new DatabaseConfigError('x'), 'INTERNAL'],
  [new TenantContextError('x'), 'INTERNAL'],
  [new SessionStateError('x'), 'INTERNAL'],
];

function expectWellFormed(error: ApiError): void {
  expect(Object.hasOwn(PROBLEM_CODES, error.code)).toBe(true);
  expect(error.status).toBe(PROBLEM_CODES[error.code]);
  expect(error.status).toBeGreaterThanOrEqual(400);
  expect(error.status).toBeLessThanOrEqual(599);
  expect(error.message).toBe(PROBLEM_TITLES[error.code]);
  // A code worth retrying always says when; any other never does.
  if (error.status === 503 || error.status === 429) {
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
  } else {
    expect(error.retryAfterSeconds).toBeNull();
  }
  const body = buildProblem(error.code, 'req_0123456789', { errors: error.errors });
  expect(Problem.safeParse(body).success).toBe(true);
}

describe('error model', () => {
  it('every mapped error has a code and status', () => {
    expect(ADAPTER_ERRORS.map((e) => e.code).sort()).toEqual([...CHAIN_ADAPTER_ERROR_CODES].sort());
    for (const adapterError of ADAPTER_ERRORS) {
      const mapped = toApiError(adapterError);
      const expected =
        adapterError instanceof MandateRuleError
          ? MANDATE_ERROR_MAP[adapterError.specName]
          : ADAPTER_ERROR_MAP[adapterError.code];
      expect(mapped.code, adapterError.code).toBe(expected);
      expectWellFormed(mapped);
    }
    // Every rule in the vendored spec table, one by one.
    expect(Object.keys(MANDATE_ERROR_MAP).sort()).toEqual([...MANDATE_ERROR_NAMES].sort());
    for (const name of MANDATE_ERROR_NAMES) {
      const mapped = toApiError(new MandateRuleError(MANDATE_ERRORS[name], name));
      expect(mapped.code, name).toBe(MANDATE_ERROR_MAP[name]);
      expectWellFormed(mapped);
    }
    expect(DATABASE_ERRORS.map(([e]) => e.name).sort()).toEqual([...DATABASE_ERROR_CLASSES].sort());
    for (const [databaseError, code] of DATABASE_ERRORS) {
      const mapped = toApiError(databaseError);
      expect(mapped.code, databaseError.name).toBe(code);
      expectWellFormed(mapped);
    }
    for (const code of Object.keys(PROBLEM_CODES) as ProblemCode[]) {
      expectWellFormed(new ApiError(code));
    }
  });

  it('answers a mandate limit as a refusal and our own failures as internal', () => {
    expect(toApiError(new MandateRuleError(43, 'INSUFFICIENT_FUNDS')).code).toBe('MANDATE_REFUSED');
    expect(toApiError(new MandateRuleError(61, 'PAYOUT_NOT_FOUND')).code).toBe('NOT_FOUND');
    expect(toApiError(new MandateRuleError(30, 'AMOUNT_INVALID')).code).toBe('INVALID_AMOUNT');
    expect(toApiError(new MandateRuleError(60, 'PAYOUT_ID_EXISTS')).code).toBe('INTERNAL');
  });

  it('maps a database outage to 503 with Retry-After', () => {
    const mapped = toApiError(new DatabaseUnavailableError('ECONNREFUSED'));
    expect(mapped).toMatchObject({ code: 'DB_UNAVAILABLE', status: 503, retryAfterSeconds: 5 });
  });

  it("takes the adapter's retry hint when it asks for longer, rounded up to whole seconds", () => {
    const longer = toApiError(new RpcRateLimitedError({ retryAfterMs: 12_001 }));
    expect(longer).toMatchObject({ code: 'CHAIN_UNAVAILABLE', retryAfterSeconds: 13 });
    const shorter = toApiError(new ChainUnavailableError({ retryAfterMs: 10 }));
    expect(shorter.retryAfterSeconds).toBe(RETRY_AFTER_SECONDS.CHAIN_UNAVAILABLE);
  });

  it('never gives a retry hint to a code that is not worth retrying', () => {
    expect(new ApiError('NOT_FOUND', { retryAfterSeconds: 30 }).retryAfterSeconds).toBeNull();
    expect(new ApiError('DB_UNAVAILABLE', { retryAfterSeconds: 1.5 }).retryAfterSeconds).toBe(5);
  });

  it('turns anything unknown into INTERNAL and keeps none of its text', () => {
    for (const thrown of [new Error('alice@example.com'), 'a string', null, { code: '08006' }]) {
      const mapped = toApiError(thrown);
      expect(mapped.code).toBe('INTERNAL');
      expect(mapped.message).not.toContain('alice');
      expect(mapped.detail).toBeUndefined();
    }
  });

  it('passes an ApiError through unchanged', () => {
    const error = new ApiError('NOT_FOUND', { detail: 'No such payout' });
    expect(toApiError(error)).toBe(error);
  });
});
