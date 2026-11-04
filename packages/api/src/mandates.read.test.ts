// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { MandateDetail, MandateFunding, assertResponseMatchesSchema } from '@ujira/api-schema';
import { act } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { CreatedShape, mandateWorld, problemOf } from './mandates.test-support.js';

// Every value in a JSON document named `amount`, wherever it sits.
function amountsIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(amountsIn);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) =>
    key === 'amount' ? [inner] : amountsIn(inner),
  );
}

describe('GET /v1/mandates/{id}', () => {
  it('matches the contract', async () => {
    const world = mandateWorld();
    const { id } = await world.deployed(5_000_000n);
    const response = await world.request('GET', `/v1/mandates/${id}`);
    expect(response.status).toBe(200);
    await expect(assertResponseMatchesSchema('getMandate', response)).resolves.toBeDefined();
  });

  it('every amount is a decimal string', async () => {
    const world = mandateWorld();
    const { id } = await world.deployed(5_000_000n);
    const body: unknown = await (await world.request('GET', `/v1/mandates/${id}`)).json();
    const amounts = amountsIn(body);
    expect(amounts.length).toBeGreaterThan(5);
    for (const amount of amounts) expect(amount).toMatch(/^(0|[1-9][0-9]*)$/);
  });

  it("another principal's mandate is 404", async () => {
    const world = mandateWorld();
    const { id } = await world.deployed();
    const response = await world.request('GET', `/v1/mandates/${id}`, undefined, {
      authorization: 'Bearer intruder',
    });
    expect(response.status).toBe(404);
    expect((await problemOf(response)).code).toBe('NOT_FOUND');
  });

  it('an unknown id reads the same as another tenant', async () => {
    const world = mandateWorld();
    const response = await world.request(
      'GET',
      '/v1/mandates/0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
    );
    expect(response.status).toBe(404);
  });

  it('reads as deploying until it is on chain, with what was asked for', async () => {
    const world = mandateWorld();
    const created = CreatedShape.parse(
      await (await world.request('POST', '/v1/mandates', world.createBody())).json(),
    );
    const detail = MandateDetail.parse(
      await (await world.request('GET', `/v1/mandates/${created.id}`)).json(),
    );
    expect(detail.status).toBe('draft');
    const [instance] = detail.instances;
    expect(instance).toMatchObject({
      status: 'deploying',
      fundingAddress: null,
      operationsGuardian: 'present',
      nextAction: null,
    });
    expect(instance?.roles.map((role) => role.role)).toContain('guardian');
    expect(detail.warnings).toEqual(['single_key_principal']);
  });

  it('reads the chain once it is deployed', async () => {
    const world = mandateWorld();
    const { id, address } = await world.deployed(5_000_000n);
    const detail = MandateDetail.parse(
      await (await world.request('GET', `/v1/mandates/${id}`)).json(),
    );
    expect(detail.status).toBe('active');
    expect(detail.countryPolicyHashMatches).toBe(true);
    const [instance] = detail.instances;
    expect(instance).toMatchObject({
      status: 'active',
      fundingAddress: address.value,
      operationsGuardian: 'present',
      proposedPrincipal: null,
      sweepGraceEndsAt: null,
      nextAction: null,
    });
  });

  it('includes a pending principal proposal', async () => {
    const world = mandateWorld();
    const { id, address } = await world.deployed();
    const proposed = world.h.wallet('next-principal');
    await act(
      world.h,
      { network: address.network, address, specVersion: 1 },
      { op: 'propose_principal', proposed },
      world.principal(),
    );
    const detail = MandateDetail.parse(
      await (await world.request('GET', `/v1/mandates/${id}`)).json(),
    );
    expect(detail.instances[0]?.proposedPrincipal).toBe(proposed.value);
  });

  it('gives an expired mandate its sweep grace end date, 30 days after expiry', async () => {
    const world = mandateWorld();
    const { id } = await world.deployed();
    await world.h.advance(31n * 86_400n);
    const detail = MandateDetail.parse(
      await (await world.request('GET', `/v1/mandates/${id}`)).json(),
    );
    const [instance] = detail.instances;
    expect(instance?.status).toBe('expired');
    expect(instance?.sweepGraceEndsAt).not.toBeNull();
    expect(
      Date.parse(instance?.sweepGraceEndsAt ?? '') - Date.parse(instance?.expiresAt ?? ''),
    ).toBe(2_592_000_000);
  });

  it('warns about a single key principal once it is deployed too', async () => {
    const world = mandateWorld();
    const { id } = await world.deployed();
    const detail = MandateDetail.parse(
      await (await world.request('GET', `/v1/mandates/${id}`)).json(),
    );
    expect(detail.warnings).toEqual(['single_key_principal']);
  });
});

describe('GET /v1/mandates/{id}/funding', () => {
  it('gives each instance its instructions', async () => {
    const world = mandateWorld();
    const { id, address, instance } = await world.deployed();
    const funding = MandateFunding.parse(
      await (await world.request('GET', `/v1/mandates/${id}/funding`)).json(),
    );
    expect(funding.instances).toEqual([
      {
        instanceId: instance.id,
        network: address.network,
        instructions: expect.objectContaining({
          address: address.value,
          asset: 'USDC',
          memoRequired: false,
        }) as unknown,
      },
    ]);
  });

  it('gives none until the mandate is deployed, so nobody funds an empty address', async () => {
    const world = mandateWorld();
    const created = CreatedShape.parse(
      await (await world.request('POST', '/v1/mandates', world.createBody())).json(),
    );
    const funding = MandateFunding.parse(
      await (await world.request('GET', `/v1/mandates/${created.id}/funding`)).json(),
    );
    expect(funding.instances[0]?.instructions).toBeNull();
  });

  it("another principal's mandate is 404", async () => {
    const world = mandateWorld();
    const { id } = await world.deployed();
    const response = await world.request('GET', `/v1/mandates/${id}/funding`, undefined, {
      authorization: 'Bearer intruder',
    });
    expect(response.status).toBe(404);
  });
});
