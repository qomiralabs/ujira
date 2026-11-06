// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What erasing a recipient does to their identity rows. The rows stay, because
// they are part of the financial record, but nothing is left that could tie them
// back to a person at the provider.

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import { embedSessions } from './repositories/identity-evidence.js';
import { recipientIdentities, recipients } from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let tenant: CreatedPrincipal;

async function verifiedRecipient(nullifier: Buffer) {
  return db.tenant(tenant).transaction(async (tx) => {
    const recipient = await recipients.create(tx, {
      recipientRef: randomBytes(32),
      country: 'NG',
    });
    const self = await recipientIdentities.open(tx, {
      recipientId: recipient.id,
      provider: 'self',
      providerAccount: null,
    });
    await recipientIdentities.update(tx, self.id, {
      state: 'verified',
      providerRef: `ver_${randomUUID()}`,
      providerSubject: 'subject-1',
      providerStatus: 'valid',
      assurance: 'document_zk',
      flowRef: 'flow_prekyc@1',
      nullifierHmac: nullifier,
      pendingSessionId: 'sess_1',
      pendingSessionUrl: 'https://self.test/session/sess_1',
      pendingSessionExpiresAt: new Date('2028-01-15T08:00:00Z'),
    });
    const anchor = await recipientIdentities.open(tx, {
      recipientId: recipient.id,
      provider: 'sep12',
      providerAccount: 'anchor-one',
    });
    return { recipientId: recipient.id, selfId: self.id, anchorId: anchor.id };
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
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('erasing a recipient', () => {
  it('identity row is revoked with references nulled', async () => {
    const { recipientId, selfId, anchorId } = await verifiedRecipient(randomBytes(32));
    const erased = await db
      .tenant(tenant)
      .transaction(async (tx) => recipientIdentities.erase(tx, recipientId));
    expect(erased).toBe(2);

    const row = await db
      .tenant(tenant)
      .transaction(async (tx) => recipientIdentities.get(tx, selfId));
    expect(row).toMatchObject({
      state: 'revoked',
      providerRef: null,
      providerSubject: null,
      nullifierHmac: null,
      pendingSessionId: null,
      pendingSessionUrl: null,
      pendingSessionExpiresAt: null,
    });
    // What it was remains, for the record, with no way back to the person.
    expect(row).toMatchObject({
      provider: 'self',
      assurance: 'document_zk',
      flowRef: 'flow_prekyc@1',
    });
    const anchor = await db
      .tenant(tenant)
      .transaction(async (tx) => recipientIdentities.get(tx, anchorId));
    expect(anchor?.state).toBe('revoked');
  });

  it('frees the nullifier: the row no longer verifies anyone', async () => {
    const nullifier = randomBytes(32);
    const first = await verifiedRecipient(nullifier);
    await db
      .tenant(tenant)
      .transaction(async (tx) => recipientIdentities.erase(tx, first.recipientId));
    const second = await verifiedRecipient(nullifier);
    const row = await db
      .tenant(tenant)
      .transaction(async (tx) => recipientIdentities.get(tx, second.selfId));
    expect(row?.state).toBe('verified');
  });

  it("leaves another recipient's rows alone", async () => {
    const erased = await verifiedRecipient(randomBytes(32));
    const kept = await verifiedRecipient(randomBytes(32));
    await db
      .tenant(tenant)
      .transaction(async (tx) => recipientIdentities.erase(tx, erased.recipientId));
    const row = await db
      .tenant(tenant)
      .transaction(async (tx) => recipientIdentities.get(tx, kept.selfId));
    expect(row).toMatchObject({ state: 'verified', providerSubject: 'subject-1' });
    expect(row?.providerRef).not.toBeNull();
  });

  it('open embed sessions are consumed', async () => {
    const newSession = (recipientId: string, expiresAt: Date) =>
      db.tenant(tenant).transaction(async (tx) =>
        embedSessions.create(tx, {
          tokenHash: randomBytes(32),
          tokenPrefix: `ujes_test_${randomUUID().slice(0, 8)}`,
          recipientId,
          purpose: 'onboarding',
          allowedOrigins: ['https://app.example'],
          createdByToken: null,
          expiresAt,
        }),
      );
    const later = new Date(Date.now() + 3_600_000);
    const { recipientId } = await verifiedRecipient(randomBytes(32));
    const other = await verifiedRecipient(randomBytes(32));
    const open = await newSession(recipientId, later);
    const lapsed = await newSession(recipientId, new Date(Date.now() - 1000));
    const used = await newSession(recipientId, later);
    const others = await newSession(other.recipientId, later);
    const read = (id: string) =>
      db.tenant(tenant).transaction(async (tx) => embedSessions.get(tx, id));
    await db.tenant(tenant).transaction(async (tx) => embedSessions.consume(tx, used.id));
    const usedAt = (await read(used.id))?.consumedAt;

    const closed = await db
      .tenant(tenant)
      .transaction(async (tx) => embedSessions.consumeOpen(tx, recipientId));

    expect(closed).toBe(2);
    expect((await read(open.id))?.consumedAt).toBeInstanceOf(Date);
    expect((await read(lapsed.id))?.consumedAt).toBeInstanceOf(Date);
    expect((await read(used.id))?.consumedAt).toEqual(usedAt);
    expect((await read(others.id))?.consumedAt).toBeNull();
  });

  it('a recipient with no identities erases nothing', async () => {
    const recipient = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        recipients.create(tx, { recipientRef: randomBytes(32), country: 'NG' }),
      );
    expect(
      await db
        .tenant(tenant)
        .transaction(async (tx) => recipientIdentities.erase(tx, recipient.id)),
    ).toBe(0);
  });
});
