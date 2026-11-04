// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The cross-tenant matrix. Two principals with two projects each. Every
// repository method runs as tenant A against tenant B's ids and must find
// nothing, return a page without B's rows, or land its write in A.

import { randomBytes, randomUUID } from 'node:crypto';

import { tokenAmount } from '@ujira/core';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import type { Schema } from './schema.generated.js';
import { audit, auditRepositories } from './repositories/audit.js';
import { entryPoints } from './repositories/entry-points.js';
import { idempotencyKeys, idempotencyRepositories } from './repositories/idempotency.js';
import { fundingAccountRepositories, fundingAccounts } from './repositories/funding-accounts.js';
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
  payoutMethods,
  recipientIdentities,
  recipientPii,
  recipientRepositories,
  recipients,
} from './repositories/recipients.js';
import {
  outbox,
  outboxRepositories,
  webhookDeliveries,
  webhookEndpoints,
} from './repositories/outbox.js';
import {
  apiTokens,
  members,
  principals,
  projects,
  tenancyRepositories,
} from './repositories/tenancy.js';
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
  readonly journalId: string;
  readonly accountId: string;
  readonly recipientId: string;
  readonly identityId: string;
  readonly methodId: string;
  readonly outboxEventId: string;
  readonly endpointId: string;
}

const REPOSITORIES = {
  ...tenancyRepositories,
  ...mandateRepositories,
  ...fundingAccountRepositories,
  ...ledgerRepositories,
  ...recipientRepositories,
  ...auditRepositories,
  ...idempotencyRepositories,
  ...outboxRepositories,
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
  const { mandateId, instanceId, sourceId, accountSourceId, sweepId, fundingAccountId } = await db
    .tenant(first)
    .transaction(async (tx) => {
      const mandate = await mandates.create(tx, { name: `${name} mandate` });
      const instance = await mandateInstances.create(tx, {
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
        accountSourceId: account.id,
        sweepId: sweep.id,
        fundingAccountId: forwarder?.id ?? '',
      };
    });
  const eventTxHash = randomBytes(32);
  const roleAddress = `G${name}`;
  const { eventId, depositId, journalId, accountId } = await indexing(first, async (tx) => {
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
    };
  });
  const { outboxEventId, endpointId } = await db.tenant(first).transaction(async (tx) => {
    const event = await outbox.append(tx, { eventType: 'payout.held', payload: { name } });
    const endpoint = await webhookEndpoints.create(tx, {
      url: `https://example.com/${name}`,
      secretRef: `ref-${name}`,
      eventTypes: ['payout.held'],
    });
    await webhookDeliveries.record(tx, {
      endpointId: endpoint.id,
      eventId: event.id,
      attempt: 1,
      status: 'succeeded',
    });
    return { outboxEventId: event.id, endpointId: endpoint.id };
  });
  const { recipientId, identityId, methodId } = await db.tenant(first).transaction(async (tx) => {
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
      destinationAddress: `G${randomUUID()}`,
      destinationTag: null,
      details: null,
    });
    await audit.record(tx, { action: 'project.created', actor: { kind: 'system' } });
    return { recipientId: recipient.id, identityId: identity.id, methodId: method.id };
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
    journalId,
    accountId,
    recipientId,
    identityId,
    methodId,
    outboxEventId,
    endpointId,
  };
}

// The mirror tables are written by the indexer, under the tenant's context.
async function indexing<T>(
  context: ProjectContext,
  work: (tx: Kysely<Schema>) => Promise<T>,
): Promise<T> {
  return db.withTenant('worker', { ...context, scope: 'project' }, work);
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
  'outbox.append': async () => {
    const written = await asA(async (tx) =>
      outbox.append(tx, { eventType: 'payout.held', payload: {} }),
    );
    expect(await ownerOf('ujira.outbox_events', 'id', written.id)).toBe(a.first.principalId);
  },
  'outbox.after': async () => {
    // Under A's context nothing of B's is there to read, at any cursor.
    await vi.waitFor(async () => {
      const events = await acrossA(async (tx) => outbox.after(tx, 0n, 100));
      const ids = events.map((event) => event.id);
      expect(ids).toContain(a.outboxEventId);
      expect(ids).not.toContain(b.outboxEventId);
    });
  },
  'webhookEndpoints.create': async () => {
    const created = await asA(async (tx) =>
      webhookEndpoints.create(tx, {
        url: `https://example.com/${randomUUID()}`,
        secretRef: 'ref',
        eventTypes: ['payout.held'],
      }),
    );
    expect(await ownerOf('ujira.webhook_endpoints', 'id', created.id)).toBe(a.first.principalId);
  },
  'webhookEndpoints.get': async () => {
    expect(await acrossA(async (tx) => webhookEndpoints.get(tx, b.endpointId))).toBeUndefined();
    expect(await acrossA(async (tx) => webhookEndpoints.get(tx, a.endpointId))).toBeDefined();
  },
  'webhookEndpoints.list': async () => {
    const page = await acrossA(async (tx) => webhookEndpoints.list(tx, { limit: 100 }));
    const ids = page.items.map((endpoint) => endpoint.id);
    expect(ids).toContain(a.endpointId);
    expect(ids).not.toContain(b.endpointId);
  },
  'webhookEndpoints.setStatus': async () => {
    expect(await asA(async (tx) => webhookEndpoints.setStatus(tx, b.endpointId, 'disabled'))).toBe(
      false,
    );
    const row = await admin.query<{ status: string }>(
      'select status from ujira.webhook_endpoints where id = $1',
      [b.endpointId],
    );
    expect(row.rows[0]?.status).toBe('enabled');
  },
  'webhookDeliveries.record': async () => {
    // B's event is out of sight, so nothing is recorded against it.
    expect(
      await asA(async (tx) =>
        webhookDeliveries.record(tx, {
          endpointId: a.endpointId,
          eventId: b.outboxEventId,
          attempt: 9,
          status: 'failed',
        }),
      ),
    ).toBeUndefined();
    // A's own event with B's endpoint fails the composite foreign key.
    const attempt = asA(async (tx) =>
      webhookDeliveries.record(tx, {
        endpointId: b.endpointId,
        eventId: a.outboxEventId,
        attempt: 9,
        status: 'failed',
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'webhookDeliveries.forEvent': async () => {
    expect(
      await acrossA(async (tx) => webhookDeliveries.forEvent(tx, b.endpointId, b.outboxEventId)),
    ).toEqual([]);
    expect(
      await acrossA(async (tx) => webhookDeliveries.forEvent(tx, a.endpointId, a.outboxEventId)),
    ).toHaveLength(1);
  },
  'idempotencyKeys.reserve': async () => {
    // The same key in another tenant is a different key, however it was used.
    const key = randomUUID();
    const reserve = async (context: ProjectContext) =>
      db.tenant(context).transaction(async (tx) =>
        idempotencyKeys.reserve(tx, {
          key,
          requestSha256: Buffer.alloc(32, 1),
          leaseSeconds: 60,
        }),
      );
    expect((await reserve(b.first)).kind).toBe('started');
    expect((await reserve(a.first)).kind).toBe('started');
    const owners = await admin.query<{ principal_id: string }>(
      'select principal_id from ujira.idempotency_keys where idempotency_key = $1 order by 1',
      [key],
    );
    expect(owners.rows.map((row) => row.principal_id)).toEqual(
      [a.first.principalId, b.first.principalId].sort(),
    );
  },
  'idempotencyKeys.complete': async () => {
    const key = randomUUID();
    const held = await db.tenant(b.first).transaction(async (tx) =>
      idempotencyKeys.reserve(tx, {
        key,
        requestSha256: Buffer.alloc(32, 1),
        leaseSeconds: 60,
      }),
    );
    if (held.kind !== 'started') throw new Error('expected a lease');
    expect(
      await asA(async (tx) =>
        idempotencyKeys.complete(tx, {
          key,
          leaseId: held.leaseId,
          status: 201,
          requestId: 'req_intruder',
          body: '{}',
        }),
      ),
    ).toBe(false);
    const row = await admin.query<{ response_body: string | null }>(
      'select response_body from ujira.idempotency_keys where idempotency_key = $1',
      [key],
    );
    expect(row.rows).toEqual([{ response_body: null }]);
  },
  'idempotencyKeys.release': async () => {
    const key = randomUUID();
    const held = await db.tenant(b.first).transaction(async (tx) =>
      idempotencyKeys.reserve(tx, {
        key,
        requestSha256: Buffer.alloc(32, 1),
        leaseSeconds: 60,
      }),
    );
    if (held.kind !== 'started') throw new Error('expected a lease');
    expect(
      await asA(async (tx) => idempotencyKeys.release(tx, { key, leaseId: held.leaseId })),
    ).toBe(false);
    const row = await admin.query<{ running: boolean }>(
      'select lease_expires_at > now() as running from ujira.idempotency_keys where idempotency_key = $1',
      [key],
    );
    expect(row.rows).toEqual([{ running: true }]);
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
  'mandateInstances.create': async () => {
    // Naming B's mandate is a tenant violation at the composite foreign key.
    const attempt = asA(async (tx) =>
      mandateInstances.create(tx, {
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
    const across = await acrossA(async (tx) => fundingAccounts.forNetwork(tx, 'stellar:testnet'));
    expect(across?.id).toBe(a.fundingAccountId);
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
    // And another tenant's instance fails its key, with the tenant on the row.
    const attempt = asA(async (tx) =>
      fundingAccounts.attach(tx, {
        accountId: a.fundingAccountId,
        mandateInstanceId: b.instanceId,
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
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
