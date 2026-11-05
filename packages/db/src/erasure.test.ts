// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What erasing a recipient does. Their personal data becomes unreadable, while the
// rows that are part of the financial record stay. An identity row stays too, with
// nothing left that could tie it back to a person at the provider.

import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { EnvelopeOpenError, newDataKey, open, seal } from './envelope.js';
import { LocalKeyManager } from './key-manager/local.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import {
  erasure,
  SubjectErasedError,
  SubjectKeyMissingError,
  subjectKeys,
} from './repositories/erasure.js';
import { payoutAttempts, payouts } from './repositories/payouts.js';
import { receipts } from './repositories/receipts.js';
import {
  payoutMethods,
  recipientIdentities,
  recipientPii,
  recipients,
} from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newAttempt,
  newPayout,
  ONE_USDC,
  payoutFixture,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let tenant: CreatedPrincipal;
let admin: pg.Client;

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
  db = databaseAsServiceRoles(roleUrls, database, 4);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
});

afterAll(async () => {
  await admin.end();
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

const keyManager = new LocalKeyManager({
  keks: `test-kek:${'ab'.repeat(32)}`,
  nodeEnv: 'test',
});
const NAME = Buffer.from('Ada Example, ada@example.com', 'utf8');

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('subject keys and erasure', () => {
  let fixture: PayoutFixture;

  async function storePii() {
    return db.tenant(fixture.tenant).transaction(async (tx) => {
      const value = await subjectKeys.encrypt(tx, keyManager, fixture.recipientId, NAME);
      await recipientPii.put(tx, fixture.recipientId, value);
      return value;
    });
  }

  async function erase(): Promise<boolean> {
    return db
      .tenant(fixture.tenant)
      .transaction(async (tx) => erasure.erase(tx, fixture.recipientId));
  }

  async function decrypt(
    value: { ciphertext: Buffer; nonce: Buffer },
    subject = fixture.recipientId,
  ) {
    return db
      .tenant(fixture.tenant)
      .transaction(async (tx) => subjectKeys.decrypt(tx, keyManager, subject, value));
  }

  beforeEach(async () => {
    fixture = await payoutFixture(db);
  });

  describe('envelope encryption', () => {
    it('reads back what it wrote, and the database holds only ciphertext', async () => {
      const value = await storePii();
      expect(await decrypt(value)).toEqual(NAME);
      expect(value.ciphertext.includes(NAME)).toBe(false);
      const row = await admin.query<{ wrapped_key: Buffer; kek_id: string }>(
        'select wrapped_key, kek_id from ujira.data_keys where subject_id = $1',
        [fixture.recipientId],
      );
      expect(row.rows[0]?.kek_id).toBe('test-kek');
      expect(row.rows[0]?.wrapped_key.length).toBeGreaterThan(32);
    });

    it('gives one subject one key, however many first uses race', async () => {
      const values = await Promise.all(
        Array.from({ length: 8 }, async () =>
          db
            .tenant(fixture.tenant)
            .transaction(async (tx) =>
              subjectKeys.encrypt(tx, keyManager, fixture.recipientId, NAME),
            ),
        ),
      );
      for (const value of values) expect(await decrypt(value)).toEqual(NAME);
      const keys = await admin.query('select 1 from ujira.data_keys where subject_id = $1', [
        fixture.recipientId,
      ]);
      expect(keys.rows).toHaveLength(1);
    });

    it('will not open ciphertext copied onto another recipient', async () => {
      const value = await storePii();
      const other = await db.tenant(fixture.tenant).transaction(async (tx) => {
        const recipient = await recipients.create(tx, {
          recipientRef: randomBytes(32),
          country: 'KE',
        });
        await subjectKeys.encrypt(tx, keyManager, recipient.id, NAME);
        return recipient.id;
      });
      await expect(decrypt(value, other)).rejects.toBeInstanceOf(EnvelopeOpenError);
    });

    it('will not open under the same key for another subject, or when damaged', () => {
      const key = newDataKey();
      const binding = { principalId: 'p', projectId: 'q', subjectId: 's' };
      const sealed = seal(key, NAME, binding);
      expect(open(key, sealed, binding)).toEqual(NAME);
      expect(() => open(key, sealed, { ...binding, subjectId: 't' })).toThrow(EnvelopeOpenError);
      const damaged = Buffer.from(sealed.ciphertext);
      damaged.writeUInt8(damaged.readUInt8(0) ^ 1, 0);
      expect(() => open(key, { ...sealed, ciphertext: damaged }, binding)).toThrow(
        EnvelopeOpenError,
      );
      expect(() => open(key, { ...sealed, ciphertext: Buffer.alloc(3) }, binding)).toThrow(
        EnvelopeOpenError,
      );
    });

    it('says so when a subject has no key', async () => {
      await expect(
        decrypt({ ciphertext: Buffer.alloc(32), nonce: Buffer.alloc(12) }),
      ).rejects.toBeInstanceOf(SubjectKeyMissingError);
    });
  });

  describe('erasure', () => {
    it('after erasure the ciphertext cannot be read', async () => {
      const value = await storePii();
      expect(await erase()).toBe(true);
      // The copy here stands for one in a log or a backup: without the key it is noise.
      await expect(decrypt(value)).rejects.toBeInstanceOf(SubjectErasedError);
      const key = await admin.query<{ wrapped_key: Buffer | null; kek_id: string | null }>(
        'select wrapped_key, kek_id from ujira.data_keys where subject_id = $1',
        [fixture.recipientId],
      );
      expect(key.rows).toEqual([{ wrapped_key: null, kek_id: null }]);
      const stored = await db
        .tenant(fixture.tenant)
        .transaction(async (tx) => recipientPii.get(tx, fixture.recipientId));
      expect(stored).toBeUndefined();
    });

    it('nulls the method ciphertext, revokes identities and sets the recipient erased', async () => {
      const session = db.tenant(fixture.tenant);
      const identityId = await session.transaction(async (tx) => {
        const details = await subjectKeys.encrypt(tx, keyManager, fixture.recipientId, NAME);
        await payoutMethods.create(tx, {
          recipientId: fixture.recipientId,
          method: 'bank',
          rail: 'anchor',
          chain: 'stellar',
          destinationAddress: `G${randomUUID()}`,
          destinationTag: null,
          details,
        });
        const identity = await recipientIdentities.open(tx, {
          recipientId: fixture.recipientId,
          provider: 'self',
          providerAccount: null,
        });
        await recipientIdentities.update(tx, identity.id, {
          state: 'verified',
          providerRef: `ver_${randomUUID()}`,
          providerSubject: 'subject-1',
          nullifierHmac: randomBytes(32),
        });
        return identity.id;
      });
      await erase();
      const methods = await admin.query<{ details_ciphertext: Buffer | null }>(
        'select details_ciphertext from ujira.payout_methods where recipient_id = $1',
        [fixture.recipientId],
      );
      expect(methods.rows.length).toBeGreaterThan(0);
      for (const row of methods.rows) expect(row.details_ciphertext).toBeNull();
      const recipient = await session.transaction(async (tx) =>
        recipients.get(tx, fixture.recipientId),
      );
      expect(recipient?.status).toBe('erased');
      const identity = await session.transaction(async (tx) =>
        recipientIdentities.get(tx, identityId),
      );
      expect(identity).toMatchObject({
        state: 'revoked',
        providerRef: null,
        providerSubject: null,
        nullifierHmac: null,
      });
    });

    it('payouts and receipts keep recipient_id and recipient_ref', async () => {
      const session = db.tenant(fixture.tenant);
      await storePii();
      const before = await session.transaction(async (tx) =>
        recipients.get(tx, fixture.recipientId),
      );
      const made = await session.transaction(async (tx) => {
        const { payout } = await payouts.create(tx, newPayout(fixture));
        const attempt = await payoutAttempts.create(tx, newAttempt(fixture, payout.id));
        const { receipt } = await receipts.record(tx, {
          payoutId: payout.id,
          attemptId: attempt.id,
          revision: 1,
          chainReceiptRef: 'ref',
          settlement: usdc(5n * ONE_USDC),
          fee: 0n,
          legs: [
            {
              legIndex: 0,
              destinationAddress: fixture.destinationAddress,
              amount: 5n * ONE_USDC,
              chainTxHash: 'tx',
            },
          ],
        });
        return { payoutId: payout.id, receiptId: receipt.id };
      });

      await erase();

      const payout = await session.transaction(async (tx) => payouts.get(tx, made.payoutId));
      expect(payout?.recipientId).toBe(fixture.recipientId);
      const latest = await session.transaction(async (tx) => receipts.latest(tx, made.payoutId));
      expect(latest?.id).toBe(made.receiptId);
      const after = await session.transaction(async (tx) =>
        recipients.get(tx, fixture.recipientId),
      );
      expect(after?.recipientRef).toEqual(before?.recipientRef);
    });

    it('logs requested and completed, with ids only', async () => {
      await erase();
      const log = await db
        .tenant(fixture.tenant)
        .transaction(async (tx) => erasure.log(tx, fixture.recipientId));
      expect(log.map((entry) => entry.event).sort()).toEqual(['completed', 'requested']);
      expect(new Set(log.map((entry) => entry.erasureId)).size).toBe(1);
      const columns = await admin.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'ujira' and table_name = 'erasure_log' order by 1`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'erasure_id',
        'event',
        'id',
        'occurred_at',
        'principal_id',
        'project_id',
        'subject_id',
      ]);
    });

    it('is all or nothing: a failure part way leaves the data and the key', async () => {
      const value = await storePii();
      await expect(
        db.tenant(fixture.tenant).transaction(async (tx) => {
          await erasure.erase(tx, fixture.recipientId);
          throw new Error('the work failed');
        }),
      ).rejects.toThrow('the work failed');
      expect(await decrypt(value)).toEqual(NAME);
      const log = await db
        .tenant(fixture.tenant)
        .transaction(async (tx) => erasure.log(tx, fixture.recipientId));
      expect(log).toEqual([]);
    });

    it('erasing twice does the work once, and parallel erasures log one', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, async () => erase()));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await erase()).toBe(false);
      const log = await db
        .tenant(fixture.tenant)
        .transaction(async (tx) => erasure.log(tx, fixture.recipientId));
      expect(log).toHaveLength(2);
    });

    it('erases a subject that never had a key, and it can never get one', async () => {
      expect(await erase()).toBe(true);
      await expect(
        db
          .tenant(fixture.tenant)
          .transaction(async (tx) =>
            subjectKeys.encrypt(tx, keyManager, fixture.recipientId, NAME),
          ),
      ).rejects.toBeInstanceOf(SubjectErasedError);
    });

    it('nothing brings personal data back once erased, whoever writes it', async () => {
      await storePii();
      await erase();
      const session = db.tenant(fixture.tenant);
      const put = session.transaction(async (tx) =>
        recipientPii.put(tx, fixture.recipientId, {
          ciphertext: Buffer.alloc(32),
          nonce: Buffer.alloc(12),
        }),
      );
      expect(await codeOf(put)).toBe('UJ018');
      const method = session.transaction(async (tx) =>
        payoutMethods.create(tx, {
          recipientId: fixture.recipientId,
          method: 'bank',
          rail: 'anchor',
          chain: 'stellar',
          destinationAddress: `G${randomUUID()}`,
          destinationTag: null,
          details: { ciphertext: Buffer.alloc(32), nonce: Buffer.alloc(12) },
        }),
      );
      expect(await codeOf(method)).toBe('UJ018');
      const revive = session.transaction(async (tx) =>
        recipients.setStatus(tx, fixture.recipientId, 'active'),
      );
      expect(await codeOf(revive)).toBe('UJ018');
      expect(
        await codeOf(
          admin.query(
            `update ujira.data_keys set wrapped_key = '\\x00', kek_id = 'k', shredded_at = null
              where subject_id = $1`,
            [fixture.recipientId],
          ),
        ),
      ).toBe('UJ018');
    });

    it('refuses half a key, and removing the tombstone or the log even as the owner', async () => {
      await erase();
      expect(
        await codeOf(
          admin.query(`update ujira.data_keys set kek_id = 'k' where subject_id = $1`, [
            fixture.recipientId,
          ]),
        ),
      ).toBe('23514');
      for (const statement of [
        `delete from ujira.data_keys where subject_id = '${fixture.recipientId}'`,
        'truncate ujira.data_keys',
        `delete from ujira.erasure_log where subject_id = '${fixture.recipientId}'`,
        `update ujira.erasure_log set event = 'requested' where subject_id = '${fixture.recipientId}'`,
        'truncate ujira.erasure_log',
      ]) {
        await admin.query('begin');
        await admin.query('set local role ujira_owner');
        expect(await codeOf(admin.query(statement)), statement).toBe('UJ002');
        await admin.query('rollback');
      }
    });

    it('finds nothing to erase for an unknown subject', async () => {
      expect(
        await db.tenant(fixture.tenant).transaction(async (tx) => erasure.erase(tx, randomUUID())),
      ).toBe(false);
    });
  });
});
