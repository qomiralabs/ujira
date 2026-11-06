// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The shared identity contract against Postgres, through the same ports the
// identity package runs it against in memory. Rows are seeded through the
// repositories as the services that own them would write them.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { TenantScope, Uuid } from '@ujira/chain-adapter';
import { ed25519PublicKey } from '@ujira/chain-adapter/testing';
import { tokenAmount } from '@ujira/core';
import { countryPolicyHash } from '@ujira/identity';
import {
  IDENTITY_CONTRACT_CASES,
  TEST_ATTESTER_SEED,
  TEST_NOW,
  accountOf,
  contractOf,
} from '@ujira/identity/testing';
import type { ContractBackend, ContractSeed, ContractTenant } from '@ujira/identity/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  databaseAttestationLog,
  databaseIdentityStore,
  databasePayoutLegSource,
  databaseProviderEventStore,
} from './identity-store.js';
import { entryPoints } from './repositories/entry-points.js';
import { destinationVerifications } from './repositories/identity-evidence.js';
import { mandateInstances, mandates } from './repositories/mandates.js';
import { payoutAttempts, payouts } from './repositories/payouts.js';
import { payoutMethods, recipientIdentities, recipients } from './repositories/recipients.js';
import { projects } from './repositories/tenancy.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

async function seed(options: ContractSeed = {}): Promise<ContractTenant> {
  const tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Contract',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
  const scope = {
    principalId: tenant.principalId as Uuid,
    projectId: tenant.projectId as Uuid,
  };
  const seeded = await db.tenant(scope).transaction(async (tx) => {
    const recipient = await recipients.create(tx, { recipientRef: randomBytes(32), country: 'NG' });
    if (options.recipientActive === false) {
      await recipients.setStatus(tx, recipient.id, 'suspended');
    }
    const address = accountOf(`wallet:${recipient.id}`);
    const method = await payoutMethods.create(tx, {
      recipientId: recipient.id,
      method: 'stellar_wallet',
      rail: 'wallet',
      chain: 'stellar',
      destinationAddress: address,
      destinationTag: null,
      details: null,
    });
    const mandate = await mandates.create(tx, {
      name: 'Attested',
      countryPolicy: { mode: 'allow', countries: ['GH', 'KE', 'NG'] },
    });
    const instance = await mandateInstances.create(tx, {
      mandateId: mandate.id,
      chain: 'stellar',
      network: 'stellar:testnet',
      contractAddress: contractOf(`mandate:${tenant.projectId}`),
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
      attesterPublicKey: Buffer.from(ed25519PublicKey(TEST_ATTESTER_SEED)),
    });
    const kind = options.identity ?? 'verified';
    const identityId = kind === 'none' ? null : randomUUID();
    if (identityId !== null) {
      await recipientIdentities.create(tx, {
        id: identityId,
        recipientId: recipient.id,
        provider: 'self',
        providerAccount: null,
        state: kind === 'pending' ? 'pending' : 'verified',
        assurance: 'document_zk',
        expiresAt: kind === 'expired' ? new Date(Number(TEST_NOW - 1n) * 1000) : null,
      });
    }
    const verification =
      options.verified === false
        ? null
        : await destinationVerifications.record(tx, {
            methodId: method.id,
            level: 'wallet_signature',
            chain: 'stellar',
            destinationAddress: address,
            destinationTag: null,
            scheme: 'sep53',
            signerKey: address,
          });
    if (options.settings !== undefined) {
      await projects.setIdentitySettings(tx, options.settings);
    }
    const amount = tokenAmount(25_000_000n, 'USDC', 'stellar');
    const { payout } = await payouts.create(tx, {
      recipientId: recipient.id,
      mandateId: mandate.id,
      method: 'stellar_wallet',
      requested: amount,
      idempotencyKey: randomUUID(),
    });
    const attempt = await payoutAttempts.create(tx, {
      payoutId: payout.id,
      mandateInstanceId: instance.id,
      network: 'stellar:testnet',
      total: amount,
      deadline: new Date(Date.now() + 3_600_000),
      legs: [
        {
          payoutMethodId: method.id,
          method: 'stellar_wallet',
          destinationAddress: address,
          amount: 25_000_000n,
        },
      ],
    });
    return {
      scope,
      instanceId: instance.id as Uuid,
      recipientId: recipient.id as Uuid,
      methodId: method.id as Uuid,
      identityId: identityId as Uuid | null,
      verificationId: (verification?.id ?? null) as Uuid | null,
      attemptId: attempt.id as Uuid,
      legIndex: 0,
      address,
    };
  });
  // As the table's owner: no login the API holds can move an instance, because only
  // the chain says whether one is live.
  await admin.query('update ujira.mandate_instances set status = $1 where id = $2', [
    options.instanceStatus ?? 'active',
    seeded.instanceId,
  ]);
  return seeded;
}

function backend(): ContractBackend {
  return {
    store: databaseIdentityStore(db, { networkOfChain: { stellar: 'stellar:testnet' } }),
    log: databaseAttestationLog(db),
    legs: databasePayoutLegSource(db),
    events: databaseProviderEventStore(db),
    seed,
    // What the signer asks, by the digest the row keeps.
    async isPending(message, attesterKeyId) {
      const digest = createHash('sha256').update(message).digest();
      const result = await admin.query(
        `select 1 from ujira.attestations
          where digest = $1 and attester_key_id = $2 and status = 'pending'`,
        [digest, attesterKeyId],
      );
      return result.rows.length > 0;
    },
    async attestationStatuses(scope: TenantScope) {
      const result = await admin.query<{ status: string }>(
        `select status from ujira.attestations
          where principal_id = $1 and project_id = $2
          order by created_at, id`,
        [scope.principalId, scope.projectId],
      );
      return result.rows.map((row) => row.status);
    },
  };
}

describe('the identity contract, against Postgres', () => {
  it.each(IDENTITY_CONTRACT_CASES.map((entry) => [entry.name, entry] as const))(
    '%s',
    async (_name, entry) => {
      expect(await entry.run(backend())).toEqual(entry.expected);
    },
    60_000,
  );
});

describe('the database identity store', () => {
  it('reads a method on a chain the deployment does not pay on as absent', async () => {
    const tenant = await seed();
    const store = databaseIdentityStore(db, { networkOfChain: {} });
    expect(await store.payoutMethod(tenant.scope, tenant.methodId)).toBeNull();
  });

  it('reads an anchor method as absent, until methods record their anchor', async () => {
    const tenant = await seed();
    const methodId = await db.tenant(tenant.scope).transaction(async (tx) => {
      const method = await payoutMethods.create(tx, {
        recipientId: tenant.recipientId,
        method: 'bank',
        rail: 'anchor',
        chain: 'stellar',
        destinationAddress: accountOf(`anchor:${tenant.recipientId}`),
        destinationTag: null,
        details: null,
      });
      return method.id;
    });
    const store = backend().store;
    expect(await store.payoutMethod(tenant.scope, methodId as Uuid)).toBeNull();
  });

  it('reads an instance still deploying as pending, and one with no attester as allowlist', async () => {
    const tenant = await seed();
    const instanceId = await db.tenant(tenant.scope).transaction(async (tx) => {
      const mandate = await mandates.create(tx, { name: 'Listed' });
      const instance = await mandateInstances.create(tx, {
        mandateId: mandate.id,
        chain: 'stellar',
        network: 'stellar:testnet',
        contractAddress: contractOf(`listed:${tenant.recipientId}`),
        specVersion: '1',
        asset: 'USDC',
        scale: 7,
      });
      return instance.id;
    });
    const read = await backend().store.mandateInstance(tenant.scope, instanceId as Uuid);
    expect(read).toMatchObject({ status: 'pending', recipientMode: 'allowlist' });
  });

  it('keeps the policy hash the attester recomputes from the stored list', async () => {
    const tenant = await seed();
    const read = await backend().store.mandateInstance(tenant.scope, tenant.instanceId);
    expect(read?.countryPolicyHash).toBe(countryPolicyHash(read?.countryPolicy.countries ?? []));
  });

  it('reads saved project settings back as saved', async () => {
    const tenant = await seed({ settings: { recipientRequirement: 'none' } });
    expect(await backend().store.projectSettings(tenant.scope)).toEqual({
      recipientRequirement: 'none',
    });
  });

  it('finds no identity for an id that is no row of ours', async () => {
    expect(await backend().store.identityById(randomUUID() as Uuid)).toBeNull();
  });
});
