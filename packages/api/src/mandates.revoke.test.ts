// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { MandateDetail } from '@ujira/api-schema';
import type { SigningRequestWire } from '@ujira/api-schema';
import { describe, expect, it } from 'vitest';

import { PreparedShape, mandateWorld, problemOf } from './mandates.test-support.js';

describe('POST /v1/mandates/{id}/revoke', () => {
  it('revoke response includes the withdraw next action with the frozen amount', async () => {
    const world = mandateWorld();
    const { id } = await world.deployed(5_000_000n);
    const response = await world.request('POST', `/v1/mandates/${id}/revoke`);
    expect(response.status).toBe(200);
    const prepared = PreparedShape.parse(await response.json());
    expect(prepared.op).toBe('revoke');
    expect(prepared.instances[0]?.nextAction).toMatchObject({
      action: 'withdraw',
      amount: { amount: '5000000', asset: 'USDC' },
    });
  });

  it('the mandate state includes it too, once the revoke is on chain', async () => {
    const world = mandateWorld();
    const { id } = await world.deployed(5_000_000n);
    const prepared = PreparedShape.parse(
      await (await world.request('POST', `/v1/mandates/${id}/revoke`)).json(),
    );
    await world.signAndSubmit(prepared.instances[0]?.signingRequest as SigningRequestWire);
    const detail = MandateDetail.parse(
      await (await world.request('GET', `/v1/mandates/${id}`)).json(),
    );
    expect(detail.status).toBe('revoked');
    expect(detail.instances[0]?.nextAction).toMatchObject({
      action: 'withdraw',
      amount: { amount: '5000000' },
    });
  });

  it('names no next action when nothing is frozen', async () => {
    const world = mandateWorld();
    const { id } = await world.deployed();
    const prepared = PreparedShape.parse(
      await (await world.request('POST', `/v1/mandates/${id}/revoke`)).json(),
    );
    expect(prepared.instances[0]?.nextAction).toBeNull();
  });

  it('is refused while the mandate is still deploying', async () => {
    const world = mandateWorld();
    const created = (await (
      await world.request('POST', '/v1/mandates', world.createBody())
    ).json()) as { id: string };
    const response = await world.request('POST', `/v1/mandates/${created.id}/revoke`);
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe('MANDATE_REFUSED');
  });

  it("another principal's mandate is 404", async () => {
    const world = mandateWorld();
    const { id } = await world.deployed();
    const response = await world.request('POST', `/v1/mandates/${id}/revoke`, undefined, {
      authorization: 'Bearer intruder',
    });
    expect(response.status).toBe(404);
  });
});
