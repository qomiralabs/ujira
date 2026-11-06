// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The identity service and the attester against any implementation of their
// ports. The in-memory stand-ins and the database run these same cases, so a
// difference between the two shows up as a failing case, not in production.
//
// Each case returns what it saw and names what it expects, so this file needs no
// test framework; each side's test file compares the two.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Bytes32, TenantScope, UnixSeconds, Uuid } from '@ujira/chain-adapter';

import { createAttestationService } from '../attest.js';
import { parseIdentityConfig } from '../config.js';
import type {
  AttestationLog,
  IdentityStore,
  IdentityWriteStore,
  PayoutLegSource,
} from '../ports.js';
import type { ProviderEventStore } from '../self/ports.js';
import { createIdentityService } from '../service.js';
import type { AttestationRecord, IdentityContext } from '../types.js';

import { FakeAttestationChain, LocalAttester } from './attestation.js';
import {
  ManualClock,
  StaticRailCatalog,
  TEST_NETWORK,
  TEST_NOW,
  WALLET_RAIL,
  railCapability,
  snapshotOf,
} from './fixtures.js';

/** How a seeded tenant departs from one recipient who is ready to be paid. */
export interface ContractSeed {
  readonly instanceStatus?: 'active' | 'paused';
  readonly recipientActive?: boolean;
  /** The recipient's Self verification. `expired` is verified with an expiry already past. */
  readonly identity?: 'verified' | 'pending' | 'expired' | 'none';
  /** Whether the method has a wallet signature proof. */
  readonly verified?: boolean;
  /** The project's identity settings as saved, or null for none. */
  readonly settings?: Readonly<Record<string, unknown>> | null;
}

/**
 * One tenant as seeded: an attested mandate instance allowing GH, KE and NG, a
 * recipient in NG, a wallet method on the test network, and leg 0 of an attempt
 * paying it 2.5 USDC from the instance.
 */
export interface ContractTenant {
  readonly scope: TenantScope;
  readonly instanceId: Uuid;
  readonly recipientId: Uuid;
  readonly methodId: Uuid;
  readonly identityId: Uuid | null;
  readonly verificationId: Uuid | null;
  readonly attemptId: Uuid;
  readonly legIndex: number;
  /** The method's destination, as the chain writes it. */
  readonly address: string;
}

export interface ContractBackend {
  readonly store: IdentityStore & IdentityWriteStore;
  readonly log: AttestationLog;
  readonly legs: PayoutLegSource;
  readonly events: ProviderEventStore;
  seed(options?: ContractSeed): Promise<ContractTenant>;
  /** What the signer asks before it signs: is this exact message pending under the key? */
  isPending(message: Uint8Array, attesterKeyId: string): Promise<boolean>;
  /** The statuses of the tenant's attestations, oldest first. */
  attestationStatuses(scope: TenantScope): Promise<readonly string[]>;
}

export interface ContractCase {
  readonly name: string;
  readonly expected: unknown;
  run(backend: ContractBackend): Promise<unknown>;
}

// Long enough for a database under load, which the attester waits on when it
// checks that a message is pending.
const CONFIG = parseIdentityConfig({
  providers: { self: { enabled: true }, sep12: { enabled: true }, principal: { enabled: true } },
  attestation: { callTimeoutMs: 10_000 },
});

/** The name of the error a call threw, or 'ok'. Cases compare names, never messages. */
async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    return error instanceof Error ? error.name : 'unknown';
  }
}

function hexOf(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

async function servicesFor(backend: ContractBackend, tenant: ContractTenant) {
  const clock = new ManualClock();
  const rails = new StaticRailCatalog().put(TEST_NETWORK, railCapability(WALLET_RAIL));
  const ports = { store: backend.store, rails, clock, config: () => CONFIG };
  const instance = await backend.store.mandateInstance(tenant.scope, tenant.instanceId);
  if (instance === null) throw new Error('the seeded mandate instance did not read back');
  const attester: LocalAttester = new LocalAttester({
    messageOf: (fields) => chain.attestationMessage(fields),
    isPending: (message, keyId) => backend.isPending(message, keyId),
  });
  const chain = new FakeAttestationChain(snapshotOf(instance, attester.publicKeyBytes));
  const ctx: IdentityContext = { scope: tenant.scope, correlationId: 'trace-contract' };
  return {
    ctx,
    eligibility: () =>
      createIdentityService(ports).eligibility(ctx, {
        recipientId: tenant.recipientId,
        methodId: tenant.methodId,
        mandateInstanceId: tenant.instanceId,
      }),
    attest: () =>
      createAttestationService({
        ...ports,
        chain: () => chain,
        signer: attester,
        log: backend.log,
        legs: backend.legs,
      }).attest(ctx, {
        attemptId: tenant.attemptId,
        legIndex: tenant.legIndex,
        mandateInstanceId: tenant.instanceId,
        methodId: tenant.methodId,
      }),
  };
}

/** A pending row for the tenant's leg, with a message, and so a digest, of its own. */
function pendingRow(tenant: ContractTenant): AttestationRecord {
  const message = new Uint8Array(randomBytes(47));
  return {
    scope: tenant.scope,
    id: randomUUID() as Uuid,
    attemptId: tenant.attemptId,
    legIndex: tenant.legIndex,
    mandateInstanceId: tenant.instanceId,
    recipientId: tenant.recipientId,
    methodId: tenant.methodId,
    destination: { address: { network: TEST_NETWORK, value: tenant.address }, tag: null },
    countryPolicyHash: hexOf(new Uint8Array(32).fill(2)) as Bytes32,
    policyEpoch: 3n,
    validUntil: (TEST_NOW + 600n) as UnixSeconds,
    attesterKeyId: hexOf(new Uint8Array(32).fill(3)),
    message,
    digest: hexOf(createHash('sha256').update(message).digest()) as Bytes32,
    status: 'pending',
    signature: null,
    failureCode: null,
  };
}

function eligibilityCase(name: string, seed: ContractSeed, expected: unknown): ContractCase {
  return {
    name,
    expected,
    async run(backend) {
      const tenant = await backend.seed(seed);
      return (await servicesFor(backend, tenant)).eligibility();
    },
  };
}

export const IDENTITY_CONTRACT_CASES: readonly ContractCase[] = Object.freeze([
  eligibilityCase(
    'eligibility: a recipient with a verified identity is eligible',
    {},
    { eligible: true, assurance: 'document_zk', expiresAt: null },
  ),
  eligibilityCase(
    'eligibility: a paused instance pays no one',
    { instanceStatus: 'paused' },
    { eligible: false, reason: 'MANDATE_INACTIVE' },
  ),
  eligibilityCase(
    'eligibility: a recipient who is not active is refused',
    { recipientActive: false },
    { eligible: false, reason: 'RECIPIENT_INACTIVE' },
  ),
  eligibilityCase(
    'eligibility: a pending identity is refused as pending',
    { identity: 'pending' },
    { eligible: false, reason: 'IDENTITY_PENDING' },
  ),
  eligibilityCase(
    'eligibility: no identity at all is refused as required',
    { identity: 'none' },
    { eligible: false, reason: 'IDENTITY_REQUIRED' },
  ),
  eligibilityCase(
    'eligibility: an identity past its expiry is refused as expired',
    { identity: 'expired' },
    { eligible: false, reason: 'IDENTITY_EXPIRED' },
  ),
  eligibilityCase(
    'eligibility: the saved project settings decide what is needed',
    { settings: { recipientRequirement: 'principal_attested' } },
    { eligible: false, reason: 'IDENTITY_REQUIRED' },
  ),
  {
    name: 'attest: a ready leg is signed, and the log holds it signed',
    expected: { attested: true, statuses: ['signed'] },
    async run(backend) {
      const tenant = await backend.seed();
      const result = await (await servicesFor(backend, tenant)).attest();
      return {
        attested: result.attested,
        statuses: await backend.attestationStatuses(tenant.scope),
      };
    },
  },
  {
    name: 'attest: a method with no destination proof is refused, and nothing is logged',
    expected: { attested: false, reason: 'DESTINATION_UNVERIFIED', statuses: [] },
    async run(backend) {
      const tenant = await backend.seed({ verified: false });
      const result = await (await servicesFor(backend, tenant)).attest();
      return {
        attested: result.attested,
        reason: result.attested ? null : result.reason,
        statuses: await backend.attestationStatuses(tenant.scope),
      };
    },
  },
  {
    name: 'log: the same digest and key cannot be logged twice',
    expected: ['ok', 'AttestationConflictError'],
    async run(backend) {
      const tenant = await backend.seed();
      const row = pendingRow(tenant);
      return [
        await outcome(() => backend.log.insertPending(row)),
        await outcome(() => backend.log.insertPending({ ...row, id: randomUUID() as Uuid })),
      ];
    },
  },
  {
    name: 'log: an attestation leaves pending once',
    expected: ['ok', 'AttestationStateError', 'AttestationStateError', 'ok'],
    async run(backend) {
      const tenant = await backend.seed();
      const signed = pendingRow(tenant);
      const failed = pendingRow(tenant);
      await backend.log.insertPending(signed);
      await backend.log.insertPending(failed);
      const signature = new Uint8Array(64).fill(4);
      return [
        await outcome(() => backend.log.markSigned(tenant.scope, signed.id, signature)),
        await outcome(() => backend.log.markSigned(tenant.scope, signed.id, signature)),
        await outcome(() => backend.log.markFailed(tenant.scope, signed.id, 'SIGNER_DOWN')),
        await outcome(() => backend.log.markFailed(tenant.scope, failed.id, 'SIGNER_DOWN')),
      ];
    },
  },
  {
    name: 'log: a pending message is what the signer finds, and a signed one is not',
    expected: [true, false],
    async run(backend) {
      const tenant = await backend.seed();
      const row = pendingRow(tenant);
      await backend.log.insertPending(row);
      const before = await backend.isPending(row.message, row.attesterKeyId);
      await backend.log.markSigned(tenant.scope, row.id, new Uint8Array(64).fill(4));
      return [before, await backend.isPending(row.message, row.attesterKeyId)];
    },
  },
  {
    name: 'legs: the leg reads back with the attempt, the instance and the recipient',
    expected: { found: true, instance: true, recipient: true, method: true },
    async run(backend) {
      const tenant = await backend.seed();
      const leg = await backend.legs.leg(tenant.scope, tenant.attemptId, tenant.legIndex);
      return {
        found: leg !== null,
        instance: leg?.mandateInstanceId === tenant.instanceId,
        recipient: leg?.recipientId === tenant.recipientId,
        method: leg?.methodId === tenant.methodId,
      };
    },
  },
  {
    name: "tenancy: another tenant's ids read as absent, and its rows cannot be changed",
    expected: {
      recipient: null,
      method: null,
      instance: null,
      identities: [],
      latest: null,
      verification: null,
      leg: null,
      update: 'IdentityConflictError',
      signed: 'AttestationStateError',
    },
    async run(backend) {
      const a = await backend.seed();
      const b = await backend.seed();
      const theirIdentity = b.identityId;
      const theirs = pendingRow(b);
      await backend.log.insertPending(theirs);
      const { store } = backend;
      return {
        recipient: await store.recipient(a.scope, b.recipientId),
        method: await store.payoutMethod(a.scope, b.methodId),
        instance: await store.mandateInstance(a.scope, b.instanceId),
        identities: await store.identities(a.scope, b.recipientId),
        latest: await store.latestVerification(a.scope, b.methodId),
        verification:
          b.verificationId === null ? null : await store.verification(a.scope, b.verificationId),
        leg: await backend.legs.leg(a.scope, b.attemptId, b.legIndex),
        update:
          theirIdentity === null
            ? 'no identity'
            : await outcome(() =>
                store.updateIdentity(a.scope, theirIdentity, { status: 'revoked' }),
              ),
        signed: await outcome(() =>
          backend.log.markSigned(a.scope, theirs.id, new Uint8Array(64).fill(4)),
        ),
      };
    },
  },
  {
    name: 'write: a second identity for the same provider and account is refused',
    expected: 'IdentityConflictError',
    async run(backend) {
      const tenant = await backend.seed();
      const existing = await backend.store.identities(tenant.scope, tenant.recipientId);
      const [first] = existing;
      if (first === undefined) return 'no identity';
      return outcome(() => backend.store.createIdentity({ ...first, id: randomUUID() as Uuid }));
    },
  },
  {
    name: 'write: a provider callback finds the row and its tenant by id alone',
    expected: { found: true, scope: true },
    async run(backend) {
      const tenant = await backend.seed();
      if (tenant.identityId === null) return 'no identity';
      const row = await backend.store.identityById(tenant.identityId);
      return {
        found: row?.id === tenant.identityId,
        scope:
          row?.scope.principalId === tenant.scope.principalId &&
          row.scope.projectId === tenant.scope.projectId,
      };
    },
  },
  {
    name: 'write: an update changes what it names and reads back whole',
    expected: {
      status: 'pending',
      session: {
        sessionId: 'session-1',
        url: 'https://verify.example/s/1',
        expiresAt: 1800000600n,
      },
      reread: true,
    },
    async run(backend) {
      const tenant = await backend.seed();
      if (tenant.identityId === null) return 'no identity';
      const updated = await backend.store.updateIdentity(tenant.scope, tenant.identityId, {
        status: 'pending',
        pendingSession: {
          sessionId: 'session-1',
          url: 'https://verify.example/s/1',
          expiresAt: (TEST_NOW + 600n) as UnixSeconds,
        },
      });
      const [reread] = await backend.store.identities(tenant.scope, tenant.recipientId);
      return {
        status: updated.status,
        session: updated.pendingSession,
        reread: reread?.status === 'pending' && reread.pendingSession?.sessionId === 'session-1',
      };
    },
  },
  {
    name: "write: a verified nullifier is found across the principal's projects, and only theirs",
    expected: { own: true, other: null },
    async run(backend) {
      const a = await backend.seed();
      const b = await backend.seed();
      if (a.identityId === null) return 'no identity';
      const nullifier = createHash('sha256').update(randomUUID()).digest('hex');
      await backend.store.updateIdentity(a.scope, a.identityId, { nullifierHmac: nullifier });
      const own = await backend.store.verifiedByNullifier(a.scope.principalId, nullifier);
      return {
        own: own?.id === a.identityId,
        other: await backend.store.verifiedByNullifier(b.scope.principalId, nullifier),
      };
    },
  },
  {
    name: 'events: a provider event is recorded once, and then seen',
    expected: ['recorded', 'duplicate', true],
    async run(backend) {
      const event = {
        provider: 'self' as const,
        providerAccount: 'staging:flow-1',
        eventKey: `${randomUUID()}-completed`,
        rawSha256: createHash('sha256').update(randomUUID()).digest('hex'),
        receivedAt: TEST_NOW,
      };
      return [
        await backend.events.record(event),
        await backend.events.record(event),
        await backend.events.has('self', event.providerAccount, event.eventKey),
      ];
    },
  },
]);
