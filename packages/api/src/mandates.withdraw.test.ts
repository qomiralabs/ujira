// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import type { SigningRequestWire } from '@ujira/api-schema';
import { act } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { PreparedShape, mandateWorld, problemOf } from './mandates.test-support.js';

async function revoked(world: ReturnType<typeof mandateWorld>, fund = 5_000_000n) {
  const deployed = await world.deployed(fund);
  const prepared = PreparedShape.parse(
    await (await world.request('POST', `/v1/mandates/${deployed.id}/revoke`)).json(),
  );
  await world.signAndSubmit(prepared.instances[0]?.signingRequest as SigningRequestWire);
  return deployed;
}

describe('POST /v1/mandates/{id}/withdraw', () => {
  it('prepares the whole balance, and signing it pays the principal', async () => {
    const world = mandateWorld();
    const { id } = await revoked(world);
    const before = await world.h.balance(world.principal());
    const response = await world.request('POST', `/v1/mandates/${id}/withdraw`);
    expect(response.status).toBe(200);
    const prepared = PreparedShape.parse(await response.json());
    const request = prepared.instances[0]?.signingRequest as SigningRequestWire;
    expect(request.summary).toMatchObject({ action: 'withdraw', amount: { amount: '5000000' } });
    await world.signAndSubmit(request);
    expect((await world.h.balance(world.principal())) - before).toBe(5_000_000n);
  });

  it('TRANSFER_FAILED returns the fix code and a second prepare succeeds after the fix', async () => {
    const world = mandateWorld();
    const { id } = await revoked(world);
    world.h.faults?.transferFails(world.principal(), true);
    const refused = await world.request('POST', `/v1/mandates/${id}/withdraw`);
    expect(refused.status).toBe(422);
    const problem = await problemOf(refused);
    expect(problem.code).toBe('TRANSFER_FAILED');
    expect(problem.fixes).toEqual(['principal_trustline_missing']);
    expect(problem.detail).toContain('principal');

    world.h.faults?.transferFails(world.principal(), false);
    const again = await world.request('POST', `/v1/mandates/${id}/withdraw`);
    expect(again.status).toBe(200);
    const prepared = PreparedShape.parse(await again.json());
    await world.signAndSubmit(prepared.instances[0]?.signingRequest as SigningRequestWire);
    expect(await world.h.balance(world.principal())).toBe(5_000_000n);
  });

  it('names the other fix when the diagnosis says so', async () => {
    const world = mandateWorld({ transferFix: 'principal_unreceivable' });
    const { id } = await revoked(world);
    world.h.faults?.transferFails(world.principal(), true);
    const problem = await problemOf(await world.request('POST', `/v1/mandates/${id}/withdraw`));
    expect(problem.fixes).toEqual(['principal_unreceivable']);
  });

  it('nothing changes on chain while it is refused', async () => {
    const world = mandateWorld();
    const { id, address } = await revoked(world);
    world.h.faults?.transferFails(world.principal(), true);
    await world.request('POST', `/v1/mandates/${id}/withdraw`);
    expect(await world.h.balance(address)).toBe(5_000_000n);
  });

  it('a second run of one request hands back the same thing to sign', async () => {
    // Two apps with separate HTTP records stand for a process that died before it
    // could store its answer: only the unique constraint on the action row is left.
    const world = mandateWorld();
    const { id } = await revoked(world);
    const other = world.appOn(world.deps);
    const key = randomUUID();
    const send = (app: typeof other) =>
      app.request(`/v1/mandates/${id}/withdraw`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner', 'idempotency-key': key },
      });
    const first = PreparedShape.parse(await (await send(world.app)).json());
    const second = PreparedShape.parse(await (await send(other)).json());
    expect(second.instances[0]?.signingRequest.requestId).toBe(
      first.instances[0]?.signingRequest.requestId,
    );
  });

  it('is refused with nothing to withdraw', async () => {
    const world = mandateWorld();
    const { id } = await revoked(world, 0n);
    const response = await world.request('POST', `/v1/mandates/${id}/withdraw`);
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe('MANDATE_REFUSED');
  });

  it('is the contract rule to decide on an active mandate, which lets the principal', async () => {
    const world = mandateWorld();
    const { id } = await world.deployed(5_000_000n);
    const response = await world.request('POST', `/v1/mandates/${id}/withdraw`);
    expect(response.status).toBe(200);
  });

  it("another principal's mandate is 404", async () => {
    const world = mandateWorld();
    const { id } = await revoked(world);
    const response = await world.request('POST', `/v1/mandates/${id}/withdraw`, undefined, {
      authorization: 'Bearer intruder',
    });
    expect(response.status).toBe(404);
  });
});

describe('POST /v1/mandates/{id}/lower-fee-cap', () => {
  it('returns a signing request for lower_fee_cap', async () => {
    const world = mandateWorld();
    const { id } = await world.deployed();
    const response = await world.request('POST', `/v1/mandates/${id}/lower-fee-cap`, {
      maxFeeBps: 50,
    });
    expect(response.status).toBe(200);
    const prepared = PreparedShape.parse(await response.json());
    expect(prepared.op).toBe('lower_fee_cap');
    expect(prepared.instances[0]?.signingRequest).toMatchObject({
      summary: { action: 'lower_fee_cap' },
    });
  });

  it('refuses a cap above 100 before reaching the chain', async () => {
    const world = mandateWorld();
    const { id } = await world.deployed();
    const response = await world.request('POST', `/v1/mandates/${id}/lower-fee-cap`, {
      maxFeeBps: 101,
    });
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe('FEE_CAP_INVALID');
  });
});

describe('POST /v1/mandates/{id}/cancel-principal-proposal', () => {
  it('returns a signing request for cancel_principal_proposal', async () => {
    const world = mandateWorld();
    const { id, address } = await world.deployed();
    await act(
      world.h,
      { network: address.network, address, specVersion: 1 },
      { op: 'propose_principal', proposed: world.h.wallet('next-principal') },
      world.principal(),
    );
    const response = await world.request('POST', `/v1/mandates/${id}/cancel-principal-proposal`);
    expect(response.status).toBe(200);
    const prepared = PreparedShape.parse(await response.json());
    expect(prepared.instances[0]?.signingRequest).toMatchObject({
      summary: { action: 'cancel_principal_proposal' },
    });
  });
});
