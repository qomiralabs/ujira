// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { walletChallenges, type NewWalletChallenge } from './repositories/identity-evidence.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { codeOf, evidenceWorld, type EvidenceWorld } from './testing/evidence-world.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let world: EvidenceWorld;

function challenge(overrides: Partial<NewWalletChallenge> = {}): NewWalletChallenge {
  const issuedAt = new Date('2027-01-15T08:00:00Z');
  return {
    methodId: world.methodId,
    purpose: 'payout_destination',
    network: 'stellar:testnet',
    address: world.address,
    tag: null,
    recipientRef: randomBytes(32),
    requestId: randomUUID(),
    nonceHash: randomBytes(32),
    messageHash: randomBytes(32),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 600_000),
    ...overrides,
  };
}

const create = (input: NewWalletChallenge) =>
  db.tenant(world.tenant).transaction(async (tx) => walletChallenges.create(tx, input));

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  world = await evidenceWorld(db);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('wallet proof challenges', () => {
  it('reads back what was issued, unconsumed', async () => {
    const input = challenge({ tag: 18446744073709551615n });
    const row = await create(input);
    expect(row).toMatchObject({
      methodId: world.methodId,
      purpose: 'payout_destination',
      network: 'stellar:testnet',
      tag: 18446744073709551615n,
      expiresAt: input.expiresAt,
      consumedAt: null,
    });
    expect(row.nonceHash.equals(input.nonceHash)).toBe(true);
    const reread = await db
      .tenant(world.tenant)
      .transaction(async (tx) => walletChallenges.get(tx, row.id));
    expect(reread?.messageHash.equals(input.messageHash)).toBe(true);
  });

  it('a duplicate nonce hash is refused', async () => {
    const nonceHash = randomBytes(32);
    await create(challenge({ nonceHash }));
    expect(await codeOf(create(challenge({ nonceHash })))).toBe('23505');
  });

  it('a challenge with no method is for a wallet that is not a payout method', async () => {
    const row = await create(challenge({ methodId: null, purpose: 'member_wallet' }));
    expect(row.methodId).toBeNull();
  });

  it('is consumed once, however many race for it', async () => {
    const row = await create(challenge());
    const consume = () =>
      db.tenant(world.tenant).transaction(async (tx) => walletChallenges.consume(tx, row.id));
    const results = await Promise.all([consume(), consume(), consume()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await consume()).toBe(false);
    const reread = await db
      .tenant(world.tenant)
      .transaction(async (tx) => walletChallenges.get(tx, row.id));
    expect(reread?.consumedAt).toBeInstanceOf(Date);
  });

  it('refuses a bad purpose, network or hash, and an expiry before the issue', async () => {
    const issuedAt = new Date('2027-01-15T08:00:00Z');
    const bad: Partial<NewWalletChallenge>[] = [
      { purpose: 'login' as 'member_wallet' },
      { network: 'testnet' },
      { nonceHash: randomBytes(31) },
      { messageHash: randomBytes(33) },
      { issuedAt, expiresAt: issuedAt },
    ];
    for (const overrides of bad) {
      expect(await codeOf(create(challenge(overrides)))).toBe('23514');
    }
  });

  it('a method of another tenant cannot be named', async () => {
    const other = await evidenceWorld(db);
    expect(await codeOf(create(challenge({ methodId: other.methodId })))).toBe('23503');
  });
});
