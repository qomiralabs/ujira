// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomBytes, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import {
  payoutMethods,
  recipientIdentities,
  recipientPii,
  recipients,
  type NewPayoutMethod,
} from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const U64_MAX = 18446744073709551615n;

let database: TestDatabase;
let db: Database;
let tenant: CreatedPrincipal;
let recipientId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function method(overrides: Partial<NewPayoutMethod> = {}): NewPayoutMethod {
  return {
    recipientId,
    method: 'stellar_wallet',
    rail: 'wallet',
    chain: 'stellar',
    destinationAddress: `G${randomUUID()}`,
    destinationTag: null,
    details: null,
    ...overrides,
  };
}

async function create(input: NewPayoutMethod) {
  return db.tenant(tenant).transaction(async (tx) => payoutMethods.create(tx, input));
}

// Inserts a row past the repository, which always keeps the flag and the tag in
// step, so the constraint itself is what is being tested.
async function insertRaw(hasTag: boolean, tag: string | null): Promise<void> {
  await db.tenant(tenant).transaction(async (tx) => {
    await sql`
      insert into ujira.payout_methods
        (principal_id, project_id, recipient_id, method, rail, chain, destination_address, has_tag, destination_tag)
      values
        (${tenant.principalId}, ${tenant.projectId}, ${recipientId}, 'stellar_wallet', 'wallet', 'stellar',
         ${`G${randomUUID()}`}, ${hasTag}, ${tag}::numeric)
    `.execute(tx);
  });
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
  const recipient = await db
    .tenant(tenant)
    .transaction(async (tx) =>
      recipients.create(tx, { recipientRef: randomBytes(32), country: 'NG' }),
    );
  recipientId = recipient.id;
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('payout method destinations', () => {
  it('has_tag false with tag 5 is rejected', async () => {
    expect(await codeOf(insertRaw(false, '5'))).toBe('23514');
  });

  it('has_tag true with no tag is rejected', async () => {
    expect(await codeOf(insertRaw(true, null))).toBe('23514');
  });

  it('holds the widest tag exactly, and refuses one past it', async () => {
    const created = await create(method({ destinationTag: U64_MAX }));
    expect(created.destinationTag).toBe(U64_MAX);
    expect(await codeOf(create(method({ destinationTag: U64_MAX + 1n })))).toBe('23514');
    expect(await codeOf(create(method({ destinationTag: -1n })))).toBe('23514');
  });

  it('accepts no tag, and tag 0, which is a tag', async () => {
    expect((await create(method())).destinationTag).toBeNull();
    expect((await create(method({ destinationTag: 0n }))).destinationTag).toBe(0n);
  });

  it('accepts each method on the settled list and refuses anything else', async () => {
    for (const kind of ['stellar_wallet', 'bank', 'mobile_money', 'cash_pickup'] as const) {
      expect((await create(method({ method: kind }))).method).toBe(kind);
    }
    expect(await codeOf(create(method({ method: 'cash' as 'bank' })))).toBe('23514');
  });

  it('refuses a chain the reference data does not have', async () => {
    expect(await codeOf(create(method({ chain: 'celo' })))).toBe('23503');
  });

  it('keeps encrypted details whole', async () => {
    const details = { ciphertext: randomBytes(40), nonce: randomBytes(12) };
    expect((await create(method({ details }))).details).toEqual(details);
    expect(
      await codeOf(
        create(method({ details: { ciphertext: randomBytes(4), nonce: randomBytes(11) } })),
      ),
    ).toBe('23514');
  });

  it('disables once, and pages', async () => {
    const created = await create(method());
    const session = db.tenant(tenant);
    expect(await session.transaction(async (tx) => payoutMethods.disable(tx, created.id))).toBe(
      true,
    );
    expect(await session.transaction(async (tx) => payoutMethods.disable(tx, created.id))).toBe(
      false,
    );
    expect(
      (await session.transaction(async (tx) => payoutMethods.get(tx, created.id)))?.status,
    ).toBe('disabled');
    const first = await session.transaction(async (tx) => payoutMethods.list(tx, { limit: 1 }));
    expect(first.items).toHaveLength(1);
    const after = first.next ?? '';
    const rest = await session.transaction(async (tx) =>
      payoutMethods.list(tx, { limit: 100, after }),
    );
    expect(rest.items.map((item) => item.id)).not.toContain(first.items[0]?.id);
  });
});

// What the chain adapter may send a payout leg to. Anything it cannot answer for, it
// answers nothing for, and the adapter refuses the leg rather than guess.
describe('what a payout can be sent to', () => {
  const payable = (id: string, chain = 'stellar') =>
    db.tenant(tenant).transaction(async (tx) => payoutMethods.payable(tx, id, chain));

  it('answers for an active wallet method on the chain, with its tag', async () => {
    const created = await create(method({ destinationTag: 7n }));
    expect(await payable(created.id)).toEqual({
      destinationAddress: created.destinationAddress,
      destinationTag: 7n,
    });
  });

  it('answers nothing for a disabled method', async () => {
    const created = await create(method());
    await db.tenant(tenant).transaction(async (tx) => payoutMethods.disable(tx, created.id));
    expect(await payable(created.id)).toBeUndefined();
  });

  it('answers nothing for an anchor method, which no wallet leg can reach', async () => {
    const created = await create(method({ method: 'bank', rail: 'anchor' }));
    expect(await payable(created.id)).toBeUndefined();
  });

  it('answers nothing on another chain than the method is on', async () => {
    const created = await create(method());
    expect(await payable(created.id, 'celo')).toBeUndefined();
  });

  it('answers nothing once its recipient is no longer active', async () => {
    const other = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        recipients.create(tx, { recipientRef: randomBytes(32), country: 'NG' }),
      );
    const created = await create(method({ recipientId: other.id }));
    expect(await payable(created.id)).toBeDefined();
    await db
      .tenant(tenant)
      .transaction(async (tx) => recipients.setStatus(tx, other.id, 'suspended'));
    expect(await payable(created.id)).toBeUndefined();
  });

  it("answers nothing for another tenant's method", async () => {
    const created = await create(method());
    const stranger = await db.unscoped(async (tx) =>
      entryPoints.createPrincipal(tx, {
        name: 'Other',
        projectName: 'Main',
        ownerUserId: randomUUID(),
      }),
    );
    expect(
      await db
        .tenant(stranger)
        .transaction(async (tx) => payoutMethods.payable(tx, created.id, 'stellar')),
    ).toBeUndefined();
  });
});

describe('recipients', () => {
  it('holds one recipient per ref in a project, and checks the country', async () => {
    const recipientRef = randomBytes(32);
    const session = db.tenant(tenant);
    const created = await session.transaction(async (tx) =>
      recipients.create(tx, { recipientRef, country: 'KE' }),
    );
    expect(created.recipientRef).toEqual(recipientRef);
    expect(
      await codeOf(
        session.transaction(async (tx) => recipients.create(tx, { recipientRef, country: 'KE' })),
      ),
    ).toBe('23505');
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          recipients.create(tx, { recipientRef: randomBytes(32), country: 'Nigeria' }),
        ),
      ),
    ).toBe('23514');
    expect(
      await session.transaction(async (tx) => recipients.setStatus(tx, created.id, 'suspended')),
    ).toBe(true);
    expect((await session.transaction(async (tx) => recipients.get(tx, created.id)))?.status).toBe(
      'suspended',
    );
    const first = await session.transaction(async (tx) => recipients.list(tx, { limit: 1 }));
    const after = first.next ?? '';
    const rest = await session.transaction(async (tx) =>
      recipients.list(tx, { limit: 100, after }),
    );
    expect(rest.items.map((item) => item.id)).not.toContain(first.items[0]?.id);
  });
});

describe('recipient_pii', () => {
  it('stores ciphertext, replaces it, and refuses a bad nonce', async () => {
    const session = db.tenant(tenant);
    const value = { ciphertext: randomBytes(64), nonce: randomBytes(12) };
    await session.transaction(async (tx) => recipientPii.put(tx, recipientId, value));
    expect(await session.transaction(async (tx) => recipientPii.get(tx, recipientId))).toEqual(
      value,
    );
    const next = { ciphertext: randomBytes(64), nonce: randomBytes(12) };
    await session.transaction(async (tx) => recipientPii.put(tx, recipientId, next));
    expect(await session.transaction(async (tx) => recipientPii.get(tx, recipientId))).toEqual(
      next,
    );
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          recipientPii.put(tx, recipientId, { ciphertext: randomBytes(4), nonce: randomBytes(8) }),
        ),
      ),
    ).toBe('23514');
  });

  it('is not readable by the reader', async () => {
    const read = db.principal(tenant).transaction(async (tx) => recipientPii.get(tx, recipientId));
    expect(await codeOf(read)).toBe('42501');
  });
});

describe('recipient identities', () => {
  it('holds one per recipient, chain and provider, and follows the provider', async () => {
    const session = db.tenant(tenant);
    const input = {
      recipientId,
      chain: 'stellar',
      provider: 'self',
      providerRef: 'ref-1',
      state: 'pending' as const,
    };
    const first = await session.transaction(async (tx) => recipientIdentities.upsert(tx, input));
    const next = await session.transaction(async (tx) =>
      recipientIdentities.upsert(tx, { ...input, state: 'verified' }),
    );
    expect(next.id).toBe(first.id);
    expect(next.state).toBe('verified');
    const all = await session.transaction(async (tx) => recipientIdentities.list(tx, recipientId));
    expect(all.filter((identity) => identity.provider === 'self')).toHaveLength(1);
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          recipientIdentities.upsert(tx, { ...input, state: 'approved' as 'verified' }),
        ),
      ),
    ).toBe('23514');
  });
});
