// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// ujira.managed_signers holds the agent keys UJIRA holds for principals who
// opted in, as references only. One active key per agent and network, one key
// per account, a consent from a real member of the same principal, a life that
// only moves forward, and a row that keeps what it names.

import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import { managedSigners } from './repositories/signers.js';
import type { NewManagedSigner } from './repositories/signers.js';
import type { Schema } from './schema.generated.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const NETWORK = 'stellar:testnet';

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let tenant: ProjectContext;
let member: string;
let otherMember: string;
let sequence = 0;

const asTenant = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.tenant(tenant).transaction(work);

function address(): string {
  sequence += 1;
  return `G${String(sequence).padStart(55, 'A')}`;
}

function newSigner(change: Partial<NewManagedSigner> = {}): NewManagedSigner {
  return {
    network: NETWORK,
    agentId: randomUUID(),
    keyRef: `alias/agent-${randomUUID()}`,
    address: address(),
    consentedByMemberId: member,
    ...change,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  member = randomUUID();
  otherMember = randomUUID();
  const created = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, { name: 'alpha', projectName: 'one', ownerUserId: member }),
  );
  tenant = { principalId: created.principalId, projectId: created.projectId };
  await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'bravo',
      projectName: 'one',
      ownerUserId: otherMember,
    }),
  );
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('ujira.managed_signers', () => {
  it('records a key by reference, active, with its consent', async () => {
    const input = newSigner();
    const signer = await asTenant(async (tx) => managedSigners.create(tx, input));
    expect(signer).toMatchObject({ ...input, status: 'active', projectId: tenant.projectId });
    expect(
      await asTenant(async (tx) =>
        managedSigners.active(tx, { network: NETWORK, agentId: input.agentId }),
      ),
    ).toEqual(signer);
    expect(await asTenant(async (tx) => managedSigners.get(tx, signer.id))).toEqual(signer);
    const page = await asTenant(async (tx) => managedSigners.list(tx, { limit: 100 }));
    expect(page.items.map((row) => row.id)).toContain(signer.id);
  });

  it('a second active key for the same agent and network is refused', async () => {
    const first = newSigner();
    await asTenant(async (tx) => managedSigners.create(tx, first));
    expect(
      await codeOf(
        asTenant(async (tx) => managedSigners.create(tx, newSigner({ agentId: first.agentId }))),
      ),
    ).toBe('23505');
    // Another network is another key.
    await asTenant(async (tx) =>
      managedSigners.create(tx, newSigner({ agentId: first.agentId, network: 'stellar:pubnet' })),
    );
  });

  it('allows a replacement beside a retiring key, and finds only the active one', async () => {
    const old = newSigner();
    const signer = await asTenant(async (tx) => managedSigners.create(tx, old));
    expect(await asTenant(async (tx) => managedSigners.setStatus(tx, signer.id, 'retiring'))).toBe(
      true,
    );
    const replacement = await asTenant(async (tx) =>
      managedSigners.create(tx, newSigner({ agentId: old.agentId })),
    );
    const active = await asTenant(async (tx) =>
      managedSigners.active(tx, { network: NETWORK, agentId: old.agentId }),
    );
    expect(active?.id).toBe(replacement.id);
  });

  it('refuses an account another key already controls on that network', async () => {
    const taken = address();
    await asTenant(async (tx) => managedSigners.create(tx, newSigner({ address: taken })));
    expect(
      await codeOf(
        asTenant(async (tx) => managedSigners.create(tx, newSigner({ address: taken }))),
      ),
    ).toBe('23505');
    await asTenant(async (tx) =>
      managedSigners.create(tx, newSigner({ address: taken, network: 'stellar:pubnet' })),
    );
  });

  it('refuses a consent from anyone who is not a member of this principal', async () => {
    for (const consentedByMemberId of [otherMember, randomUUID()]) {
      expect(
        await codeOf(
          asTenant(async (tx) => managedSigners.create(tx, newSigner({ consentedByMemberId }))),
        ),
      ).toBe('23503');
    }
  });

  it.each([
    ['a Stellar secret seed', `S${'A'.repeat(55)}`],
    ['a URL', 'https://kms.example/key'],
    ['something with spaces', 'not a key name'],
  ])('refuses %s as a key reference', async (_label, keyRef) => {
    expect(
      await codeOf(asTenant(async (tx) => managedSigners.create(tx, newSigner({ keyRef })))),
    ).toBe('23514');
  });

  it('moves only forward through its life', async () => {
    const signer = await asTenant(async (tx) => managedSigners.create(tx, newSigner()));
    expect(await asTenant(async (tx) => managedSigners.setStatus(tx, signer.id, 'retired'))).toBe(
      true,
    );
    expect(
      await codeOf(asTenant(async (tx) => managedSigners.setStatus(tx, signer.id, 'retiring'))),
    ).toBe('UJ004');
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx
            .updateTable('ujira.managed_signers')
            .set({ status: 'active' })
            .where('id', '=', signer.id)
            .execute(),
        ),
      ),
    ).toBe('UJ004');
  });

  it.each([
    ['key_ref', { key_ref: 'alias/other' }],
    ['address', { address: 'GOTHER' }],
    ['agent_id', { agent_id: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' }],
    ['network', { network: 'stellar:pubnet' }],
  ])('keeps its %s once written', async (_label, change) => {
    const signer = await asTenant(async (tx) => managedSigners.create(tx, newSigner()));
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx.updateTable('ujira.managed_signers').set(change).where('id', '=', signer.id).execute(),
        ),
      ),
    ).toBe('UJ006');
  });

  it('cannot be deleted by the app', async () => {
    const signer = await asTenant(async (tx) => managedSigners.create(tx, newSigner()));
    expect(
      await codeOf(
        asTenant(async (tx) =>
          tx.deleteFrom('ujira.managed_signers').where('id', '=', signer.id).execute(),
        ),
      ),
    ).toBe('42501');
  });

  it('reports what it has no row for', async () => {
    expect(await asTenant(async (tx) => managedSigners.get(tx, randomUUID()))).toBeUndefined();
    expect(
      await asTenant(async (tx) =>
        managedSigners.active(tx, { network: NETWORK, agentId: randomUUID() }),
      ),
    ).toBeUndefined();
    expect(
      await asTenant(async (tx) => managedSigners.setStatus(tx, randomUUID(), 'retired')),
    ).toBe(false);
  });

  it('pages through its rows', async () => {
    await asTenant(async (tx) => managedSigners.create(tx, newSigner()));
    await asTenant(async (tx) => managedSigners.create(tx, newSigner()));
    const first = await asTenant(async (tx) => managedSigners.list(tx, { limit: 1 }));
    expect(first.items).toHaveLength(1);
    const after = first.next ?? '';
    expect(after).not.toBe('');
    const second = await asTenant(async (tx) => managedSigners.list(tx, { limit: 1, after }));
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });
});
