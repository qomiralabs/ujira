// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The identity service's ports over the repositories. The service decides who
// may be paid; these read and write the rows it decides on, each in a
// transaction of the caller's tenant, so another tenant's id reads as absent.
// The conversion between rows and the service's records happens here and
// nowhere else.

import type {
  Bytes32,
  CountryCode,
  NetworkId,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { isRailId } from '@ujira/chain-adapter';
import {
  AttestationConflictError,
  AttestationStateError,
  IDENTITY_PROVIDERS,
  IdentityConflictError,
  VERIFICATION_LEVELS,
} from '@ujira/identity';
import type {
  Assurance,
  AttestationLog,
  AttestationRecord,
  DestinationVerificationRecord,
  IdentityProviderName,
  IdentityRecord,
  IdentityStatus,
  IdentityStore,
  IdentityUpdate,
  IdentityWriteStore,
  MandateInstanceRecord,
  MandateInstanceStatus,
  PayoutLegSource,
  PayoutMethodRecord,
  ProviderEventStore,
  RecipientRecord,
  VerificationLevel,
} from '@ujira/identity';

import type { Kysely } from 'kysely';

import type { Database } from './database.js';
import { attestations, destinationVerifications } from './repositories/identity-evidence.js';
import type { DestinationVerification } from './repositories/identity-evidence.js';
import { mandateInstances, mandates } from './repositories/mandates.js';
import { identityProviderEvents } from './repositories/ops.js';
import { payoutLegs } from './repositories/payout-legs.js';
import { payoutMethods, recipientIdentities, recipients } from './repositories/recipients.js';
import type { IdentityChange, RecipientIdentity } from './repositories/recipients.js';
import { projects } from './repositories/tenancy.js';
import type { Schema } from './schema.generated.js';

export interface IdentityStoreOptions {
  /**
   * The network this deployment pays on, per chain. A payout method records only
   * its chain, because an address reads the same on every network of a chain, so
   * which network it is paid on is the deployment's to say. A chain missing here
   * has no methods the service can see.
   */
  readonly networkOfChain: Readonly<Record<string, NetworkId>>;
}

// An instance stored before its hash was kept compares unequal to every real hash,
// so the attester refuses it as a policy mismatch rather than signing for it.
const NO_POLICY_HASH = `0x${'0'.repeat(64)}` as Bytes32;

// A principal-wide read names no project, and the context wants one.
const NO_PROJECT = '00000000-0000-0000-0000-000000000000';

const PROVIDERS: ReadonlySet<string> = new Set(IDENTITY_PROVIDERS);
const LEVELS: ReadonlySet<string> = new Set(VERIFICATION_LEVELS);

function bytes32Of(buffer: Buffer): Bytes32 {
  return `0x${buffer.toString('hex')}` as Bytes32;
}

function bufferOfHex(text: string): Buffer {
  return Buffer.from(text.startsWith('0x') ? text.slice(2) : text, 'hex');
}

function secondsOf(date: Date): UnixSeconds {
  return BigInt(Math.floor(date.getTime() / 1000)) as UnixSeconds;
}

function dateOf(seconds: UnixSeconds): Date {
  return new Date(Number(seconds) * 1000);
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

function constraintOf(error: unknown): unknown {
  return (error as { constraint?: unknown }).constraint;
}

// Deploying and a failed deploy both mean the instance cannot pay yet.
function instanceStatusOf(status: string): MandateInstanceStatus {
  switch (status) {
    case 'active':
    case 'paused':
    case 'revoked':
    case 'expired':
      return status;
    default:
      return 'pending';
  }
}

function toRecipient(
  scope: TenantScope,
  row: { id: string; recipientRef: Buffer; country: string; status: string },
): RecipientRecord {
  return {
    scope,
    id: row.id as Uuid,
    recipientRef: bytes32Of(row.recipientRef),
    country: row.country as CountryCode,
    // Suspended and erased recipients are both ones nobody pays.
    status: row.status === 'active' ? 'active' : 'inactive',
  };
}

function toIdentity(scope: TenantScope, row: RecipientIdentity): IdentityRecord | null {
  // Rows written per chain by the older upsert are for providers the service does
  // not read.
  if (!PROVIDERS.has(row.provider)) return null;
  return {
    scope,
    id: row.id as Uuid,
    recipientId: row.recipientId as Uuid,
    provider: row.provider as IdentityProviderName,
    providerAccount: row.providerAccount,
    status: row.state as IdentityStatus,
    assurance: row.assurance as Assurance,
    expiresAt: row.expiresAt === null ? null : secondsOf(row.expiresAt),
    providerRef: row.providerRef,
    providerStatus: row.providerStatus,
    flowRef: row.flowRef,
    nullifierHmac: row.nullifierHmac === null ? null : row.nullifierHmac.toString('hex'),
    pendingSession:
      row.pendingSessionId === null ||
      row.pendingSessionUrl === null ||
      row.pendingSessionExpiresAt === null
        ? null
        : {
            sessionId: row.pendingSessionId,
            url: row.pendingSessionUrl,
            expiresAt: secondsOf(row.pendingSessionExpiresAt),
          },
    failureReason: row.failureReason,
    rawSha256: row.rawSha256 === null ? null : row.rawSha256.toString('hex'),
    lastCheckedAt: row.lastCheckedAt === null ? null : secondsOf(row.lastCheckedAt),
  };
}

// Only what the patch names, so an update never writes back a stale copy.
function changeOf(patch: IdentityUpdate): IdentityChange {
  const session = patch.pendingSession;
  return {
    ...(patch.status === undefined ? {} : { state: patch.status }),
    ...(patch.assurance === undefined ? {} : { assurance: patch.assurance }),
    ...(patch.expiresAt === undefined
      ? {}
      : { expiresAt: patch.expiresAt === null ? null : dateOf(patch.expiresAt) }),
    ...(patch.providerRef === undefined ? {} : { providerRef: patch.providerRef }),
    ...(patch.providerStatus === undefined ? {} : { providerStatus: patch.providerStatus }),
    ...(patch.flowRef === undefined ? {} : { flowRef: patch.flowRef }),
    ...(patch.nullifierHmac === undefined
      ? {}
      : {
          nullifierHmac: patch.nullifierHmac === null ? null : bufferOfHex(patch.nullifierHmac),
        }),
    ...(session === undefined
      ? {}
      : {
          pendingSessionId: session?.sessionId ?? null,
          pendingSessionUrl: session?.url ?? null,
          pendingSessionExpiresAt: session === null ? null : dateOf(session.expiresAt),
        }),
    ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
    ...(patch.rawSha256 === undefined
      ? {}
      : { rawSha256: patch.rawSha256 === null ? null : bufferOfHex(patch.rawSha256) }),
    ...(patch.lastCheckedAt === undefined
      ? {}
      : { lastCheckedAt: patch.lastCheckedAt === null ? null : dateOf(patch.lastCheckedAt) }),
  };
}

/** The recipients, methods, mandate instances, identities and evidence the service reads. */
export function databaseIdentityStore(
  db: Database,
  options: IdentityStoreOptions,
): IdentityStore & IdentityWriteStore {
  const networkOf = (chain: string): NetworkId | null => options.networkOfChain[chain] ?? null;

  function toVerification(
    scope: TenantScope,
    row: DestinationVerification,
  ): DestinationVerificationRecord | null {
    const network = networkOf(row.chain);
    if (network === null || !LEVELS.has(row.level)) return null;
    return {
      scope,
      id: row.id as Uuid,
      methodId: row.methodId as Uuid,
      level: row.level as VerificationLevel,
      destination: {
        address: { network, value: row.destinationAddress },
        tag: row.destinationTag,
      },
      signerKey: row.signerKey,
      derivedFrom: row.derivedFrom === null ? null : (row.derivedFrom as Uuid),
      recordedAt: secondsOf(row.recordedAt),
      scheme: row.scheme,
      challengeId: row.challengeId === null ? null : (row.challengeId as Uuid),
      signature: row.signature,
      partnerRef: row.partnerRef,
    };
  }

  return {
    recipient: (scope, recipientId) =>
      db.tenant(scope).transaction(async (tx) => {
        const row = await recipients.get(tx, recipientId);
        return row === undefined ? null : toRecipient(scope, row);
      }),

    payoutMethod: (scope, methodId) =>
      db.tenant(scope).transaction(async (tx): Promise<PayoutMethodRecord | null> => {
        const method = await payoutMethods.get(tx, methodId);
        if (method === undefined) return null;
        const network = networkOf(method.chain);
        // Anchor rails carry the anchor that runs the recipient's KYC, which methods
        // do not record yet, so an anchor method is not one the service can pay.
        const rail = `${method.chain}.${method.rail}`;
        if (network === null || method.rail !== 'wallet' || !isRailId(rail)) return null;
        // A method pays its recipient where the recipient is.
        const recipient = await recipients.get(tx, method.recipientId);
        if (recipient === undefined) return null;
        return {
          scope,
          id: method.id as Uuid,
          recipientId: method.recipientId as Uuid,
          network,
          rail,
          country: recipient.country as CountryCode,
          destination: {
            address: { network, value: method.destinationAddress },
            tag: method.destinationTag,
          },
          anchorId: null,
          status: method.status === 'active' ? 'active' : 'disabled',
        };
      }),

    mandateInstance: (scope, instanceId) =>
      db.tenant(scope).transaction(async (tx): Promise<MandateInstanceRecord | null> => {
        const instance = await mandateInstances.get(tx, instanceId);
        // A version this code does not know is one it cannot vouch for.
        if (instance?.specVersion !== '1') return null;
        const mandate = await mandates.get(tx, instance.mandateId);
        if (mandate === undefined) return null;
        const network = instance.network as NetworkId;
        return {
          scope,
          id: instance.id as Uuid,
          mandate: {
            network,
            address: { network, value: instance.contractAddress },
            specVersion: 1,
          },
          status: instanceStatusOf(instance.status),
          // The attester key is set exactly when the mandate takes attestations.
          recipientMode: instance.attesterPublicKey === null ? 'allowlist' : 'attested',
          countryPolicy: {
            mode: mandate.countryPolicy.mode === 'deny' ? 'deny' : 'allow',
            countries: mandate.countryPolicy.countries as readonly CountryCode[],
          },
          countryPolicyHash:
            instance.countryPolicyHash === null
              ? NO_POLICY_HASH
              : bytes32Of(instance.countryPolicyHash),
        };
      }),

    identities: (scope, recipientId) =>
      db.tenant(scope).transaction(async (tx) => {
        const rows = await recipientIdentities.list(tx, recipientId);
        return rows.flatMap((row) => {
          const record = toIdentity(scope, row);
          return record === null ? [] : [record];
        });
      }),

    projectSettings: (scope) =>
      db.tenant(scope).transaction(async (tx) => projects.identitySettings(tx)),

    latestVerification: (scope, methodId) =>
      db.tenant(scope).transaction(async (tx) => {
        const row = await destinationVerifications.latest(tx, methodId);
        return row === undefined ? null : toVerification(scope, row);
      }),

    verification: (scope, verificationId) =>
      db.tenant(scope).transaction(async (tx) => {
        const row = await destinationVerifications.get(tx, verificationId);
        return row === undefined ? null : toVerification(scope, row);
      }),

    async identityById(identityId) {
      const found = await db.unscoped(async (tx) => recipientIdentities.scopeOf(tx, identityId));
      if (found === undefined) return null;
      const scope = {
        principalId: found.principalId as Uuid,
        projectId: found.projectId as Uuid,
      };
      return db.tenant(scope).transaction(async (tx) => {
        const row = await recipientIdentities.get(tx, identityId);
        return row === undefined ? null : toIdentity(scope, row);
      });
    },

    async createIdentity(row) {
      try {
        await db.tenant(row.scope).transaction(async (tx) =>
          recipientIdentities.create(tx, {
            id: row.id,
            recipientId: row.recipientId,
            provider: row.provider,
            providerAccount: row.providerAccount,
            state: row.status,
            ...changeOf(row),
          }),
        );
      } catch (error) {
        if (codeOf(error) === '23505') throw new IdentityConflictError();
        throw error;
      }
    },

    async updateIdentity(scope, identityId, patch) {
      let row: RecipientIdentity | undefined;
      try {
        row = await db
          .tenant(scope)
          .transaction(async (tx) => recipientIdentities.update(tx, identityId, changeOf(patch)));
      } catch (error) {
        if (codeOf(error) === '23505') throw new IdentityConflictError();
        throw error;
      }
      // Another tenant's row, or none, is one this caller cannot change.
      const record = row === undefined ? null : toIdentity(scope, row);
      if (record === null) throw new IdentityConflictError();
      return record;
    },

    async verifiedByNullifier(principalId, nullifierHmac) {
      const row = await db
        .principal({ principalId, projectId: NO_PROJECT }, 'app')
        .transaction(async (tx) =>
          recipientIdentities.verifiedByNullifier(tx, bufferOfHex(nullifierHmac)),
        );
      if (row === undefined) return null;
      return toIdentity({ principalId, projectId: row.projectId as Uuid }, row);
    },
  };
}

/** The attestations table, where the attester finds what it may sign. */
export function databaseAttestationLog(db: Database): AttestationLog {
  async function leavePending(
    scope: TenantScope,
    move: (tx: Kysely<Schema>) => Promise<boolean>,
  ): Promise<void> {
    let moved: boolean;
    try {
      moved = await db.tenant(scope).transaction(move);
    } catch (error) {
      // The trigger that keeps every other field as it was.
      if (codeOf(error) === 'UJ020') throw new AttestationStateError();
      throw error;
    }
    if (!moved) throw new AttestationStateError();
  }

  return {
    // Resolves once the transaction has committed, so the signer can see the row.
    async insertPending(row: AttestationRecord) {
      try {
        await db.tenant(row.scope).transaction(async (tx) =>
          attestations.insertPending(tx, {
            id: row.id,
            mandateInstanceId: row.mandateInstanceId,
            attemptId: row.attemptId,
            legIndex: row.legIndex,
            recipientId: row.recipientId,
            methodId: row.methodId,
            destinationAddress: row.destination.address.value,
            destinationTag: row.destination.tag,
            countryPolicyHash: bufferOfHex(row.countryPolicyHash),
            policyEpoch: row.policyEpoch,
            validUntil: dateOf(row.validUntil),
            attesterKeyId: row.attesterKeyId,
            digest: bufferOfHex(row.digest),
          }),
        );
      } catch (error) {
        if (codeOf(error) === '23505' && constraintOf(error) === 'attestations_digest_key') {
          throw new AttestationConflictError();
        }
        throw error;
      }
    },

    markSigned: (scope, attestationId, signature) =>
      leavePending(scope, async (tx) =>
        attestations.markSigned(tx, attestationId, Buffer.from(signature)),
      ),

    markFailed: (scope, attestationId, failureCode) =>
      leavePending(scope, async (tx) => attestations.markFailed(tx, attestationId, failureCode)),
  };
}

/** The legs of the payouts service's attempts, as the attester needs them. */
export function databasePayoutLegSource(db: Database): PayoutLegSource {
  return {
    leg: (scope, attemptId, legIndex) =>
      db.tenant(scope).transaction(async (tx) => {
        const leg = await payoutLegs.forAttestation(tx, attemptId, legIndex);
        if (leg === undefined) return null;
        return {
          scope,
          attemptId: leg.attemptId as Uuid,
          legIndex: leg.legIndex,
          mandateInstanceId: leg.mandateInstanceId as Uuid,
          recipientId: leg.recipientId as Uuid,
          methodId: leg.methodId as Uuid,
          amount: leg.amount,
        };
      }),
  };
}

/** Identity providers' deliveries, deduplicated. They belong to no tenant. */
export function databaseProviderEventStore(db: Database): ProviderEventStore {
  return {
    has: (provider, providerAccount, eventKey) =>
      db.unscoped(async (tx) =>
        identityProviderEvents.seen(tx, { provider, providerAccount, eventKey }),
      ),
    async record(event) {
      const stored = await db.unscoped(async (tx) =>
        identityProviderEvents.record(tx, {
          provider: event.provider,
          providerAccount: event.providerAccount,
          eventKey: event.eventKey,
          rawSha256: bufferOfHex(event.rawSha256),
        }),
      );
      return stored ? 'recorded' : 'duplicate';
    },
  };
}
