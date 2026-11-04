// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomBytes, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  destinationVerifications,
  embedSessions,
  walletChallenges,
  type NewDestinationVerification,
} from './repositories/identity-evidence.js';
import { payoutMethods } from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { codeOf, evidenceWorld, type EvidenceWorld } from './testing/evidence-world.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

// The shape of a key, made up for these tests.
const SIGNER = `G${'A'.repeat(55)}`;

let database: TestDatabase;
let db: Database;
let world: EvidenceWorld;

function verification(
  overrides: Partial<NewDestinationVerification> = {},
): NewDestinationVerification {
  return {
    methodId: world.methodId,
    level: 'partner_confirmed',
    chain: 'stellar',
    destinationAddress: world.address,
    destinationTag: null,
    partnerRef: 'partner-1',
    ...overrides,
  };
}

const record = (input: NewDestinationVerification) =>
  db.tenant(world.tenant).transaction(async (tx) => destinationVerifications.record(tx, input));

async function newMethod(): Promise<string> {
  const method = await db.tenant(world.tenant).transaction(async (tx) =>
    payoutMethods.create(tx, {
      recipientId: world.recipientId,
      method: 'stellar_wallet',
      rail: 'wallet',
      chain: 'stellar',
      destinationAddress: `G${randomUUID()}`,
      destinationTag: null,
      details: null,
    }),
  );
  return method.id;
}

async function newChallenge(): Promise<string> {
  const row = await db.tenant(world.tenant).transaction(async (tx) =>
    walletChallenges.create(tx, {
      methodId: world.methodId,
      purpose: 'payout_destination',
      network: 'stellar:testnet',
      address: world.address,
      tag: null,
      recipientRef: randomBytes(32),
      requestId: randomUUID(),
      nonceHash: randomBytes(32),
      messageHash: randomBytes(32),
      issuedAt: new Date('2027-01-15T08:00:00Z'),
      expiresAt: new Date('2027-01-15T08:10:00Z'),
    }),
  );
  return row.id;
}

async function newSession(): Promise<string> {
  const session = await db.tenant(world.tenant).transaction(async (tx) =>
    embedSessions.create(tx, {
      tokenHash: randomBytes(32),
      tokenPrefix: `ujes_test_${randomUUID().slice(0, 8)}`,
      recipientId: world.recipientId,
      purpose: 'onboarding',
      allowedOrigins: ['https://app.example'],
      createdByToken: null,
      expiresAt: new Date('2027-01-15T09:00:00Z'),
    }),
  );
  return session.id;
}

function sep53(challengeId: string | null, signature = 'c2lnbmF0dXJl') {
  return verification({
    level: 'wallet_signature',
    partnerRef: null,
    scheme: 'sep53',
    signerKey: SIGNER,
    signature,
    challengeId,
  });
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  world = await evidenceWorld(db);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('destination verifications', () => {
  it('reads back a proof, with its signer, scheme and challenge', async () => {
    const challengeId = await newChallenge();
    const row = await record(sep53(challengeId));
    expect(row).toMatchObject({
      methodId: world.methodId,
      level: 'wallet_signature',
      scheme: 'sep53',
      signerKey: SIGNER,
      challengeId,
      destinationTag: null,
      partnerRef: null,
    });
    const reread = await db
      .tenant(world.tenant)
      .transaction(async (tx) => destinationVerifications.get(tx, row.id));
    expect(reread?.id).toBe(row.id);
  });

  it('the latest row for a method is its current evidence', async () => {
    const methodId = await newMethod();
    const latest = () =>
      db
        .tenant(world.tenant)
        .transaction(async (tx) => destinationVerifications.latest(tx, methodId));
    expect(await latest()).toBeUndefined();
    await record(verification({ methodId, partnerRef: 'first' }));
    const second = await record(verification({ methodId, partnerRef: 'second' }));
    expect((await latest())?.id).toBe(second.id);
  });

  it('keeps a tag exactly', async () => {
    const methodId = await newMethod();
    const row = await record(verification({ methodId, destinationTag: 18446744073709551615n }));
    expect(row.destinationTag).toBe(18446744073709551615n);
  });

  it('partner_confirmed without partner_ref is refused', async () => {
    expect(await codeOf(record(verification({ partnerRef: null })))).toBe('23514');
  });

  it('wallet_session without embed_session_id is refused', async () => {
    const attempt = record(verification({ level: 'wallet_session', partnerRef: null }));
    expect(await codeOf(attempt)).toBe('23514');
    const onOtherLevel = record(verification({ embedSessionId: await newSession() }));
    expect(await codeOf(onOtherLevel)).toBe('23514');
  });

  it('a second wallet_session for a method is refused', async () => {
    const methodId = await newMethod();
    const session = (embedSessionId: string) =>
      record(verification({ methodId, level: 'wallet_session', partnerRef: null, embedSessionId }));
    await session(await newSession());
    expect(await codeOf(session(await newSession()))).toBe('23505');
    // Another method of the same recipient has its own.
    const other = await newMethod();
    const row = await record(
      verification({
        methodId: other,
        level: 'wallet_session',
        partnerRef: null,
        embedSessionId: await newSession(),
      }),
    );
    expect(row.level).toBe('wallet_session');
  });

  it('a scheme other than sep53 is refused, and a signature over 2,048 bytes is refused', async () => {
    const otherScheme = record({ ...sep53(null), scheme: 'eip191' });
    expect(await codeOf(otherScheme)).toBe('23514');
    expect(await codeOf(record(sep53(null, 'x'.repeat(2_049))))).toBe('23514');
    // Multibyte text counts in bytes.
    expect(await codeOf(record(sep53(null, 'é'.repeat(1_025))))).toBe('23514');
    const atTheLimit = await record(sep53(null, 'x'.repeat(2_048)));
    expect(atTheLimit.signature).toHaveLength(2_048);
  });

  it('sep53 without signer_key, and signer_key on another scheme, are refused', async () => {
    expect(await codeOf(record({ ...sep53(null), signerKey: null }))).toBe('23514');
    const keyWithNoScheme = record(verification({ signerKey: SIGNER }));
    expect(await codeOf(keyWithNoScheme)).toBe('23514');
    expect(await codeOf(record({ ...sep53(null), signerKey: 'not-a-key' }))).toBe('23514');
  });

  it('a challenge backs one row', async () => {
    const challengeId = await newChallenge();
    await record(sep53(challengeId));
    expect(await codeOf(record(sep53(challengeId)))).toBe('23505');
  });

  it('only a forwarder names the wallet it was built on', async () => {
    const wallet = await record(sep53(null));
    const forwarder = await record(
      verification({ level: 'forwarder_derived', partnerRef: null, derivedFrom: wallet.id }),
    );
    expect(forwarder.derivedFrom).toBe(wallet.id);
    expect(await codeOf(record(verification({ derivedFrom: wallet.id })))).toBe('23514');
  });

  it('is append only', async () => {
    const row = await record(verification());
    const change = db.tenant(world.tenant).transaction(async (tx) => {
      await sql`update ujira.destination_verifications set partner_ref = 'x' where id = ${row.id}`.execute(
        tx,
      );
    });
    expect(await codeOf(change)).toBe('42501');
    const remove = db.tenant(world.tenant).transaction(async (tx) => {
      await sql`delete from ujira.destination_verifications where id = ${row.id}`.execute(tx);
    });
    expect(await codeOf(remove)).toBe('42501');
  });
});

describe('embed sessions', () => {
  it('keep only a hash of the token, and read back what they allow', async () => {
    const id = await newSession();
    const session = await db
      .tenant(world.tenant)
      .transaction(async (tx) => embedSessions.get(tx, id));
    expect(session).toMatchObject({
      recipientId: world.recipientId,
      purpose: 'onboarding',
      allowedOrigins: ['https://app.example'],
      consumedAt: null,
    });
    expect(session).not.toHaveProperty('token');
    expect(session).not.toHaveProperty('tokenHash');
  });

  it('refuse a token hash used twice, no origins, and a bad prefix', async () => {
    const tokenHash = randomBytes(32);
    const create = (overrides: object) =>
      db.tenant(world.tenant).transaction(async (tx) =>
        embedSessions.create(tx, {
          tokenHash: randomBytes(32),
          tokenPrefix: `ujes_test_${randomUUID().slice(0, 8)}`,
          recipientId: world.recipientId,
          purpose: 'identity',
          allowedOrigins: ['https://app.example'],
          createdByToken: null,
          expiresAt: new Date('2027-01-15T09:00:00Z'),
          ...overrides,
        }),
      );
    await create({ tokenHash });
    expect(await codeOf(create({ tokenHash }))).toBe('23505');
    expect(await codeOf(create({ allowedOrigins: [] }))).toBe('23514');
    expect(await codeOf(create({ tokenPrefix: `ujes_prod_${randomUUID().slice(0, 8)}` }))).toBe(
      '23514',
    );
  });
});
