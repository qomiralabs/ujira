// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The cross-tenant matrix. Two principals with two projects each. Every
// repository method runs as tenant A against tenant B's ids and must find
// nothing, return a page without B's rows, or land its write in A.

import { randomBytes, randomUUID } from 'node:crypto';

import { tokenAmount } from '@ujira/core';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import type { Schema } from './schema.generated.js';
import { compliance, complianceRepositories } from './repositories/compliance.js';
import { audit, auditRepositories } from './repositories/audit.js';
import { entryPoints } from './repositories/entry-points.js';
import { fundingAccountRepositories, fundingAccounts } from './repositories/funding-accounts.js';
import { approvals, legRepositories, payoutLegs } from './repositories/payout-legs.js';
import { managedSigners } from './repositories/signers.js';
import { ledger, ledgerRepositories } from './repositories/ledger.js';
import {
  chainEvents,
  deposits,
  fundingSources,
  fundingSweeps,
  instanceRoles,
  mandateInstances,
  mandateRepositories,
  mandates,
} from './repositories/mandates.js';
import {
  fundingHolds,
  payoutAttempts,
  payoutBatches,
  payoutMinimums,
  payoutRepositories,
  payouts,
} from './repositories/payouts.js';
import {
  payoutMethods,
  recipientIdentities,
  recipientPii,
  recipientRepositories,
  recipients,
} from './repositories/recipients.js';
import {
  agentIdentityLinks,
  attestations,
  destinationVerifications,
  embedSessions,
  identityEvidenceRepositories,
  walletChallenges,
} from './repositories/identity-evidence.js';
import {
  apiTokens,
  members,
  principals,
  projects,
  tenancyRepositories,
} from './repositories/tenancy.js';
import { payoutBookings } from './repositories/mandate-registry.js';
import { caseProblems, methodNames } from './testing/cross-tenant.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

interface Tenant {
  readonly first: ProjectContext;
  readonly second: ProjectContext;
  readonly ownerUserId: string;
  readonly tokenId: string;
  readonly signerId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly instanceId: string;
  readonly sourceId: string;
  readonly accountSourceId: string;
  readonly fundingAccountId: string;
  readonly sweepId: string;
  readonly depositOperationId: string;
  readonly eventId: string;
  readonly eventTxHash: Buffer;
  readonly depositId: string;
  readonly roleAddress: string;
  readonly contractAddress: string;
  readonly bookingId: string;
  readonly bookingPayoutId: Buffer;
  readonly journalId: string;
  readonly accountId: string;
  readonly recipientId: string;
  readonly identityId: string;
  readonly methodId: string;
  readonly payoutId: string;
  readonly batchId: string;
  readonly attemptId: string;
  readonly heldPayoutId: string;
  readonly legId: string;
  readonly sessionId: string;
  readonly challengeId: string;
  readonly verificationId: string;
  readonly attestationId: string;
  readonly agentLinkId: string;
}

const REPOSITORIES = {
  ...complianceRepositories,
  ...tenancyRepositories,
  ...mandateRepositories,
  ...fundingAccountRepositories,
  ...ledgerRepositories,
  ...recipientRepositories,
  ...identityEvidenceRepositories,
  ...auditRepositories,
  ...payoutRepositories,
  ...legRepositories,
  payoutBookings,
};

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let a: Tenant;
let b: Tenant;

async function tenant(name: string): Promise<Tenant> {
  const ownerUserId = randomUUID();
  const created = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: `${name} one`, ownerUserId }),
  );
  const first = { principalId: created.principalId, projectId: created.projectId };
  const secondId = await db
    .tenant(first)
    .transaction(async (tx) => projects.create(tx, { name: `${name} two` }));
  const token = await db.tenant(first).transaction(async (tx) =>
    apiTokens.create(tx, {
      prefix: `uj_${name}_${randomUUID().slice(0, 8)}`,
      secretSha256: Buffer.alloc(32, 7),
      scopes: ['payouts:read'],
      expiresAt: new Date('2100-01-01T00:00:00Z'),
    }),
  );
  const agentId = randomUUID();
  const signer = await db.tenant(first).transaction(async (tx) =>
    managedSigners.create(tx, {
      network: 'stellar:testnet',
      agentId,
      keyRef: `alias/${name}`,
      address: `G${randomUUID().replaceAll('-', '').toUpperCase()}`,
      consentedByMemberId: ownerUserId,
    }),
  );
  const depositOperationId = randomUUID();
  const {
    mandateId,
    instanceId,
    sourceId,
    contractAddress,
    accountSourceId,
    sweepId,
    fundingAccountId,
  } = await db.tenant(first).transaction(async (tx) => {
    const mandate = await mandates.create(tx, { name: `${name} mandate` });
    const instance = await mandateInstances.create(tx, {
      network: 'stellar:testnet',
      mandateId: mandate.id,
      chain: 'stellar',
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
    const source = await fundingSources.create(tx, {
      mandateInstanceId: instance.id,
      kind: 'stablecoin_deposit',
    });
    const account = await fundingSources.create(tx, {
      mandateInstanceId: instance.id,
      kind: 'stellar_funding_account',
      config: { sponsoredReserves: true, sponsorTxHash: randomBytes(32) },
    });
    const sweep = await fundingSweeps.create(tx, {
      fundingSourceId: account.id,
      mandateInstanceId: instance.id,
      depositOperationId,
      amount: tokenAmount(100n, 'USDC', 'stellar'),
    });
    const forwarder = await fundingAccounts.record(tx, {
      network: 'stellar:testnet',
      address: `G${randomUUID()}`,
      sponsor: `G${randomUUID()}`,
      sponsorTxHash: randomBytes(32),
      faults: [],
    });
    return {
      mandateId: mandate.id,
      instanceId: instance.id,
      sourceId: source.id,
      contractAddress: instance.contractAddress,
      accountSourceId: account.id,
      sweepId: sweep.id,
      fundingAccountId: forwarder?.id ?? '',
    };
  });
  const eventTxHash = randomBytes(32);
  const bookingPayoutId = randomBytes(32);
  const roleAddress = `G${name}`;
  const { eventId, depositId, journalId, accountId, bookingId } = await indexing(
    first,
    async (tx) => {
      const event = await chainEvents.record(tx, {
        mandateInstanceId: instanceId,
        chain: 'stellar',
        txHash: eventTxHash,
        eventIndex: 0n,
        ledger: 1n,
        eventType: 'deposit',
        payload: {},
        finalizedAt: new Date(),
      });
      const recorded = await deposits.record(tx, {
        mandateInstanceId: instanceId,
        fundingSourceId: sourceId,
        chainEventId: event.id ?? '',
        amount: tokenAmount(100n, 'USDC', 'stellar'),
        fromAddress: 'GFROM',
      });
      await instanceRoles.grant(tx, {
        mandateInstanceId: instanceId,
        role: 'agent',
        address: roleAddress,
        eventId: event.id ?? '',
      });
      const booking = await payoutBookings.apply(tx, {
        mandateInstanceId: instanceId,
        chain: 'stellar',
        contractAddress,
        payoutId: bookingPayoutId,
        eventId: event.id ?? '',
        eventType: 'payout_requested',
      });
      const posted = await ledger.post(tx, {
        mandateInstanceId: instanceId,
        chainEventId: event.id ?? '',
        entries: [
          { kind: 'external', amount: -100n },
          { kind: 'balance', amount: 100n },
        ],
      });
      await ledger.recordState(tx, {
        mandateInstanceId: instanceId,
        ledger: 1n,
        balance: 100n,
        pending: 0n,
        committed: 0n,
        spent: 0n,
      });
      const accounts = await ledger.accounts(tx, instanceId);
      return {
        eventId: event.id ?? '',
        depositId: recorded.id ?? '',
        journalId: posted.journalId ?? '',
        accountId: accounts[0]?.id ?? '',
        bookingId: booking.id,
      };
    },
  );
  const destinationAddress = `G${randomUUID()}`;
  const evidence = await db.tenant(first).transaction(async (tx) => {
    const recipient = await recipients.create(tx, {
      recipientRef: randomBytes(32),
      country: 'NG',
    });
    await recipientPii.put(tx, recipient.id, {
      ciphertext: randomBytes(16),
      nonce: randomBytes(12),
    });
    const identity = await recipientIdentities.upsert(tx, {
      recipientId: recipient.id,
      chain: 'stellar',
      provider: 'self',
      providerRef: `ref-${name}`,
      state: 'verified',
    });
    const method = await payoutMethods.create(tx, {
      recipientId: recipient.id,
      method: 'stellar_wallet',
      rail: 'wallet',
      chain: 'stellar',
      destinationAddress,
      destinationTag: null,
      details: null,
    });
    await audit.record(tx, { action: 'project.created', actor: { kind: 'system' } });
    const session = await embedSessions.create(tx, {
      tokenHash: randomBytes(32),
      tokenPrefix: `ujes_test_${randomUUID().slice(0, 8)}`,
      recipientId: recipient.id,
      purpose: 'onboarding',
      allowedOrigins: ['https://app.example'],
      createdByToken: null,
      expiresAt: new Date('2027-01-15T09:00:00Z'),
    });
    const challenge = await walletChallenges.create(tx, {
      methodId: method.id,
      purpose: 'payout_destination',
      network: 'stellar:testnet',
      address: method.destinationAddress,
      tag: null,
      recipientRef: recipient.recipientRef,
      requestId: randomUUID(),
      nonceHash: randomBytes(32),
      messageHash: randomBytes(32),
      issuedAt: new Date('2027-01-15T08:00:00Z'),
      expiresAt: new Date('2027-01-15T08:10:00Z'),
    });
    const verification = await destinationVerifications.record(tx, {
      methodId: method.id,
      level: 'partner_confirmed',
      chain: 'stellar',
      destinationAddress: method.destinationAddress,
      destinationTag: null,
      partnerRef: `partner-${name}`,
    });
    const attestation = await attestations.insertPending(tx, {
      mandateInstanceId: instanceId,
      attemptId: randomUUID(),
      legIndex: 0,
      recipientId: recipient.id,
      methodId: method.id,
      destinationAddress: method.destinationAddress,
      destinationTag: null,
      countryPolicyHash: randomBytes(32),
      policyEpoch: 0n,
      validUntil: new Date('2027-01-16T08:00:00Z'),
      attesterKeyId: `0x${name}`,
      digest: randomBytes(32),
    });
    const agentLink = await agentIdentityLinks.create(tx, {
      network: 'stellar:testnet',
      address: `G${randomUUID()}`,
      registry: 'registry-1',
      tokenId: 1n,
      displayName: null,
      humanBackedUntil: null,
    });
    return {
      recipientId: recipient.id,
      identityId: identity.id,
      methodId: method.id,
      sessionId: session.id,
      challengeId: challenge.id,
      verificationId: verification.id,
      attestationId: attestation.id,
      agentLinkId: agentLink.id,
    };
  });
  const { payoutId, batchId, attemptId, heldPayoutId, legId } = await db
    .tenant(first)
    .transaction(async (tx) => {
      const payoutInput = {
        recipientId: evidence.recipientId,
        mandateId,
        method: 'stellar_wallet' as const,
        requested: tokenAmount(50_000_000n, 'USDC', 'stellar'),
      };
      const { payout } = await payouts.create(tx, {
        ...payoutInput,
        idempotencyKey: randomUUID(),
      });
      const held = await payouts.create(tx, { ...payoutInput, idempotencyKey: randomUUID() });
      const { batch } = await payoutBatches.create(tx, {
        idempotencyKey: randomUUID(),
        items: [],
      });
      const attempt = await payoutAttempts.create(tx, {
        payoutId: payout.id,
        mandateInstanceId: instanceId,
        network: 'stellar:testnet',
        total: tokenAmount(50_000_000n, 'USDC', 'stellar'),
        deadline: new Date(Date.now() + 3_600_000),
        legs: [
          {
            payoutMethodId: evidence.methodId,
            method: 'stellar_wallet',
            destinationAddress,
            amount: 50_000_000n,
          },
        ],
      });
      const [leg] = await payoutLegs.forAttempt(tx, attempt.id);
      await approvals.record(tx, {
        attemptId: attempt.id,
        approver: `G${name}`,
        decision: 'approved',
        signedMessageHash: randomBytes(32),
        signature: randomBytes(64),
      });
      await fundingHolds.hold(tx, held.payout.id, [
        {
          mandateInstanceId: instanceId,
          network: 'stellar:testnet',
          needed: tokenAmount(50_000_000n, 'USDC', 'stellar'),
        },
      ]);
      await payoutMinimums.set(tx, {
        method: 'bank',
        minimum: { amount: 1000n, currency: 'USD', scale: 2 },
        memberId: ownerUserId,
      });
      return {
        payoutId: payout.id,
        batchId: batch.id,
        attemptId: attempt.id,
        heldPayoutId: held.payout.id,
        legId: leg?.id ?? '',
      };
    });
  return {
    first,
    second: { principalId: created.principalId, projectId: secondId },
    ownerUserId,
    tokenId: token.id,
    signerId: signer.id,
    agentId,
    mandateId,
    instanceId,
    sourceId,
    accountSourceId,
    fundingAccountId,
    sweepId,
    depositOperationId,
    eventId,
    eventTxHash,
    depositId,
    roleAddress,
    contractAddress,
    bookingId,
    bookingPayoutId,
    journalId,
    accountId,
    ...evidence,
    payoutId,
    batchId,
    attemptId,
    heldPayoutId,
    legId,
  };
}

async function statusOf(table: string, id: string): Promise<string | undefined> {
  const result = await admin.query<{ status: string }>(
    `select status from ${table} where id = $1`,
    [id],
  );
  return result.rows[0]?.status;
}

async function settingsOf(projectId: string): Promise<unknown> {
  const result = await admin.query(
    `select cashout_cost_bearer, chain_fallback, funding_hold_max_seconds
       from ujira.projects where id = $1`,
    [projectId],
  );
  return result.rows[0];
}

// The mirror tables are written by the indexer, under the tenant's context.
async function indexing<T>(
  context: ProjectContext,
  work: (tx: Kysely<Schema>) => Promise<T>,
): Promise<T> {
  return db.withTenant('indexer', { ...context, scope: 'project' }, work);
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function ownerOf(table: string, column: string, value: string): Promise<string | undefined> {
  const result = await admin.query<{ principal_id: string }>(
    `select principal_id from ${table} where ${column} = $1`,
    [value],
  );
  return result.rows[0]?.principal_id;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  a = await tenant('alpha');
  b = await tenant('bravo');
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

// Tenant A's first project, and every project of A read only.
const asA = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.tenant(a.first).transaction(work);
const acrossA = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.principal(a.first, 'app').transaction(work);

// One case per repository method, each run as tenant A.
const cases: Record<string, () => Promise<void>> = {
  'compliance.mark': async () => {
    expect(await acrossA(async (tx) => compliance.mark(tx, b.instanceId))).toBeUndefined();
  },
  'compliance.applyMark': async () => {
    const notice = { to: 'compliant' as const, at: new Date(), fixes: [] };
    expect(await asA(async (tx) => compliance.applyMark(tx, b.instanceId, null, notice))).toBe(
      false,
    );
    await expect(
      asA(async (tx) =>
        compliance.applyMark(
          tx,
          b.instanceId,
          { reason: 'principal_key_risk', since: new Date() },
          { ...notice, to: 'noncompliant' },
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  },
  'compliance.parkIfNoncompliant': async () => {
    expect(await asA(async (tx) => compliance.parkIfNoncompliant(tx, b.instanceId, 'job'))).toBe(
      false,
    );
  },
  'compliance.closeOut': async () => {
    expect(
      await asA(async (tx) => compliance.closeOut(tx, b.instanceId, 'mandate_revoked')),
    ).toEqual([]);
  },
  'compliance.parkedJobs': async () => {
    expect(await acrossA(async (tx) => compliance.parkedJobs(tx, b.instanceId))).toEqual([]);
  },
  'compliance.notices': async () => {
    expect(await acrossA(async (tx) => compliance.notices(tx, b.instanceId))).toEqual([]);
  },
  'principals.current': async () => {
    const found = await asA(async (tx) => principals.current(tx));
    expect(found?.id).toBe(a.first.principalId);
  },
  'principals.get': async () => {
    expect(await asA(async (tx) => principals.get(tx, b.first.principalId))).toBeUndefined();
  },
  'principals.setReportingTimeZone': async () => {
    expect(
      await asA(async (tx) =>
        principals.setReportingTimeZone(tx, b.first.principalId, 'Africa/Lagos'),
      ),
    ).toBe(false);
  },
  'projects.list': async () => {
    // Other cases may have added projects to A; none may belong to B.
    const page = await acrossA(async (tx) => projects.list(tx, { limit: 100 }));
    const ids = page.items.map((project) => project.id);
    expect(ids).toEqual(expect.arrayContaining([a.first.projectId, a.second.projectId]));
    expect(ids).not.toContain(b.first.projectId);
    expect(ids).not.toContain(b.second.projectId);
    expect(new Set(page.items.map((project) => project.principalId))).toEqual(
      new Set([a.first.principalId]),
    );
  },
  'projects.get': async () => {
    expect(await acrossA(async (tx) => projects.get(tx, b.first.projectId))).toBeUndefined();
  },
  'projects.create': async () => {
    const id = await asA(async (tx) => projects.create(tx, { name: 'made by a' }));
    expect(await ownerOf('ujira.projects', 'id', id)).toBe(a.first.principalId);
  },
  'projects.rename': async () => {
    expect(await asA(async (tx) => projects.rename(tx, b.first.projectId, 'taken'))).toBe(false);
  },
  // These take no id: the project is the context's, so B's cannot be named.
  'projects.settings': async () => {
    const before = await settingsOf(b.first.projectId);
    const settings = await asA(async (tx) => projects.settings(tx));
    expect(settings).toBeDefined();
    expect(await settingsOf(b.first.projectId)).toEqual(before);
  },
  'projects.setCashoutBearer': async () => {
    const before = await settingsOf(b.first.projectId);
    const actor = { kind: 'member', id: a.ownerUserId } as const;
    await asA(async (tx) => projects.setCashoutBearer(tx, 'principal', actor));
    expect(await settingsOf(b.first.projectId)).toEqual(before);
    await asA(async (tx) => projects.setCashoutBearer(tx, 'recipient', actor));
  },
  'projects.setRoutingSettings': async () => {
    const before = await settingsOf(b.first.projectId);
    await asA(async (tx) =>
      projects.setRoutingSettings(
        tx,
        { chainFallback: 'verified_methods' },
        { kind: 'member', id: a.ownerUserId },
      ),
    );
    expect(await settingsOf(b.first.projectId)).toEqual(before);
  },
  'members.list': async () => {
    const page = await asA(async (tx) => members.list(tx, { limit: 100 }));
    expect(page.items.map((member) => member.userId)).not.toContain(b.ownerUserId);
    expect(page.items.map((member) => member.userId)).toContain(a.ownerUserId);
  },
  'members.get': async () => {
    expect(await asA(async (tx) => members.get(tx, b.ownerUserId))).toBeUndefined();
  },
  'members.add': async () => {
    const userId = randomUUID();
    await asA(async (tx) => members.add(tx, { userId, role: 'viewer' }));
    expect(await ownerOf('ujira.principal_members', 'user_id', userId)).toBe(a.first.principalId);
  },
  'members.changeRole': async () => {
    expect(await asA(async (tx) => members.changeRole(tx, b.ownerUserId, 'viewer'))).toBe(false);
  },
  'apiTokens.list': async () => {
    const page = await acrossA(async (tx) => apiTokens.list(tx, { limit: 100 }));
    expect(page.items.map((token) => token.id)).not.toContain(b.tokenId);
    expect(page.items.map((token) => token.id)).toContain(a.tokenId);
  },
  'apiTokens.get': async () => {
    expect(await acrossA(async (tx) => apiTokens.get(tx, b.tokenId))).toBeUndefined();
  },
  'apiTokens.create': async () => {
    const token = await asA(async (tx) =>
      apiTokens.create(tx, {
        prefix: `uj_case_${randomUUID().slice(0, 8)}`,
        secretSha256: Buffer.alloc(32, 9),
        scopes: ['payouts:read'],
        expiresAt: new Date('2100-01-01T00:00:00Z'),
      }),
    );
    expect(token.projectId).toBe(a.first.projectId);
    expect(await ownerOf('ujira.api_tokens', 'id', token.id)).toBe(a.first.principalId);
  },
  'apiTokens.touchLastUsed': async () => {
    expect(await asA(async (tx) => apiTokens.touchLastUsed(tx, b.tokenId))).toBe(false);
    const bToken = await admin.query<{ last_used_at: Date | null }>(
      'select last_used_at from ujira.api_tokens where id = $1',
      [b.tokenId],
    );
    expect(bToken.rows[0]?.last_used_at).toBeNull();
  },
  'apiTokens.revoke': async () => {
    expect(await asA(async (tx) => apiTokens.revoke(tx, b.tokenId))).toBe(false);
    const bToken = await admin.query<{ revoked_at: Date | null }>(
      'select revoked_at from ujira.api_tokens where id = $1',
      [b.tokenId],
    );
    expect(bToken.rows[0]?.revoked_at).toBeNull();
  },
  'managedSigners.list': async () => {
    const page = await acrossA(async (tx) => managedSigners.list(tx, { limit: 100 }));
    expect(page.items.map((signer) => signer.id)).not.toContain(b.signerId);
    expect(page.items.map((signer) => signer.id)).toContain(a.signerId);
  },
  'managedSigners.get': async () => {
    expect(await acrossA(async (tx) => managedSigners.get(tx, b.signerId))).toBeUndefined();
  },
  'managedSigners.active': async () => {
    const found = await acrossA(async (tx) =>
      managedSigners.active(tx, { network: 'stellar:testnet', agentId: b.agentId }),
    );
    expect(found).toBeUndefined();
  },
  'managedSigners.create': async () => {
    const input = {
      network: 'stellar:testnet',
      agentId: randomUUID(),
      keyRef: 'alias/case',
      address: `G${randomUUID().replaceAll('-', '').toUpperCase()}`,
      consentedByMemberId: a.ownerUserId,
    };
    const signer = await asA(async (tx) => managedSigners.create(tx, input));
    expect(signer.projectId).toBe(a.first.projectId);
    expect(await ownerOf('ujira.managed_signers', 'id', signer.id)).toBe(a.first.principalId);
    // Another tenant's member cannot consent to a key here.
    await expect(
      asA(async (tx) =>
        managedSigners.create(tx, {
          ...input,
          agentId: randomUUID(),
          address: `G${randomUUID().replaceAll('-', '').toUpperCase()}`,
          consentedByMemberId: b.ownerUserId,
        }),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  },
  'managedSigners.setStatus': async () => {
    expect(await asA(async (tx) => managedSigners.setStatus(tx, b.signerId, 'retired'))).toBe(
      false,
    );
    const row = await admin.query<{ status: string }>(
      'select status from ujira.managed_signers where id = $1',
      [b.signerId],
    );
    expect(row.rows[0]?.status).toBe('active');
  },
  'mandates.list': async () => {
    const page = await acrossA(async (tx) => mandates.list(tx, { limit: 100 }));
    expect(page.items.map((mandate) => mandate.id)).toContain(a.mandateId);
    expect(page.items.map((mandate) => mandate.id)).not.toContain(b.mandateId);
  },
  'mandates.get': async () => {
    expect(await acrossA(async (tx) => mandates.get(tx, b.mandateId))).toBeUndefined();
  },
  'mandates.create': async () => {
    const created = await asA(async (tx) => mandates.create(tx, { name: 'made by a' }));
    expect(await ownerOf('ujira.mandates', 'id', created.id)).toBe(a.first.principalId);
  },
  'mandates.rename': async () => {
    expect(await asA(async (tx) => mandates.rename(tx, b.mandateId, 'taken'))).toBe(false);
  },
  'mandateInstances.list': async () => {
    const page = await acrossA(async (tx) => mandateInstances.list(tx, { limit: 100 }));
    expect(page.items.map((instance) => instance.id)).toContain(a.instanceId);
    expect(page.items.map((instance) => instance.id)).not.toContain(b.instanceId);
  },
  'mandateInstances.get': async () => {
    expect(await acrossA(async (tx) => mandateInstances.get(tx, b.instanceId))).toBeUndefined();
  },
  'mandateInstances.byAddress': async () => {
    const find = (contract: string) =>
      acrossA(async (tx) => mandateInstances.byAddress(tx, 'stellar', contract));
    expect((await find(a.contractAddress))?.id).toBe(a.instanceId);
    expect(await find(b.contractAddress)).toBeUndefined();
  },
  'mandateInstances.create': async () => {
    // Naming B's mandate is a tenant violation at the composite foreign key.
    const attempt = asA(async (tx) =>
      mandateInstances.create(tx, {
        network: 'stellar:testnet',
        mandateId: b.mandateId,
        chain: 'stellar',
        contractAddress: `C${randomUUID()}`,
        specVersion: '1',
        asset: 'USDC',
        scale: 7,
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'fundingSweeps.list': async () => {
    const page = await acrossA(async (tx) => fundingSweeps.list(tx, { limit: 100 }));
    expect(page.items.map((sweep) => sweep.id)).not.toContain(b.sweepId);
    expect(page.items.map((sweep) => sweep.id)).toContain(a.sweepId);
  },
  'fundingSweeps.get': async () => {
    expect(await acrossA(async (tx) => fundingSweeps.get(tx, b.sweepId))).toBeUndefined();
  },
  'fundingSweeps.byDepositOperation': async () => {
    const found = await acrossA(async (tx) =>
      fundingSweeps.byDepositOperation(tx, {
        chain: 'stellar',
        depositOperationId: b.depositOperationId,
      }),
    );
    expect(found).toBeUndefined();
  },
  'fundingSweeps.create': async () => {
    const amount = tokenAmount(5n, 'USDC', 'stellar');
    const sweep = await asA(async (tx) =>
      fundingSweeps.create(tx, {
        fundingSourceId: a.accountSourceId,
        mandateInstanceId: a.instanceId,
        depositOperationId: randomUUID(),
        amount,
      }),
    );
    expect(await ownerOf('ujira.funding_sweeps', 'id', sweep.id)).toBe(a.first.principalId);
    // Naming B's source and instance goes nowhere.
    expect(
      await codeOf(
        asA(async (tx) =>
          fundingSweeps.create(tx, {
            fundingSourceId: b.accountSourceId,
            mandateInstanceId: b.instanceId,
            depositOperationId: randomUUID(),
            amount,
          }),
        ),
      ),
    ).toBe('23503');
  },
  'fundingSweeps.setStatus': async () => {
    expect(
      await asA(async (tx) => fundingSweeps.setStatus(tx, b.sweepId, { status: 'cancelled' })),
    ).toBe(false);
    const row = await admin.query<{ status: string }>(
      'select status from ujira.funding_sweeps where id = $1',
      [b.sweepId],
    );
    expect(row.rows[0]?.status).toBe('awaiting_signature');
  },
  'fundingSources.list': async () => {
    const page = await acrossA(async (tx) => fundingSources.list(tx, { limit: 100 }));
    expect(page.items.map((source) => source.id)).toContain(a.sourceId);
    expect(page.items.map((source) => source.id)).not.toContain(b.sourceId);
  },
  'fundingSources.get': async () => {
    expect(await acrossA(async (tx) => fundingSources.get(tx, b.sourceId))).toBeUndefined();
  },
  'fundingSources.create': async () => {
    const attempt = asA(async (tx) =>
      fundingSources.create(tx, { mandateInstanceId: b.instanceId, kind: 'stablecoin_deposit' }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'fundingAccounts.forNetwork': async () => {
    const seen = await asA(async (tx) => fundingAccounts.forNetwork(tx, 'stellar:testnet'));
    expect(seen?.id).toBe(a.fundingAccountId);
    // Accounts are one per project, so a read across projects has no one answer.
    const across = await acrossA(async (tx) => fundingAccounts.forNetwork(tx, 'stellar:testnet'));
    expect(across).toBeUndefined();
  },
  'fundingAccounts.record': async () => {
    const saved = await asA(async (tx) =>
      fundingAccounts.record(tx, {
        network: 'stellar:pubnet',
        address: `G${randomUUID()}`,
        sponsor: `G${randomUUID()}`,
        sponsorTxHash: randomBytes(32),
        faults: [],
      }),
    );
    expect(await ownerOf('ujira.funding_accounts', 'id', saved?.id ?? '')).toBe(
      a.first.principalId,
    );
  },
  'fundingAccounts.recordCheck': async () => {
    const attempt = asA(async (tx) =>
      fundingAccounts.recordCheck(tx, { accountId: b.fundingAccountId, faults: ['extra_signer'] }),
    );
    expect(await codeOf(attempt)).toBe('23503');
    const seen = await admin.query<{ count: string }>(
      'select count(*)::text as count from ujira.funding_account_checks where funding_account_id = $1',
      [b.fundingAccountId],
    );
    expect(seen.rows[0]?.count).toBe('0');
    await asA(async (tx) =>
      fundingAccounts.recordCheck(tx, { accountId: a.fundingAccountId, faults: [] }),
    );
    expect(
      await ownerOf('ujira.funding_account_checks', 'funding_account_id', a.fundingAccountId),
    ).toBe(a.first.principalId);
  },
  'fundingAccounts.attach': async () => {
    // Another tenant's account is simply not there to attach.
    expect(
      await asA(async (tx) =>
        fundingAccounts.attach(tx, {
          accountId: b.fundingAccountId,
          mandateInstanceId: a.instanceId,
        }),
      ),
    ).toBeUndefined();
    // And another tenant's instance is not there to fund.
    expect(
      await asA(async (tx) =>
        fundingAccounts.attach(tx, {
          accountId: a.fundingAccountId,
          mandateInstanceId: b.instanceId,
        }),
      ),
    ).toBeUndefined();
    const count = await admin.query<{ count: string }>(
      'select count(*)::text as count from ujira.funding_account_sources where mandate_instance_id = $1',
      [b.instanceId],
    );
    expect(count.rows[0]?.count).toBe('0');
  },
  'chainEvents.record': async () => {
    const event = {
      chain: 'stellar',
      eventIndex: 0n,
      ledger: 1n,
      eventType: 'deposit',
      payload: {},
      finalizedAt: new Date(),
    };
    // Naming B's instance is refused.
    const attempt = indexing(a.first, async (tx) =>
      chainEvents.record(tx, {
        ...event,
        mandateInstanceId: b.instanceId,
        txHash: randomBytes(32),
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
    // An event that is already B's stays B's, and A learns nothing of its id.
    const replay = await indexing(a.first, async (tx) =>
      chainEvents.record(tx, {
        ...event,
        mandateInstanceId: a.instanceId,
        txHash: b.eventTxHash,
      }),
    );
    expect(replay).toEqual({ created: false, id: undefined });
  },
  'chainEvents.get': async () => {
    expect(await acrossA(async (tx) => chainEvents.get(tx, b.eventId))).toBeUndefined();
  },
  'chainEvents.list': async () => {
    const page = await acrossA(async (tx) => chainEvents.list(tx, b.instanceId, { limit: 100 }));
    expect(page.items).toEqual([]);
  },
  'payoutBookings.apply': async () => {
    const move = { chain: 'stellar', eventType: 'payout_executed' };
    // Naming B's instance is refused.
    expect(
      await codeOf(
        indexing(a.first, async (tx) =>
          payoutBookings.apply(tx, {
            ...move,
            mandateInstanceId: b.instanceId,
            contractAddress: b.contractAddress,
            payoutId: randomBytes(32),
            eventId: a.eventId,
          }),
        ),
      ),
    ).toBe('23503');
    // So is reaching B's booking by its key, and it stays as it was.
    expect(
      await codeOf(
        indexing(a.first, async (tx) =>
          payoutBookings.apply(tx, {
            ...move,
            mandateInstanceId: a.instanceId,
            contractAddress: b.contractAddress,
            payoutId: b.bookingPayoutId,
            eventId: a.eventId,
          }),
        ),
      ),
    ).toBeDefined();
    const kept = await admin.query<{ last_event_type: string }>(
      'select last_event_type from ujira.payout_bookings where id = $1',
      [b.bookingId],
    );
    expect(kept.rows[0]?.last_event_type).toBe('payout_requested');
  },
  'payoutBookings.get': async () => {
    expect(await acrossA(async (tx) => payoutBookings.get(tx, b.bookingId))).toBeUndefined();
  },
  'payoutBookings.list': async () => {
    const page = await acrossA(async (tx) => payoutBookings.list(tx, b.instanceId, { limit: 100 }));
    expect(page.items).toEqual([]);
  },
  'instanceRoles.list': async () => {
    const page = await acrossA(async (tx) => instanceRoles.list(tx, b.instanceId, { limit: 100 }));
    expect(page.items).toEqual([]);
  },
  'instanceRoles.grant': async () => {
    // The same refusal for an address that holds the role on B's instance and
    // one that does not.
    for (const address of [b.roleAddress, 'GINTRUDER']) {
      const attempt = indexing(a.first, async (tx) =>
        instanceRoles.grant(tx, {
          mandateInstanceId: b.instanceId,
          role: 'agent',
          address,
          eventId: a.eventId,
        }),
      );
      expect(await codeOf(attempt)).toBe('23503');
    }
  },
  'instanceRoles.revoke': async () => {
    expect(
      await indexing(a.first, async (tx) =>
        instanceRoles.revoke(tx, {
          mandateInstanceId: b.instanceId,
          role: 'agent',
          address: b.roleAddress,
          eventId: a.eventId,
        }),
      ),
    ).toBe(false);
  },
  'deposits.record': async () => {
    const deposit = {
      mandateInstanceId: b.instanceId,
      fundingSourceId: null,
      amount: tokenAmount(1n, 'USDC', 'stellar'),
      fromAddress: 'GFROM',
    };
    // The same refusal whether the event exists and has its deposit or not, so
    // the answer says nothing about what B holds.
    for (const chainEventId of [b.eventId, randomUUID()]) {
      const attempt = indexing(a.first, async (tx) =>
        deposits.record(tx, { ...deposit, chainEventId }),
      );
      expect(await codeOf(attempt)).toBe('23503');
    }
  },
  'deposits.get': async () => {
    expect(await acrossA(async (tx) => deposits.get(tx, b.depositId))).toBeUndefined();
  },
  'deposits.list': async () => {
    const page = await acrossA(async (tx) => deposits.list(tx, { limit: 100 }));
    expect(page.items.map((deposit) => deposit.id)).toContain(a.depositId);
    expect(page.items.map((deposit) => deposit.id)).not.toContain(b.depositId);
  },
  'recipients.list': async () => {
    const page = await acrossA(async (tx) => recipients.list(tx, { limit: 100 }));
    expect(page.items.map((recipient) => recipient.id)).toContain(a.recipientId);
    expect(page.items.map((recipient) => recipient.id)).not.toContain(b.recipientId);
  },
  'recipients.get': async () => {
    expect(await acrossA(async (tx) => recipients.get(tx, b.recipientId))).toBeUndefined();
  },
  'recipients.create': async () => {
    const created = await asA(async (tx) =>
      recipients.create(tx, { recipientRef: randomBytes(32), country: 'KE' }),
    );
    expect(await ownerOf('ujira.recipients', 'id', created.id)).toBe(a.first.principalId);
  },
  'recipients.setStatus': async () => {
    expect(await asA(async (tx) => recipients.setStatus(tx, b.recipientId, 'erased'))).toBe(false);
  },
  'recipientPii.put': async () => {
    // The same refusal whether B's recipient has personal data stored or not,
    // so the answer says nothing about what B holds.
    const value = { ciphertext: randomBytes(16), nonce: randomBytes(12) };
    for (const recipientId of [b.recipientId, randomUUID()]) {
      const attempt = asA(async (tx) => recipientPii.put(tx, recipientId, value));
      expect(await codeOf(attempt)).toBe('23503');
    }
  },
  'recipientPii.get': async () => {
    expect(await asA(async (tx) => recipientPii.get(tx, b.recipientId))).toBeUndefined();
  },
  'recipientIdentities.list': async () => {
    expect(await acrossA(async (tx) => recipientIdentities.list(tx, b.recipientId))).toEqual([]);
  },
  'embedSessions.create': async () => {
    const attempt = asA(async (tx) =>
      embedSessions.create(tx, {
        tokenHash: randomBytes(32),
        tokenPrefix: `ujes_test_${randomUUID().slice(0, 8)}`,
        recipientId: b.recipientId,
        purpose: 'identity',
        allowedOrigins: ['https://app.example'],
        createdByToken: null,
        expiresAt: new Date('2027-01-15T09:00:00Z'),
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'embedSessions.get': async () => {
    expect(await acrossA(async (tx) => embedSessions.get(tx, b.sessionId))).toBeUndefined();
  },
  'walletChallenges.create': async () => {
    const attempt = asA(async (tx) =>
      walletChallenges.create(tx, {
        methodId: b.methodId,
        purpose: 'payout_destination',
        network: 'stellar:testnet',
        address: 'GINTRUDER',
        tag: null,
        recipientRef: randomBytes(32),
        requestId: randomUUID(),
        nonceHash: randomBytes(32),
        messageHash: randomBytes(32),
        issuedAt: new Date('2027-01-15T08:00:00Z'),
        expiresAt: new Date('2027-01-15T08:10:00Z'),
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'walletChallenges.get': async () => {
    expect(await acrossA(async (tx) => walletChallenges.get(tx, b.challengeId))).toBeUndefined();
  },
  'walletChallenges.consume': async () => {
    expect(await asA(async (tx) => walletChallenges.consume(tx, b.challengeId))).toBe(false);
  },
  'destinationVerifications.record': async () => {
    const attempt = asA(async (tx) =>
      destinationVerifications.record(tx, {
        methodId: b.methodId,
        level: 'partner_confirmed',
        chain: 'stellar',
        destinationAddress: 'GINTRUDER',
        destinationTag: null,
        partnerRef: 'intruder',
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'destinationVerifications.get': async () => {
    expect(
      await acrossA(async (tx) => destinationVerifications.get(tx, b.verificationId)),
    ).toBeUndefined();
  },
  'destinationVerifications.latest': async () => {
    expect(
      await acrossA(async (tx) => destinationVerifications.latest(tx, b.methodId)),
    ).toBeUndefined();
  },
  'attestations.insertPending': async () => {
    const attempt = asA(async (tx) =>
      attestations.insertPending(tx, {
        mandateInstanceId: b.instanceId,
        attemptId: randomUUID(),
        legIndex: 0,
        recipientId: b.recipientId,
        methodId: b.methodId,
        destinationAddress: 'GINTRUDER',
        destinationTag: null,
        countryPolicyHash: randomBytes(32),
        policyEpoch: 0n,
        validUntil: new Date('2027-01-16T08:00:00Z'),
        attesterKeyId: '0xintruder',
        digest: randomBytes(32),
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'attestations.get': async () => {
    expect(await acrossA(async (tx) => attestations.get(tx, b.attestationId))).toBeUndefined();
  },
  'attestations.markSigned': async () => {
    expect(
      await asA(async (tx) => attestations.markSigned(tx, b.attestationId, randomBytes(64))),
    ).toBe(false);
  },
  'attestations.markFailed': async () => {
    expect(await asA(async (tx) => attestations.markFailed(tx, b.attestationId, 'X'))).toBe(false);
  },
  'agentIdentityLinks.create': async () => {
    // A link names nothing of another tenant, so it lands in the caller's own.
    const link = await asA(async (tx) =>
      agentIdentityLinks.create(tx, {
        network: 'stellar:testnet',
        address: `G${randomUUID()}`,
        registry: 'registry-1',
        tokenId: 1n,
        displayName: null,
        humanBackedUntil: null,
      }),
    );
    expect(
      await db.tenant(b.first).transaction(async (tx) => agentIdentityLinks.get(tx, link.id)),
    ).toBeUndefined();
  },
  'agentIdentityLinks.get': async () => {
    expect(await acrossA(async (tx) => agentIdentityLinks.get(tx, b.agentLinkId))).toBeUndefined();
  },
  'agentIdentityLinks.setStatus': async () => {
    expect(await asA(async (tx) => agentIdentityLinks.setStatus(tx, b.agentLinkId, 'active'))).toBe(
      false,
    );
  },
  'recipientIdentities.get': async () => {
    expect(await acrossA(async (tx) => recipientIdentities.get(tx, b.identityId))).toBeUndefined();
  },
  'recipientIdentities.open': async () => {
    const attempt = asA(async (tx) =>
      recipientIdentities.open(tx, {
        recipientId: b.recipientId,
        provider: 'principal',
        providerAccount: null,
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'recipientIdentities.update': async () => {
    expect(
      await asA(async (tx) => recipientIdentities.update(tx, b.identityId, { state: 'revoked' })),
    ).toBeUndefined();
  },
  'recipientIdentities.verifiedByNullifier': async () => {
    const nullifier = randomBytes(32);
    await db
      .tenant(b.first)
      .transaction(async (tx) =>
        recipientIdentities.update(tx, b.identityId, { nullifierHmac: nullifier }),
      );
    expect(
      await acrossA(async (tx) => recipientIdentities.verifiedByNullifier(tx, nullifier)),
    ).toBeUndefined();
  },
  'recipientIdentities.erase': async () => {
    expect(await asA(async (tx) => recipientIdentities.erase(tx, b.recipientId))).toBe(0);
    const untouched = await db
      .tenant(b.first)
      .transaction(async (tx) => recipientIdentities.get(tx, b.identityId));
    expect(untouched?.state).toBe('verified');
  },
  'recipientIdentities.upsert': async () => {
    const attempt = asA(async (tx) =>
      recipientIdentities.upsert(tx, {
        recipientId: b.recipientId,
        chain: 'stellar',
        provider: 'self',
        providerRef: 'intruder',
        state: 'verified',
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'payoutMethods.list': async () => {
    const page = await acrossA(async (tx) => payoutMethods.list(tx, { limit: 100 }));
    expect(page.items.map((method) => method.id)).toContain(a.methodId);
    expect(page.items.map((method) => method.id)).not.toContain(b.methodId);
  },
  'payoutMethods.get': async () => {
    expect(await acrossA(async (tx) => payoutMethods.get(tx, b.methodId))).toBeUndefined();
  },
  'payoutMethods.create': async () => {
    const attempt = asA(async (tx) =>
      payoutMethods.create(tx, {
        recipientId: b.recipientId,
        method: 'stellar_wallet',
        rail: 'wallet',
        chain: 'stellar',
        destinationAddress: 'GINTRUDER',
        destinationTag: null,
        details: null,
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'payoutMethods.disable': async () => {
    expect(await asA(async (tx) => payoutMethods.disable(tx, b.methodId))).toBe(false);
  },
  'ledger.accounts': async () => {
    expect(await acrossA(async (tx) => ledger.accounts(tx, b.instanceId))).toEqual([]);
  },
  'ledger.post': async () => {
    // Naming B's instance and event is refused, and no account opens for it.
    const attempt = indexing(a.first, async (tx) =>
      ledger.post(tx, {
        mandateInstanceId: b.instanceId,
        chainEventId: b.eventId,
        entries: [
          { kind: 'external', amount: -5n },
          { kind: 'balance', amount: 5n },
        ],
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
    const balance = await admin.query<{ balance: string }>(
      'select balance from ujira.ledger_accounts where id = $1',
      [b.accountId],
    );
    expect(balance.rows[0]?.balance).toMatch(/^-?100$/);
  },
  'ledger.reverse': async () => {
    expect(await indexing(a.first, async (tx) => ledger.reverse(tx, b.journalId))).toBeUndefined();
  },
  'ledger.entries': async () => {
    const page = await acrossA(async (tx) => ledger.entries(tx, b.accountId, { limit: 100 }));
    expect(page.items).toEqual([]);
  },
  'ledger.recordState': async () => {
    const attempt = indexing(a.first, async (tx) =>
      ledger.recordState(tx, {
        mandateInstanceId: b.instanceId,
        ledger: 99n,
        balance: 0n,
        pending: 0n,
        committed: 0n,
        spent: 0n,
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'ledger.reconciliation': async () => {
    expect(await acrossA(async (tx) => ledger.reconciliation(tx, b.instanceId))).toBeUndefined();
    expect(await acrossA(async (tx) => ledger.reconciliation(tx, a.instanceId))).toBeDefined();
  },
  // The chain a row joins comes from the context, so a writer can only ever
  // reach its own: B's head does not move, and the rows land on A.
  'audit.record': async () => {
    const before = await admin.query<{ last_seq: string }>(
      'select last_seq from ujira.audit_heads where principal_id = $1',
      [b.first.principalId],
    );
    const written = await asA(async (tx) =>
      audit.record(tx, { action: 'project.changed', actor: { kind: 'system' } }),
    );
    expect(await ownerOf('ujira.audit_log', 'id', written.id)).toBe(a.first.principalId);
    const after = await admin.query<{ last_seq: string }>(
      'select last_seq from ujira.audit_heads where principal_id = $1',
      [b.first.principalId],
    );
    expect(after.rows).toEqual(before.rows);
  },
  'audit.list': async () => {
    const page = await acrossA(async (tx) => audit.list(tx, { limit: 100 }));
    expect(page.items.length).toBeGreaterThan(0);
    const owners = await admin.query<{ principal_id: string }>(
      'select distinct principal_id from ujira.audit_log where id = any($1::uuid[])',
      [page.items.map((item) => item.id)],
    );
    expect(owners.rows).toEqual([{ principal_id: a.first.principalId }]);
  },
  'audit.verify': async () => {
    const counted = await admin.query<{ count: string }>(
      'select count(*)::text as count from ujira.audit_log where principal_id = $1',
      [a.first.principalId],
    );
    const verification = await acrossA(async (tx) => audit.verify(tx));
    expect(verification.rows.toString()).toBe(counted.rows[0]?.count);
    expect(verification.firstBreak).toBeNull();
  },
  'payouts.create': async () => {
    const attempt = asA(async (tx) =>
      payouts.create(tx, {
        idempotencyKey: randomUUID(),
        recipientId: b.recipientId,
        mandateId: a.mandateId,
        method: 'stellar_wallet',
        requested: tokenAmount(50_000_000n, 'USDC', 'stellar'),
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'payouts.get': async () => {
    expect(await acrossA(async (tx) => payouts.get(tx, b.payoutId))).toBeUndefined();
    expect(await acrossA(async (tx) => payouts.get(tx, a.payoutId))).toBeDefined();
  },
  'payouts.list': async () => {
    const page = await acrossA(async (tx) => payouts.list(tx, { limit: 100 }));
    const ids = page.items.map((payout) => payout.id);
    expect(ids).toContain(a.payoutId);
    expect(ids).not.toContain(b.payoutId);
  },
  'payouts.transition': async () => {
    expect(
      await asA(async (tx) =>
        payouts.transition(tx, b.payoutId, { from: 'received', to: 'cancelled' }),
      ),
    ).toBeUndefined();
    expect(await statusOf('ujira.payouts', b.payoutId)).toBe('received');
  },
  'payoutBatches.create': async () => {
    const created = await asA(async (tx) =>
      payoutBatches.create(tx, { idempotencyKey: randomUUID(), items: [] }),
    );
    expect(await ownerOf('ujira.payout_batches', 'id', created.batch.id)).toBe(a.first.principalId);
  },
  'payoutBatches.get': async () => {
    expect(await acrossA(async (tx) => payoutBatches.get(tx, b.batchId))).toBeUndefined();
    expect(await acrossA(async (tx) => payoutBatches.get(tx, a.batchId))).toBeDefined();
  },
  'payoutAttempts.create': async () => {
    const attempt = asA(async (tx) =>
      payoutAttempts.create(tx, {
        payoutId: b.payoutId,
        mandateInstanceId: b.instanceId,
        network: 'stellar:testnet',
        total: tokenAmount(50_000_000n, 'USDC', 'stellar'),
        deadline: new Date(Date.now() + 3_600_000),
        legs: [
          {
            payoutMethodId: b.methodId,
            method: 'stellar_wallet',
            destinationAddress: 'GB',
            amount: 50_000_000n,
          },
        ],
      }),
    );
    expect(await codeOf(attempt)).toBe('UJ014');
  },
  'payoutLegs.forAttempt': async () => {
    expect(await acrossA(async (tx) => payoutLegs.forAttempt(tx, b.attemptId))).toEqual([]);
    expect(await acrossA(async (tx) => payoutLegs.forAttempt(tx, a.attemptId))).toHaveLength(1);
  },
  'payoutLegs.transition': async () => {
    expect(
      await asA(async (tx) =>
        payoutLegs.transition(tx, b.legId, { from: 'planned', to: 'submitted' }),
      ),
    ).toBeUndefined();
    expect(await statusOf('ujira.payout_legs', b.legId)).toBe('planned');
  },
  'approvals.record': async () => {
    const attempt = asA(async (tx) =>
      approvals.record(tx, {
        attemptId: b.attemptId,
        approver: 'GINTRUDER',
        decision: 'approved',
        signedMessageHash: randomBytes(32),
        signature: randomBytes(64),
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'approvals.forAttempt': async () => {
    expect(await acrossA(async (tx) => approvals.forAttempt(tx, b.attemptId))).toEqual([]);
    expect(await acrossA(async (tx) => approvals.forAttempt(tx, a.attemptId))).toHaveLength(1);
  },
  'payoutAttempts.get': async () => {
    expect(await acrossA(async (tx) => payoutAttempts.get(tx, b.attemptId))).toBeUndefined();
    expect(await acrossA(async (tx) => payoutAttempts.get(tx, a.attemptId))).toBeDefined();
  },
  'payoutAttempts.forPayout': async () => {
    expect(await acrossA(async (tx) => payoutAttempts.forPayout(tx, b.payoutId))).toEqual([]);
  },
  'payoutAttempts.transition': async () => {
    expect(
      await asA(async (tx) =>
        payoutAttempts.transition(tx, b.attemptId, { from: 'created', to: 'requested' }),
      ),
    ).toBeUndefined();
    expect(await statusOf('ujira.payout_attempts', b.attemptId)).toBe('created');
  },
  'payoutAttempts.markDead': async () => {
    expect(
      await asA(async (tx) =>
        payoutAttempts.markDead(tx, b.attemptId, {
          from: 'created',
          proof: { kind: 'tombstone' },
        }),
      ),
    ).toBeUndefined();
    expect(await statusOf('ujira.payout_attempts', b.attemptId)).toBe('created');
  },
  'fundingHolds.hold': async () => {
    expect(
      await asA(async (tx) =>
        fundingHolds.hold(tx, b.payoutId, [
          {
            mandateInstanceId: a.instanceId,
            network: 'stellar:testnet',
            needed: tokenAmount(50_000_000n, 'USDC', 'stellar'),
          },
        ]),
      ),
    ).toBe(false);
  },
  'fundingHolds.release': async () => {
    expect(await asA(async (tx) => fundingHolds.release(tx, b.heldPayoutId))).toBe(0);
    const left = await admin.query(
      'select 1 from ujira.payout_funding_holds where payout_id = $1',
      [b.heldPayoutId],
    );
    expect(left.rows).toHaveLength(1);
  },
  'fundingHolds.oldestOnNetwork': async () => {
    const holds = await acrossA(async (tx) =>
      fundingHolds.oldestOnNetwork(tx, 'stellar:testnet', 100),
    );
    const ids = holds.map((hold) => hold.payoutId);
    expect(ids).toContain(a.heldPayoutId);
    expect(ids).not.toContain(b.heldPayoutId);
  },
  'fundingHolds.inconsistentPayoutIds': async () => {
    await admin.query('begin');
    try {
      await admin.query('set local session_replication_role = replica');
      await admin.query(`update ujira.payouts set status_reason = null where id = $1`, [
        b.heldPayoutId,
      ]);
      await admin.query('commit');
      expect(await acrossA(async (tx) => fundingHolds.inconsistentPayoutIds(tx))).toEqual([]);
    } finally {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(
        `update ujira.payouts set status_reason = 'awaiting_funding' where id = $1`,
        [b.heldPayoutId],
      );
      await admin.query('commit');
    }
  },
  'payoutMinimums.list': async () => {
    const before = await asA(async (tx) => payoutMinimums.list(tx));
    expect(before.map((row) => row.setBy)).not.toContain(b.ownerUserId);
    expect(before.map((row) => row.setBy)).toContain(a.ownerUserId);
  },
  'payoutMinimums.set': async () => {
    const attempt = asA(async (tx) =>
      payoutMinimums.set(tx, {
        method: 'cash_pickup',
        minimum: { amount: 2000n, currency: 'USD', scale: 2 },
        memberId: b.ownerUserId,
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
};

describe('cross-tenant matrix', () => {
  it('has a case for every repository method, and none for a method that does not exist', () => {
    expect(caseProblems(REPOSITORIES, Object.keys(cases))).toEqual([]);
  });

  it('fails when a method is added without a case', () => {
    const grown = {
      ...REPOSITORIES,
      invoices: { post: () => undefined, note: 'not a method' },
    };
    expect(caseProblems(grown, Object.keys(cases))).toEqual([
      'invoices.post has no cross-tenant case',
    ]);
    expect(caseProblems(REPOSITORIES, [...Object.keys(cases), 'projects.delete'])).toEqual([
      'projects.delete is not a repository method',
    ]);
  });

  it.each(methodNames(REPOSITORIES))('%s cannot reach the other tenant', async (name) => {
    const run = cases[name];
    expect(run, name).toBeDefined();
    await run?.();
  });
});
