// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A destination submitted to the API goes through the same reader as onboarding,
// on the real method route. What a client sees for each kind of destination is
// pinned here: this replaces the stand-in route the rule was first tested on.

import { UNSUPPORTED_MEMO_DESTINATION_MESSAGE } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import {
  ACCOUNT,
  ISSUER,
  MUXED_123456,
  TENANT_A,
  problemOf,
  recipientWorld,
} from './recipients.test-support.js';

async function post(destination: unknown) {
  const world = recipientWorld();
  const id = await world.newRecipient();
  const response = await world.request('POST', `/v1/recipients/${id}/methods`, {
    method: 'stellar_wallet',
    destination,
  });
  return { response, world, id };
}

const on = (fields: Record<string, unknown>) => ({ network: 'stellar:testnet', ...fields });

describe('a destination on POST /v1/recipients/{id}/methods', () => {
  it('POST with the asset issuer, where a payout would be burned, returns 422', async () => {
    const { response, world, id } = await post(on({ address: ISSUER }));
    expect(response.status).toBe(422);
    const problem = await problemOf(response);
    expect(problem.code).toBe('DESTINATION_INVALID');
    expect(problem.errors).toEqual([{ field: 'destination', code: 'invalid_value' }]);
    expect(await world.records.methods(TENANT_A, id)).toEqual([]);
  });

  it('refuses the issuer under an id memo the same way', async () => {
    const { response } = await post(on({ address: ISSUER, memoType: 'id', memo: '7' }));
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe('DESTINATION_INVALID');
  });

  it('POST with a hash memo destination returns 422', async () => {
    const { response, world, id } = await post(
      on({ address: ACCOUNT, memoType: 'hash', memo: 'a'.repeat(64) }),
    );
    expect(response.status).toBe(422);
    expect(await problemOf(response)).toMatchObject({
      code: 'DESTINATION_INVALID',
      detail: UNSUPPORTED_MEMO_DESTINATION_MESSAGE,
      errors: [{ field: 'destination', code: 'invalid_value' }],
    });
    expect(await world.records.methods(TENANT_A, id)).toEqual([]);
  });

  it('refuses a text memo the same way', async () => {
    const { response } = await post(on({ address: ACCOUNT, memoType: 'text', memo: 'hello' }));
    expect(response.status).toBe(422);
    expect((await problemOf(response)).detail).toBe(UNSUPPORTED_MEMO_DESTINATION_MESSAGE);
  });

  it('refuses an id above 2^64 - 1', async () => {
    const { response } = await post(
      on({ address: ACCOUNT, memoType: 'id', memo: '18446744073709551616' }),
    );
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe('DESTINATION_INVALID');
  });

  it('refuses an address that is not one', async () => {
    const { response } = await post(on({ address: 'not-an-address' }));
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe('DESTINATION_INVALID');
  });

  it('accepts a plain account', async () => {
    const { response } = await post(on({ address: ACCOUNT }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ destination: ACCOUNT, tag: null });
  });

  it('turns an account with a numeric memo into the matching muxed address', async () => {
    const { response } = await post(on({ address: ACCOUNT, memoType: 'id', memo: '123456' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ destination: MUXED_123456, tag: '123456' });
  });

  it('accepts a muxed address as it is', async () => {
    const { response } = await post(on({ address: MUXED_123456 }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ destination: MUXED_123456, tag: '123456' });
  });

  it('refuses a body whose destination is the wrong shape, as a 400', async () => {
    const { response } = await post({ network: 'stellar:mars', address: ACCOUNT });
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('INVALID_REQUEST');
  });
});
