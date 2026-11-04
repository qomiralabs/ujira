// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandate endpoints through the whole pipeline, on the fake chain adapter and
// in-memory records. Tests only: this file is left out of the build.

import { randomUUID } from 'node:crypto';

import { Problem } from '@ujira/api-schema';
import type { SigningRequestWire } from '@ujira/api-schema';
import type { ChainAddress, NetworkId, NetworksConfig, SigningRequest } from '@ujira/chain-adapter';
import { FAKE_GENESIS, fakeAdapterHarness } from '@ujira/chain-adapter/testing';
import {
  createMemoryGuardianOptOutStore,
  createMemoryManagedAgentKeys,
  createMemoryPrincipalInstances,
  createMemoryPrincipalKeyReader,
} from '@ujira/mandates';
import { z } from 'zod';

import { createApp } from './app.js';
import type { Authenticate } from './auth.js';
import { memoryIdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { createMandateEndpoints } from './mandate-service.js';
import type {
  MandateRecords,
  MandateServiceDeps,
  NewStoredMandate,
  StoredMandate,
  TransferFix,
} from './mandate-service.js';
import { allowEveryRequest } from './rate-limit.js';
import { mandateRoutes } from './routes/mandates.js';

const DAY = 86_400n;

export function memoryMandateRecords(): MandateRecords {
  const mandates = new Map<string, { tenant: string; mandate: StoredMandate; key: string }>();
  const actions = new Map<string, SigningRequestWire>();
  const tenantOf = (t: { principalId: string; projectId: string }) =>
    `${t.principalId}:${t.projectId}`;
  const byKey = (tenant: string, key: string) =>
    [...mandates.values()].find((row) => row.tenant === tenant && row.key === key)?.mandate;
  return {
    find: (tenant, id) => {
      const row = mandates.get(id);
      return Promise.resolve(row?.tenant === tenantOf(tenant) ? row.mandate : undefined);
    },
    findByCreationKey: (tenant, key) => Promise.resolve(byKey(tenantOf(tenant), key)),
    createOnce: (tenant, input: NewStoredMandate) => {
      const held = byKey(tenantOf(tenant), input.creationKey);
      if (held !== undefined) return Promise.resolve(held);
      const mandate: StoredMandate = {
        ...input,
        createdAt: new Date(Number(FAKE_GENESIS) * 1_000),
        instances: input.instances.map((instance) => ({ ...instance, id: randomUUID() })),
      };
      mandates.set(input.id, { tenant: tenantOf(tenant), mandate, key: input.creationKey });
      return Promise.resolve(mandate);
    },
    findAction: (tenant, key, instanceId) =>
      Promise.resolve(actions.get(`${tenantOf(tenant)}:${key}:${instanceId}`)),
    recordAction: (tenant, action) => {
      const id = `${tenantOf(tenant)}:${action.key}:${action.instanceId}`;
      const held = actions.get(id);
      if (held !== undefined) return Promise.resolve(held);
      actions.set(id, action.signingRequest);
      return Promise.resolve(action.signingRequest);
    },
  };
}

export interface MandateWorldOptions {
  /** Whether the networks configuration names an operations guardian. */
  readonly guardianConfigured?: boolean;
  /** Which fix a refused transfer to the principal needs. */
  readonly transferFix?: TransferFix;
  readonly records?: MandateRecords;
}

export function mandateWorld(options: MandateWorldOptions = {}) {
  const testnet = fakeAdapterHarness({ network: 'stellar:testnet' });
  const pubnet = fakeAdapterHarness({ network: 'stellar:pubnet' });
  const harnessOf = (network: NetworkId) => (network === pubnet.adapter.network ? pubnet : testnet);
  const h = testnet;
  const guardian = testnet.wallet('operations-guardian');
  const pubnetGuardian = pubnet.wallet('operations-guardian');
  const networks = (): NetworksConfig =>
    (options.guardianConfigured === false
      ? {}
      : {
          'stellar:testnet': { operationsGuardian: guardian.value },
          'stellar:pubnet': { operationsGuardian: pubnetGuardian.value },
        }) as unknown as NetworksConfig;
  const records = options.records ?? memoryMandateRecords();
  const logger = memoryLogger();
  const signing = createMemoryPrincipalKeyReader();
  const instances = createMemoryPrincipalInstances();
  const managedAgents = createMemoryManagedAgentKeys();
  const deps: MandateServiceDeps = {
    adapterFor: (network) => harnessOf(network).adapter,
    records,
    creation: {
      networks,
      optOuts: createMemoryGuardianOptOutStore(),
      managedAgents,
      principalKeys: { instances, signing },
    },
    chainDefaults: (network) => {
      const world = harnessOf(network);
      return {
        factory: world.factory,
        executors: world.executors,
        attester: new Uint8Array(32).fill(1),
      };
    },
    agreedFeeBps: () => Promise.resolve(50),
    diagnoseTransfer: () => Promise.resolve(options.transferFix ?? 'principal_trustline_missing'),
  };
  const authenticate: Authenticate = (credentials) => {
    const token = credentials.authorization?.replace(/^Bearer /, '');
    const scope =
      token === 'owner' ? testnet.scope : token === 'intruder' ? testnet.otherScope : null;
    if (scope === null) return Promise.resolve({ ok: false, code: 'TOKEN_INVALID' });
    return Promise.resolve({
      ok: true,
      tenant: {
        ...scope,
        tokenId: randomUUID(),
        scopes: ['mandates:read', 'mandates:write'],
      },
    });
  };
  const appOn = (serviceDeps: MandateServiceDeps) =>
    createApp({
      routes: mandateRoutes(createMandateEndpoints(serviceDeps)),
      authenticate,
      rateLimit: allowEveryRequest,
      idempotency: memoryIdempotencyStore(),
      logger,
    });
  const app = appOn(deps);

  const principal = (network: NetworkId = 'stellar:testnet'): ChainAddress =>
    harnessOf(network).wallet('principal');

  const chainBody = (network: NetworkId = 'stellar:testnet') => {
    const world = harnessOf(network);
    return {
      network,
      asset: 'USDC',
      principal: principal(network).value,
      agents: [world.wallet('agent').value],
      approvers: [],
      approvalsRequired: 0,
      guardians: [],
      recovery: [],
      recoveryThreshold: 0,
    };
  };

  const usd = (amount: string) => ({ amount, currency: 'USD', scale: 2 });

  const createBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Contractor payouts',
    recipientMode: 'allowlist',
    limits: {
      totalBudget: usd('1000000'),
      perPaymentCap: usd('100000'),
      perRecipientDailyCap: usd('200000'),
      // With no approvers the contract needs this above the payment cap.
      approvalThreshold: usd('100001'),
    },
    payoutTtlSeconds: 86_400,
    expiresAt: new Date(Number(FAKE_GENESIS + 30n * DAY) * 1_000).toISOString(),
    maxFeeBps: 100,
    countryPolicy: { mode: 'allow', countries: ['KE', 'NG'] },
    chains: [chainBody()],
    ...overrides,
  });

  const request = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        authorization: 'Bearer owner',
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** Signs what the API handed out, as the principal's wallet would, and submits it. */
  const signAndSubmit = async (
    wire: SigningRequestWire,
    wallet: ChainAddress = principal(wire.network),
  ): Promise<void> => {
    const world = harnessOf(wire.network);
    const signed = await world.sign(
      {
        ...wire,
        signer: { network: wire.network, value: wire.signer },
      } as unknown as SigningRequest,
      wallet,
    );
    await world.adapter.submitSigned(
      {
        scope: world.scope,
        requestId: wire.requestId,
        signed,
        correlationId: 'mandate-test',
      },
      { correlationId: 'mandate-test' },
    );
  };

  /** A mandate through the API, signed and on chain, and optionally funded. */
  const deployed = async (fund = 0n) => {
    const response = await request('POST', '/v1/mandates', createBody());
    const created = CreatedShape.parse(await response.json());
    const instance = created.instances[0];
    if (instance === undefined) throw new Error('expected an instance');
    await signAndSubmit(instance.signingRequest as SigningRequestWire);
    const address: ChainAddress = { network: instance.network, value: instance.address };
    if (fund > 0n) await h.fund(address, fund);
    return { id: created.id, instance, address };
  };

  return {
    h,
    pubnet,
    guardian,
    deps,
    records,
    logger,
    signing,
    instances,
    managedAgents,
    app,
    appOn,
    authenticate,
    principal,
    chainBody,
    createBody,
    usd,
    request,
    signAndSubmit,
    deployed,
  };
}

/** Enough of a creation response to read in a test; the route checks the rest. */
export const CreatedShape = z.looseObject({
  id: z.string(),
  operationsGuardian: z.unknown().optional(),
  instances: z.array(
    z.looseObject({
      id: z.string(),
      network: z.enum(['stellar:testnet', 'stellar:pubnet']),
      address: z.string(),
      signingRequest: z.looseObject({ kind: z.string(), requestId: z.string() }),
    }),
  ),
});

export const PreparedShape = z.looseObject({
  op: z.string(),
  instances: z.array(
    z.looseObject({
      instanceId: z.string(),
      signingRequest: z.looseObject({ requestId: z.string() }),
      nextAction: z
        .strictObject({
          action: z.literal('withdraw'),
          amount: z.looseObject({ amount: z.string() }),
        })
        .nullable(),
    }),
  ),
});

export async function problemOf(response: Response): Promise<Problem> {
  return Problem.parse(await response.json());
}
