// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import { RecipientDetail, RecipientPayoutMethod, RecipientSummaryView } from '@ujira/api-schema';
import { describe, expect, it } from 'vitest';

import { memoryIdempotencyStore } from './idempotency.js';
import {
  ACCOUNT,
  MUXED_123456,
  PERSON,
  TENANT_A,
  TENANT_B,
  memoryRecipientRecords,
  problemOf,
  recipientWorld,
} from './recipients.test-support.js';

const RECIPIENTS = '/v1/recipients';

const walletBody = (address: string = ACCOUNT) => ({
  method: 'stellar_wallet',
  destination: { network: 'stellar:testnet', address },
});

describe('POST /v1/recipients', () => {
  it('registers a recipient and sends back nothing personal', async () => {
    const world = recipientWorld();
    const response = await world.request('POST', RECIPIENTS, { country: 'KE', personal: PERSON });
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(RecipientSummaryView.parse(JSON.parse(text))).toMatchObject({
      country: 'KE',
      status: 'active',
    });
    for (const value of Object.values(PERSON)) expect(text).not.toContain(value);
  });

  it('stores personal data only encrypted', async () => {
    const records = memoryRecipientRecords();
    const world = recipientWorld(records);
    const id = await world.newRecipient({ country: 'KE', personal: PERSON });
    const held = records.storedPersonal(id);
    expect(held?.nonce).toHaveLength(12);
    const stored = held?.ciphertext.toString('latin1') ?? '';
    expect(stored).not.toBe('');
    for (const value of Object.values(PERSON)) expect(stored).not.toContain(value);
  });

  it('leaves no personal data in what idempotency stores, or in the logs', async () => {
    const world = recipientWorld();
    await world.newRecipient({ country: 'KE', reference: 'ada', personal: PERSON });
    const stored = JSON.stringify(world.idempotency.stored);
    expect(world.idempotency.stored).toHaveLength(1);
    const logs = JSON.stringify(world.logger.records);
    for (const value of Object.values(PERSON)) {
      expect(stored).not.toContain(value);
      expect(logs).not.toContain(value);
    }
  });

  it('recognizes a reference again, in its own project only', async () => {
    const world = recipientWorld();
    const body = { country: 'KE', reference: 'employee-7' };
    const first = await world.newRecipient(body);
    expect(await world.newRecipient(body)).toBe(first);
    const theirs = await world.request('POST', RECIPIENTS, body, {
      authorization: 'Bearer bravo',
    });
    expect(((await theirs.json()) as { id: string }).id).not.toBe(first);
  });

  it('a retry over HTTP gets the same answer', async () => {
    const world = recipientWorld();
    const headers = { 'idempotency-key': randomUUID() };
    const body = { country: 'KE' };
    const first = await world.request('POST', RECIPIENTS, body, headers);
    const second = await world.request('POST', RECIPIENTS, body, headers);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await second.text()).toBe(await first.text());
  });

  it('a second run after the HTTP record was lost finds the first run', async () => {
    // A second app with an empty HTTP record stands for a process that died before
    // it could store its answer: all that is left is the unique key on the row.
    const world = recipientWorld();
    const other = world.appOn(memoryIdempotencyStore());
    const key = randomUUID();
    const send = (app: typeof other) =>
      app.request(RECIPIENTS, {
        method: 'POST',
        headers: {
          authorization: 'Bearer alpha',
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({ country: 'KE' }),
      });
    const first = (await (await send(world.app)).json()) as { id: string };
    const second = (await (await send(other)).json()) as { id: string };
    expect(second.id).toBe(first.id);
    expect((await world.records.list(TENANT_A, { limit: 10 })).items).toHaveLength(1);
  });

  it('refuses a body with a field it does not know', async () => {
    const world = recipientWorld();
    const response = await world.request('POST', RECIPIENTS, { country: 'KE', extra: 1 });
    expect(response.status).toBe(400);
  });
});

describe('GET /v1/recipients/{id}', () => {
  it('reads personal data back, and how they are paid', async () => {
    const world = recipientWorld();
    const id = await world.newRecipient({ country: 'KE', personal: PERSON });
    await world.request('POST', `${RECIPIENTS}/${id}/methods`, walletBody());
    const detail = RecipientDetail.parse(
      await (await world.request('GET', `${RECIPIENTS}/${id}`)).json(),
    );
    expect(detail.personal).toEqual(PERSON);
    expect(detail.methods).toHaveLength(1);
  });

  it('reads null when none is held', async () => {
    const world = recipientWorld();
    const id = await world.newRecipient();
    const detail = RecipientDetail.parse(
      await (await world.request('GET', `${RECIPIENTS}/${id}`)).json(),
    );
    expect(detail.personal).toBeNull();
  });

  it("another principal's recipient is 404", async () => {
    const world = recipientWorld();
    const id = await world.newRecipient({ country: 'KE', personal: PERSON });
    const response = await world.request('GET', `${RECIPIENTS}/${id}`, undefined, {
      authorization: 'Bearer bravo',
    });
    expect(response.status).toBe(404);
    expect((await problemOf(response)).code).toBe('NOT_FOUND');
  });

  it('an unknown id reads the same', async () => {
    const world = recipientWorld();
    expect((await world.request('GET', `${RECIPIENTS}/${randomUUID()}`)).status).toBe(404);
  });
});

describe('POST /v1/recipients/{id}/methods', () => {
  it('adds a validated wallet destination', async () => {
    const world = recipientWorld();
    const id = await world.newRecipient();
    const response = await world.request('POST', `${RECIPIENTS}/${id}/methods`, walletBody());
    expect(response.status).toBe(201);
    expect(RecipientPayoutMethod.parse(await response.json())).toMatchObject({
      recipientId: id,
      method: 'stellar_wallet',
      rail: 'wallet',
      chain: 'stellar',
      destination: ACCOUNT,
      tag: null,
      hasDetails: false,
      status: 'active',
    });
  });

  it('malformed destination returns 422 with the identity error code', async () => {
    const world = recipientWorld();
    const id = await world.newRecipient();
    const response = await world.request(
      'POST',
      `${RECIPIENTS}/${id}/methods`,
      walletBody('not-a-stellar-address'),
    );
    expect(response.status).toBe(422);
    const problem = await problemOf(response);
    expect(problem.code).toBe('DESTINATION_INVALID');
    expect(problem.errors).toEqual([{ field: 'destination', code: 'invalid_value' }]);
  });

  it('stores a numeric memo as the muxed address, with its tag', async () => {
    const world = recipientWorld();
    const id = await world.newRecipient();
    const response = await world.request('POST', `${RECIPIENTS}/${id}/methods`, {
      method: 'stellar_wallet',
      destination: {
        network: 'stellar:testnet',
        address: ACCOUNT,
        memoType: 'id',
        memo: '123456',
      },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ destination: MUXED_123456, tag: '123456' });
  });

  it('encrypts a local method detail and never sends it back', async () => {
    const world = recipientWorld();
    const id = await world.newRecipient();
    const account = '0123456789';
    const response = await world.request('POST', `${RECIPIENTS}/${id}/methods`, {
      method: 'bank',
      destination: { network: 'stellar:testnet', address: ACCOUNT },
      details: { accountNumber: account },
    });
    const text = await response.text();
    expect(text).not.toContain(account);
    expect(JSON.parse(text)).toMatchObject({ rail: 'anchor', hasDetails: true });
    expect(JSON.stringify(world.idempotency.stored)).not.toContain(account);
  });

  it("another principal's recipient is 404, before anything is checked or stored", async () => {
    const world = recipientWorld();
    const id = await world.newRecipient();
    const response = await world.request('POST', `${RECIPIENTS}/${id}/methods`, walletBody(), {
      authorization: 'Bearer bravo',
    });
    expect(response.status).toBe(404);
    expect(await world.records.methods(TENANT_B, id)).toEqual([]);
    expect(await world.records.methods(TENANT_A, id)).toEqual([]);
  });
});
