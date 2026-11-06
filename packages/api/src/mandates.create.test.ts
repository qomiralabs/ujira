// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import { MandateCreated } from '@ujira/api-schema';
import { describe, expect, it } from 'vitest';

import { CreatedShape, mandateWorld, problemOf } from './mandates.test-support.js';

const MANDATES = '/v1/mandates';

describe('POST /v1/mandates', () => {
  it('returns one signing request per chain', async () => {
    const world = mandateWorld();
    const response = await world.request(
      'POST',
      MANDATES,
      world.createBody({
        chains: [world.chainBody('stellar:testnet'), world.chainBody('stellar:pubnet')],
      }),
    );
    expect(response.status).toBe(201);
    const created = MandateCreated.parse(await response.json());
    expect(created.instances.map((instance) => instance.network)).toEqual([
      'stellar:testnet',
      'stellar:pubnet',
    ]);
    for (const instance of created.instances) {
      expect(instance.signingRequest.network).toBe(instance.network);
      expect(instance.signingRequest.summary.action).toBe('create');
      expect(instance.signingRequest.summary.mandateAddress).toBe(instance.address);
    }
  });

  it('what it hands out, signed, deploys at the address it named', async () => {
    const world = mandateWorld();
    const { address } = await world.deployed();
    const read = await world.h.adapter.readMandate(
      {
        scope: world.h.scope,
        mandate: { network: address.network, address, specVersion: 1 },
      },
      { correlationId: 'test' },
    );
    expect(read.trustedFactory).toBe(true);
  });

  it('shows the fee cap with the agreed rate, before anything is signed', async () => {
    const world = mandateWorld();
    const response = await world.request('POST', MANDATES, world.createBody({ maxFeeBps: 75 }));
    expect(await response.json()).toMatchObject({ maxFeeBps: 75, agreedFeeBps: 50 });
  });

  it('max_fee_bps 101 returns 422', async () => {
    const world = mandateWorld();
    const response = await world.request('POST', MANDATES, world.createBody({ maxFeeBps: 101 }));
    expect(response.status).toBe(422);
    const problem = await problemOf(response);
    expect(problem.code).toBe('FEE_CAP_INVALID');
    expect(problem.errors).toEqual([{ field: 'maxFeeBps', code: 'invalid_value' }]);
  });

  it('takes a fee cap of exactly 100', async () => {
    const world = mandateWorld();
    const response = await world.request('POST', MANDATES, world.createBody({ maxFeeBps: 100 }));
    expect(response.status).toBe(201);
  });

  it('carries amounts as decimal strings, and refuses them as numbers', async () => {
    const world = mandateWorld();
    const body = world.createBody();
    const response = await world.request('POST', MANDATES, {
      ...body,
      limits: { ...body.limits, totalBudget: { amount: 1000000, currency: 'USD', scale: 2 } },
    });
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('INVALID_REQUEST');
  });
});

describe('the operations guardian', () => {
  it('response includes operationsGuardian present or absent', async () => {
    const world = mandateWorld();
    const included = await world.request('POST', MANDATES, world.createBody());
    expect(MandateCreated.parse(await included.json()).instances[0]?.operationsGuardian).toBe(
      'present',
    );
    const left = await world.request('POST', MANDATES, world.createBody({ guardian: false }));
    expect(MandateCreated.parse(await left.json()).instances[0]?.operationsGuardian).toBe('absent');
  });

  it('is on chain when the response says present', async () => {
    const world = mandateWorld();
    const { address } = await world.deployed();
    const read = await world.h.adapter.readMandate(
      { scope: world.h.scope, mandate: { network: address.network, address, specVersion: 1 } },
      { correlationId: 'test' },
    );
    expect(read.config.guardians.map((g) => g.value)).toContain(world.guardian.value);
  });

  it('none configured is our gap, not the client mistake: 503, with a retry and a log', async () => {
    const world = mandateWorld({ guardianConfigured: false });
    const response = await world.request('POST', MANDATES, world.createBody());
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect((await problemOf(response)).code).toBe('OPERATIONS_GUARDIAN_NOT_CONFIGURED');
    expect(world.logger.records.find((r) => r.event === 'request_failed')).toMatchObject({
      level: 'error',
      errorName: 'OperationsGuardianNotConfiguredError',
    });
  });

  it('none configured does not stop a principal who opted out', async () => {
    const world = mandateWorld({ guardianConfigured: false });
    const response = await world.request('POST', MANDATES, world.createBody({ guardian: false }));
    expect(response.status).toBe(201);
    expect(MandateCreated.parse(await response.json()).instances[0]?.operationsGuardian).toBe(
      'absent',
    );
  });
});

describe('the principal key rule', () => {
  it('carries the warning, so the dashboard can warn at any budget', async () => {
    const world = mandateWorld();
    const response = await world.request('POST', MANDATES, world.createBody());
    expect(MandateCreated.parse(await response.json()).instances[0]?.warnings).toEqual([
      'single_key_principal',
    ]);
  });

  it('refuses a single key above 50,000 USD, and states the three fixes', async () => {
    const world = mandateWorld();
    const body = world.createBody();
    const response = await world.request('POST', MANDATES, {
      ...body,
      limits: { ...body.limits, totalBudget: world.usd('5000001') },
    });
    expect(response.status).toBe(422);
    const problem = await problemOf(response);
    expect(problem.code).toBe('PRINCIPAL_KEY_RISK');
    expect(problem.fixes).toEqual(['add_recovery_set', 'use_multisig_principal', 'lower_budget']);
  });
});

describe('the custody guard', () => {
  it('refuses attested only with the managed agent option', async () => {
    const world = mandateWorld();
    const response = await world.request(
      'POST',
      MANDATES,
      world.createBody({ recipientMode: 'attested', managedAgent: true }),
    );
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe('CUSTODY_GUARD');
  });

  it('refuses a managed agent named as if it were the principal own', async () => {
    const world = mandateWorld();
    const chain = world.chainBody();
    world.managedAgents.add(world.h.scope, {
      network: chain.network,
      value: chain.agents[0] ?? '',
    });
    const response = await world.request(
      'POST',
      MANDATES,
      world.createBody({ recipientMode: 'attested', chains: [chain] }),
    );
    expect((await problemOf(response)).code).toBe('CUSTODY_GUARD');
  });

  it('allows the managed agent option in allowlist mode', async () => {
    const world = mandateWorld();
    const response = await world.request(
      'POST',
      MANDATES,
      world.createBody({ managedAgent: true }),
    );
    expect(response.status).toBe(201);
  });
});

describe('running twice', () => {
  it('a retry over HTTP gets the same answer, without a second mandate', async () => {
    const world = mandateWorld();
    const key = randomUUID();
    const headers = { 'idempotency-key': key };
    const body = world.createBody();
    const first = await world.request('POST', MANDATES, body, headers);
    const second = await world.request('POST', MANDATES, body, headers);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await second.text()).toBe(await first.text());
  });

  it('a second run after the HTTP record was lost finds the first run and its contract', async () => {
    // Two apps with separate HTTP records stand for a process that died before it
    // could store its answer: what is left is the mandate tables.
    const world = mandateWorld();
    const other = world.appOn(world.deps);
    const key = randomUUID();
    const send = (app: typeof other) =>
      app.request(MANDATES, {
        method: 'POST',
        headers: {
          authorization: 'Bearer owner',
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(world.createBody()),
      });
    const first = CreatedShape.parse(await (await send(world.app)).json());
    const second = CreatedShape.parse(await (await send(other)).json());
    expect(second.id).toBe(first.id);
    expect(second.instances[0]?.address).toBe(first.instances[0]?.address);
    expect(second.instances[0]?.signingRequest.requestId).toBe(
      first.instances[0]?.signingRequest.requestId,
    );
  });

  it('a different key makes a different mandate at a different address', async () => {
    const world = mandateWorld();
    const body = world.createBody();
    const first = CreatedShape.parse(await (await world.request('POST', MANDATES, body)).json());
    const second = CreatedShape.parse(await (await world.request('POST', MANDATES, body)).json());
    expect(second.id).not.toBe(first.id);
    expect(second.instances[0]?.address).not.toBe(first.instances[0]?.address);
  });

  it('needs a key like every write', async () => {
    const world = mandateWorld();
    const response = await world.app.request(MANDATES, {
      method: 'POST',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify(world.createBody()),
    });
    expect((await problemOf(response)).code).toBe('IDEMPOTENCY_KEY_INVALID');
  });
});
