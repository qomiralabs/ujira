// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { generateFixtures, toPayoutListItem } from './fixtures/index.js';
import {
  ContractMismatchError,
  UnknownRouteError,
  assertMatchesSchema,
  assertResponseMatchesSchema,
  buildProblem,
  parseQuery,
} from './index.js';
import type { RouteId } from './index.js';

const set = generateFixtures({ seed: 5 });
const payout = set.payouts[0];
if (payout === undefined) throw new Error('fixture missing');

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type':
        status === 200 ? 'application/json; charset=utf-8' : 'application/problem+json',
      'request-id': 'req_0123456789',
      ...headers,
    },
  });

describe('assertMatchesSchema', () => {
  it('returns a matching body typed for its route', () => {
    const body = assertMatchesSchema('getPayout', payout);
    expect(body.id).toBe(payout.id);
    expect(
      assertMatchesSchema('listPayouts', { items: [toPayoutListItem(payout)], nextCursor: null })
        .items,
    ).toHaveLength(1);
  });

  it('names the failing paths without copying the values', () => {
    const secret = 'Fixture Value That Must Not Leak';
    let caught: unknown;
    try {
      assertMatchesSchema('getPayout', {
        ...payout,
        requested: { amount: secret, currency: 'USD', scale: 2 },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContractMismatchError);
    const mismatch = caught as ContractMismatchError;
    expect(mismatch.issues.map((i) => i.path)).toContain('requested.amount');
    expect(mismatch.message).not.toContain(secret);
    expect(JSON.stringify(mismatch.issues)).not.toContain(secret);
    expect(mismatch.code).toBe('CONTRACT_MISMATCH');
    expect(mismatch.route).toBe('getPayout');
  });

  it('accepts only the error statuses a route declares, with a matching problem', () => {
    const notFound = buildProblem('NOT_FOUND', 'req_0123456789');
    expect(assertMatchesSchema('getPayout', notFound, 404)).toEqual(notFound);
    expect(() => assertMatchesSchema('listPayouts', notFound, 404)).toThrow(ContractMismatchError);
    expect(() => assertMatchesSchema('getPayout', notFound, 400)).toThrow(ContractMismatchError);
    expect(() => assertMatchesSchema('getPayout', { message: 'nope' }, 404)).toThrow(
      ContractMismatchError,
    );
    expect(() => assertMatchesSchema('getPayout', notFound, 500)).toThrow(ContractMismatchError);
  });

  it('refuses a route that is not in the table', () => {
    expect(() => assertMatchesSchema('deletePayout' as RouteId, {})).toThrow(UnknownRouteError);
    expect(() => assertMatchesSchema('toString' as RouteId, {})).toThrow(UnknownRouteError);
  });
});

describe('assertResponseMatchesSchema', () => {
  it('checks the content type and the request id header', async () => {
    await expect(assertResponseMatchesSchema('getPayout', json(payout))).resolves.toBeDefined();
    await expect(
      assertResponseMatchesSchema('getPayout', json(payout, 200, { 'content-type': 'text/plain' })),
    ).rejects.toThrow(ContractMismatchError);
    const noId = new Response(JSON.stringify(payout), {
      headers: { 'content-type': 'application/json' },
    });
    await expect(assertResponseMatchesSchema('getPayout', noId)).rejects.toThrow(/Request-Id/);
    const problem = buildProblem('NOT_FOUND', 'req_other_0000');
    await expect(assertResponseMatchesSchema('getPayout', json(problem, 404))).rejects.toThrow(
      /requestId/,
    );
    await expect(
      assertResponseMatchesSchema(
        'getPayout',
        json(buildProblem('NOT_FOUND', 'req_0123456789'), 404),
      ),
    ).resolves.toBeDefined();
  });
});

const codeOf = (result: ReturnType<typeof parseQuery>): string | null =>
  result.success ? null : result.code;
const errorsOf = (result: ReturnType<typeof parseQuery>): unknown =>
  result.success ? null : result.errors;

describe('parseQuery', () => {
  it('reads plain records and search params alike', () => {
    expect(parseQuery('listMandates', { status: 'active,paused' })).toEqual({
      success: true,
      data: { status: ['active', 'paused'] },
    });
    expect(parseQuery('listMandates', new URLSearchParams('limit=10')).success).toBe(true);
  });

  it('names the problem code the API answers with', () => {
    const limit = parseQuery('listPayouts', { limit: '500' });
    expect(codeOf(limit)).toBe('LIMIT_OUT_OF_RANGE');
    const deposits = parseQuery('getFunding', { depositsLimit: '0' });
    expect(codeOf(deposits)).toBe('LIMIT_OUT_OF_RANGE');
    const cursor = parseQuery('listPayouts', { cursor: 'has spaces' });
    expect(codeOf(cursor)).toBe('INVALID_CURSOR');
    const mixed = parseQuery('listPayouts', { cursor: 'has spaces', limit: '0' });
    expect(codeOf(mixed)).toBe('INVALID_FILTER');
    const twice = parseQuery('listPayouts', new URLSearchParams('method=bank&method=cash_pickup'));
    expect(errorsOf(twice)).toEqual([{ field: 'method', code: 'repeated_key' }]);
    const missing = parseQuery('listPayouts', { amountMax: '10' });
    expect(errorsOf(missing)).toEqual([{ field: 'amountCurrency', code: 'currency_required' }]);
  });

  it('refuses a route that is not in the table', () => {
    expect(() => parseQuery('nope' as RouteId, {})).toThrow(UnknownRouteError);
  });
});
