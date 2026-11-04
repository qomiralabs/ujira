// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The token and rate limit ports over the database package. Thin on purpose:
// every query lives in that package's repositories, and the time limit on each
// comes from the statement and lock timeouts every transaction opens with.

import { CountryPolicy, SigningRequestWire } from '@ujira/api-schema';
import { chainOf } from '@ujira/chain-adapter';
import { settlementToken } from '@ujira/core';
import {
  apiTokens,
  entryPoints,
  idempotencyKeys,
  mandateActionRequests,
  mandateInstances,
  mandateTerms,
  mandates,
  payoutMethods,
  rateLimits,
  recipientPii,
  recipients,
  securityEvents,
} from '@ujira/db';
import type { Database, MandateTerms, PayoutMethod, Recipient } from '@ujira/db';

import type { IdempotencyStore } from './idempotency.js';
import { InstancePlan } from './mandate-service.js';
import type { MandateRecords, StoredInstance, StoredMandate } from './mandate-service.js';
import type { BucketStore } from './rate-limit.js';
import type { RecipientRecords, StoredMethod, StoredRecipient } from './recipient-service.js';
import type { SecurityEventSink, TokenStore } from './token-auth.js';

export function databaseTokenStore(db: Database): TokenStore {
  return {
    // Before a tenant is known, so it runs through the one entry point that can.
    find: (prefix) => db.unscoped((tx) => entryPoints.authenticateToken(tx, prefix)),
    // The tenant comes from the row just found, never from the request.
    touchLastUsed: async (tenant, tokenId) => {
      await db.tenant(tenant).transaction((tx) => apiTokens.touchLastUsed(tx, tokenId));
    },
  };
}

/** Another run holds this creation key, so everything this one wrote rolls back. */
class CreationRaceLost extends Error {
  override readonly name = 'CreationRaceLost';
}

type Tx = Parameters<Parameters<Database['unscoped']>[0]>[0];

// The wire says block where the table and the attester say deny. Without a policy
// the row allows nobody, so a mandate always writes the one it was given.
function policyRow(policy: CountryPolicy): {
  readonly mode: 'allow' | 'deny';
  readonly countries: readonly string[];
} {
  return { mode: policy.mode === 'block' ? 'deny' : 'allow', countries: policy.countries };
}

async function storedMandate(tx: Tx, terms: MandateTerms): Promise<StoredMandate | undefined> {
  const mandate = await mandates.get(tx, terms.mandateId);
  if (mandate === undefined) return undefined;
  const creates = await mandateActionRequests.createsOf(tx, terms.mandateId);
  const instances: StoredInstance[] = [];
  for (const create of creates) {
    const instance = await mandateInstances.get(tx, create.mandateInstanceId);
    // The foreign key makes this unreachable under the same tenant context.
    if (instance === undefined) continue;
    instances.push({
      id: instance.id,
      address: instance.contractAddress,
      plan: InstancePlan.parse(create.instancePlan),
      signingRequest: SigningRequestWire.parse(create.signingRequest),
    });
  }
  return {
    id: mandate.id,
    name: mandate.name,
    recipientMode: terms.recipientMode,
    limits: terms.limits,
    countryPolicy: CountryPolicy.parse({
      mode: mandate.countryPolicy.mode === 'deny' ? 'block' : 'allow',
      countries: mandate.countryPolicy.countries,
    }),
    countryPolicyHash: terms.countryPolicyHash,
    maxFeeBps: terms.maxFeeBps,
    agreedFeeBps: terms.agreedFeeBps,
    payoutTtlSeconds: terms.payoutTtlSeconds,
    expiresAt: terms.expiresAt,
    createdAt: terms.createdAt,
    instances,
  };
}

export function databaseMandateRecords(db: Database): MandateRecords {
  const byCreationKey = (
    tenant: Parameters<MandateRecords['findByCreationKey']>[0],
    key: string,
  ): Promise<StoredMandate | undefined> =>
    db.tenant(tenant).transaction(async (tx) => {
      const terms = await mandateTerms.getByCreationKey(tx, key);
      return terms === undefined ? undefined : storedMandate(tx, terms);
    });
  return {
    find: (tenant, id) =>
      db.tenant(tenant).transaction(async (tx) => {
        const terms = await mandateTerms.get(tx, id);
        return terms === undefined ? undefined : storedMandate(tx, terms);
      }),
    findByCreationKey: byCreationKey,
    createOnce: async (tenant, input) => {
      try {
        const written = await db.tenant(tenant).transaction(async (tx) => {
          await mandates.create(tx, {
            id: input.id,
            name: input.name,
            countryPolicy: policyRow(input.countryPolicy),
          });
          const won = await mandateTerms.create(tx, {
            mandateId: input.id,
            creationKey: input.creationKey,
            recipientMode: input.recipientMode,
            limits: input.limits,
            countryPolicyHash: input.countryPolicyHash,
            maxFeeBps: input.maxFeeBps,
            agreedFeeBps: input.agreedFeeBps,
            payoutTtlSeconds: input.payoutTtlSeconds,
            expiresAt: input.expiresAt,
          });
          if (!won) throw new CreationRaceLost();
          for (const instance of input.instances) {
            const chain = chainOf(instance.plan.network);
            const token = settlementToken(instance.plan.asset, chain);
            const row = await mandateInstances.create(tx, {
              mandateId: input.id,
              chain,
              contractAddress: instance.address,
              specVersion: '1',
              asset: token.asset,
              scale: token.tokenScale,
            });
            await mandateActionRequests.record(tx, {
              mandateId: input.id,
              mandateInstanceId: row.id,
              op: 'create',
              idempotencyKey: input.creationKey,
              signingRequest: instance.signingRequest,
              instancePlan: instance.plan,
            });
          }
          const terms = await mandateTerms.get(tx, input.id);
          return terms === undefined ? undefined : storedMandate(tx, terms);
        });
        if (written !== undefined) return written;
      } catch (error) {
        if (!(error instanceof CreationRaceLost)) throw error;
      }
      const winner = await byCreationKey(tenant, input.creationKey);
      // A key is never given up once held, so its row must be there.
      if (winner === undefined) throw new CreationRaceLost();
      return winner;
    },
    findAction: (tenant, key, instanceId) =>
      db.tenant(tenant).transaction(async (tx) => {
        const row = await mandateActionRequests.find(tx, key, instanceId);
        return row === undefined ? undefined : SigningRequestWire.parse(row.signingRequest);
      }),
    recordAction: (tenant, action) =>
      db.tenant(tenant).transaction(async (tx) => {
        const row = await mandateActionRequests.record(tx, {
          mandateId: action.mandateId,
          mandateInstanceId: action.instanceId,
          op: action.op,
          idempotencyKey: action.key,
          signingRequest: action.signingRequest,
          instancePlan: null,
        });
        return SigningRequestWire.parse(row.signingRequest);
      }),
  };
}

function storedRecipientOf(recipient: Recipient): StoredRecipient {
  return {
    id: recipient.id,
    country: recipient.country,
    status: recipient.status,
    createdAt: recipient.createdAt,
  };
}

function storedMethodOf(method: PayoutMethod): StoredMethod {
  return {
    id: method.id,
    recipientId: method.recipientId,
    method: method.method,
    rail: method.rail,
    chain: method.chain,
    destinationAddress: method.destinationAddress,
    destinationTag: method.destinationTag,
    // Only that there are details: their ciphertext stops at this layer.
    hasDetails: method.details !== null,
    status: method.status,
  };
}

export function databaseRecipientRecords(db: Database): RecipientRecords {
  return {
    createOnce: (tenant, recipient) =>
      db.tenant(tenant).transaction(async (tx) => {
        const won = await recipients.createOnce(tx, {
          id: recipient.id,
          recipientRef: recipient.recipientRef,
          country: recipient.country,
        });
        // In one transaction, so a recipient never exists without what it was given,
        // and whoever lost the race leaves the first run's personal data alone.
        if (won && recipient.personal !== null) {
          await recipientPii.put(tx, recipient.id, recipient.personal);
        }
        const stored = await recipients.getByRef(tx, recipient.recipientRef);
        if (stored === undefined) throw new Error('a recipient just written cannot be read back');
        return storedRecipientOf(stored);
      }),
    find: (tenant, id) =>
      db.tenant(tenant).transaction(async (tx) => {
        const stored = await recipients.get(tx, id);
        return stored === undefined ? undefined : storedRecipientOf(stored);
      }),
    list: (tenant, page) =>
      db.tenant(tenant).transaction(async (tx) => {
        const listed = await recipients.list(tx, page);
        return { items: listed.items.map(storedRecipientOf), next: listed.next };
      }),
    personal: (tenant, id) => db.tenant(tenant).transaction((tx) => recipientPii.get(tx, id)),
    methods: (tenant, id) =>
      db.tenant(tenant).transaction(async (tx) => {
        const listed = await payoutMethods.listOf(tx, id);
        return listed.map(storedMethodOf);
      }),
    addMethod: (tenant, method) =>
      db.tenant(tenant).transaction(async (tx) => {
        const created = await payoutMethods.create(tx, method);
        return storedMethodOf(created);
      }),
  };
}

export function databaseSecurityEvents(db: Database): SecurityEventSink {
  // Unscoped, because a refused key has no tenant anyone can trust.
  return (event) => db.unscoped((tx) => securityEvents.record(tx, event));
}

export function databaseIdempotencyStore(db: Database): IdempotencyStore {
  return {
    reserve: (tenant, request) =>
      db.tenant(tenant).transaction((tx) => idempotencyKeys.reserve(tx, request)),
    complete: (tenant, request) =>
      db.tenant(tenant).transaction((tx) => idempotencyKeys.complete(tx, request)),
    release: (tenant, request) =>
      db.tenant(tenant).transaction((tx) => idempotencyKeys.release(tx, request)),
  };
}

export function databaseBucketStore(db: Database): BucketStore {
  return {
    take: (buckets) => db.unscoped((tx) => rateLimits.take(tx, buckets)),
  };
}
