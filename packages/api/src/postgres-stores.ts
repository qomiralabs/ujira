// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The token, rate limit and key lifecycle ports over the database package. Thin on purpose:
// every query lives in that package's repositories, and the time limit on each
// comes from the statement and lock timeouts every transaction opens with.

import { CountryPolicy, SigningRequestWire, toWireMoney } from '@ujira/api-schema';
import { chainOf } from '@ujira/chain-adapter';
import { settlementToken, usdToToken } from '@ujira/core';
import type { Money as CoreMoney, TokenAmount as CoreTokenAmount } from '@ujira/core';
import {
  apiTokenWarnings,
  apiTokens,
  audit,
  embedSessions,
  entryPoints,
  IdempotencyConflictError,
  idempotencyKeys,
  mandateActionRequests,
  mandateInstances,
  mandateTerms,
  mandates,
  payoutMethods,
  payouts,
  payoutViews,
  projects,
  rateLimits,
  recipientPii,
  recipients,
  securityEvents,
} from '@ujira/db';
import type {
  ApiToken,
  Database,
  MandateInstance,
  MandateTerms,
  Payout,
  PayoutMethod,
  PayoutMinimumMethod,
  Recipient,
} from '@ujira/db';

import { API_KEY_MAX_ACTIVE, rotatedExpiry } from './api-key-service.js';
import type { ApiKeyRecords, StoredApiKey } from './api-key-service.js';
import type { ApiKeyWarningRecords } from './api-key-warnings.js';
import type { IdempotencyStore } from './idempotency.js';
import { InstancePlan } from './mandate-service.js';
import type { MandateRecords, StoredInstance, StoredMandate } from './mandate-service.js';
import type { NewPayoutRequest, PayoutCreation, PayoutRecords } from './payout-service.js';
import { requestedMoney } from './payout-wire.js';
import type { BucketStore } from './rate-limit.js';
import type { RecipientRecords, StoredMethod, StoredRecipient } from './recipient-service.js';
import type { EmbedStore } from './routes/embed.js';
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
              network: instance.plan.network,
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

/**
 * Schedules a new payout's job, inside the transaction that wrote the payout, so
 * the two commit together or not at all. The worker's queue fills this in.
 */
export type PayoutScheduler = (tx: Tx, payout: Payout) => Promise<void>;

// What a key already made, against what a retry asks for. Compared field by
// field rather than by the stored hash, because a default method is worked out
// again on a retry and may have changed since.
function sameRequest(payout: Payout, request: NewPayoutRequest): boolean {
  const asked = toWireMoney(request.amount);
  const held = toWireMoney(requestedMoney(payout.requested));
  return (
    payout.mandateId === request.mandateId &&
    payout.recipientId === request.recipientId &&
    payout.taskId === request.taskId &&
    (request.method === null || payout.method === request.method) &&
    asked.amount === held.amount &&
    asked.currency === held.currency
  );
}

// The unit the project asks in: what the recipient must receive when the
// principal bears the cash-out cost, and otherwise US dollars held as the
// mandate's dollar token at par. A mandate with no single token cannot say which.
function requestedUnit(
  bearer: string,
  amount: CoreMoney,
  instances: readonly MandateInstance[],
): CoreMoney | CoreTokenAmount | 'amount_unit' | 'mandate_not_deployed' {
  if (bearer === 'principal') return amount;
  const units = new Set(instances.map((instance) => `${instance.asset}:${instance.chain}`));
  const [first] = instances;
  if (first === undefined || units.size !== 1) return 'mandate_not_deployed';
  if (amount.currency !== 'USD') return 'amount_unit';
  const token = settlementToken(first.asset, first.chain);
  return usdToToken(amount, token.asset, token.chain);
}

export function databasePayoutRecords(db: Database, schedule: PayoutScheduler): PayoutRecords {
  return {
    create: (tenant, request) =>
      db.tenant(tenant).transaction(async (tx): Promise<PayoutCreation> => {
        const held = await payouts.findByKey(tx, request.idempotencyKey);
        if (held !== undefined) {
          if (!sameRequest(held, request)) throw new IdempotencyConflictError();
          return { outcome: 'existing', payout: held };
        }
        const recipient = await recipients.get(tx, request.recipientId);
        if (recipient === undefined) return { outcome: 'recipient_not_found' };
        const mandate = await mandates.get(tx, request.mandateId);
        if (mandate === undefined) return { outcome: 'mandate_not_found' };
        if (recipient.status !== 'active') return { outcome: 'recipient_inactive' };
        const active = (await payoutMethods.listOf(tx, recipient.id)).filter(
          (method) => method.status === 'active',
        );
        const method =
          request.method === null
            ? active[0]?.method
            : active.find((one) => one.method === request.method)?.method;
        if (method === undefined) return { outcome: 'no_method' };
        const settings = await projects.settings(tx);
        if (settings === undefined) throw new Error('a tenant transaction has no project');
        const unit = requestedUnit(
          settings.cashoutCostBearer,
          request.amount,
          await mandateInstances.forMandate(tx, mandate.id),
        );
        if (unit === 'amount_unit' || unit === 'mandate_not_deployed') return { outcome: unit };
        const written = await payouts.create(tx, {
          idempotencyKey: request.idempotencyKey,
          recipientId: recipient.id,
          mandateId: mandate.id,
          method: method as PayoutMinimumMethod,
          requested: unit,
          taskId: request.taskId,
        });
        // A create that lost a race to the same key finds the winner's payout,
        // whose job the winner scheduled.
        if (!written.created) return { outcome: 'existing', payout: written.payout };
        await schedule(tx, written.payout);
        return { outcome: 'created', payout: written.payout };
      }),
    page: (tenant, filter, page) =>
      db.tenant(tenant).transaction((tx) => payoutViews.page(tx, filter, page)),
    get: (tenant, id) => db.tenant(tenant).transaction((tx) => payoutViews.get(tx, id)),
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

export function databaseEmbedStore(db: Database): EmbedStore {
  return {
    // Before a tenant is known, so these run through the entry points that can.
    find: (secretSha256) =>
      db.unscoped((tx) => entryPoints.authenticateEmbedToken(tx, secretSha256)),
    exchange: (swap) => db.unscoped((tx) => entryPoints.exchangeEmbedInvite(tx, swap)),
    recipientExists: async (tenant, recipientId) =>
      (await db.tenant(tenant).transaction((tx) => recipients.get(tx, recipientId))) !== undefined,
    create: async (tenant, row) => {
      await db.tenant(tenant).transaction((tx) =>
        embedSessions.create(tx, {
          kind: row.kind,
          tokenHash: row.secretSha256,
          tokenPrefix: row.prefix,
          recipientId: row.recipientId,
          purpose: row.purpose,
          allowedOrigins: row.allowedOrigins,
          createdByToken: row.createdByToken,
          expiresAt: row.expiresAt,
        }),
      );
    },
  };
}

export function databaseBucketStore(db: Database): BucketStore {
  return {
    take: (buckets) => db.unscoped((tx) => rateLimits.take(tx, buckets)),
  };
}

function storedKeyOf(token: ApiToken): StoredApiKey {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    rotatedFromId: token.rotatedFromId,
    createdAt: token.createdAt,
  };
}

// The key's id and that it is a key. Its name is a person's words, and the audit
// log keeps only what it needs.
function auditTarget(id: string): { readonly target_type: string; readonly target_id: string } {
  return { target_type: 'api_key', target_id: id };
}

export function databaseApiKeyRecords(db: Database): ApiKeyRecords {
  return {
    create: (tenant, key, actorId) =>
      db.tenant(tenant).transaction(async (tx) => {
        const created = await apiTokens.createWithinLimit(tx, key, API_KEY_MAX_ACTIVE);
        if (created === undefined) return null;
        await audit.record(tx, {
          action: 'api_key.created',
          actor: { kind: 'member', id: actorId },
          metadata: auditTarget(created.id),
        });
        return storedKeyOf(created);
      }),

    rotate: (tenant, rotation, actorId) =>
      db.tenant(tenant).transaction(async (tx) => {
        const old = await apiTokens.get(tx, rotation.id);
        if (old === undefined) return { outcome: 'not_found' as const };
        if (old.revokedAt !== null || old.expiresAt.getTime() <= rotation.now.getTime()) {
          return { outcome: 'not_rotatable' as const };
        }
        const next = await apiTokens.createSuccessor(tx, {
          ...(old.name === null ? {} : { name: old.name }),
          prefix: rotation.prefix,
          secretSha256: rotation.secretSha256,
          scopes: old.scopes,
          expiresAt: rotatedExpiry(old, rotation.now),
          rotatedFromId: old.id,
        });
        // This key has been rotated already, or another request just did it.
        if (next === undefined) return { outcome: 'not_rotatable' as const };
        const previousExpiresAt = await apiTokens.shortenExpiry(tx, old.id, rotation.overlapUntil);
        await audit.record(tx, {
          action: 'api_key.rotated',
          actor: { kind: 'member', id: actorId },
          metadata: auditTarget(old.id),
        });
        return {
          outcome: 'rotated' as const,
          key: storedKeyOf(next),
          previousExpiresAt: previousExpiresAt ?? old.expiresAt,
        };
      }),

    revoke: (tenant, id, actorId) =>
      db.tenant(tenant).transaction(async (tx) => {
        const revoked = await apiTokens.revoke(tx, id);
        if (revoked) {
          await audit.record(tx, {
            action: 'api_key.revoked',
            actor: { kind: 'member', id: actorId },
            metadata: auditTarget(id),
          });
        }
        const token = await apiTokens.get(tx, id);
        return token === undefined ? undefined : storedKeyOf(token);
      }),
  };
}

export function databaseApiKeyWarningRecords(db: Database): ApiKeyWarningRecords {
  return {
    targets: (after, limit) =>
      db.unscoped((tx) => entryPoints.apiTokensNearingExpiry(tx, after, limit)),
    key: (target) =>
      db.tenant(target).transaction(async (tx) => {
        const token = await apiTokens.get(tx, target.tokenId);
        return token === undefined
          ? undefined
          : {
              prefix: token.prefix,
              name: token.name,
              expiresAt: token.expiresAt,
              revokedAt: token.revokedAt,
            };
      }),
    claim: (target, thresholdDays, claimSeconds) =>
      db
        .tenant(target)
        .transaction((tx) =>
          apiTokenWarnings.claim(tx, { tokenId: target.tokenId, thresholdDays, claimSeconds }),
        ),
    markNotified: (target, thresholds) =>
      db.tenant(target).transaction(async (tx) => {
        for (const thresholdDays of thresholds) {
          await apiTokenWarnings.markNotified(tx, { tokenId: target.tokenId, thresholdDays });
        }
      }),
  };
}
