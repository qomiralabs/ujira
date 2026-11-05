// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomBytes, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import { mandateInstances, mandates } from './repositories/mandates.js';
import { recipientIdentities, recipients } from './repositories/recipients.js';
import { projects } from './repositories/tenancy.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let tenant: CreatedPrincipal;
let secondProject: CreatedPrincipal;
let otherPrincipal: CreatedPrincipal;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function newRecipient(who: CreatedPrincipal = tenant): Promise<string> {
  const recipient = await db
    .tenant(who)
    .transaction(async (tx) =>
      recipients.create(tx, { recipientRef: randomBytes(32), country: 'NG' }),
    );
  return recipient.id;
}

async function openSelf(who: CreatedPrincipal = tenant): Promise<string> {
  const recipientId = await newRecipient(who);
  const identity = await db.tenant(who).transaction(async (tx) =>
    recipientIdentities.open(tx, {
      recipientId,
      provider: 'self',
      providerAccount: null,
    }),
  );
  return identity.id;
}

function verify(id: string, nullifierHmac: Buffer, who: CreatedPrincipal = tenant) {
  return db
    .tenant(who)
    .transaction(async (tx) =>
      recipientIdentities.update(tx, id, { state: 'verified', nullifierHmac }),
    );
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  const create = (name: string) =>
    db.unscoped(async (tx) =>
      entryPoints.createPrincipal(tx, { name, projectName: 'Main', ownerUserId: randomUUID() }),
    );
  tenant = await create('Acme');
  otherPrincipal = await create('Other');
  const projectId = await db
    .tenant(tenant)
    .transaction(async (tx) => projects.create(tx, { name: 'Second' }));
  secondProject = { principalId: tenant.principalId, projectId };
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('opening a provider identity', () => {
  it('starts pending, with no chain, no reference and no assurance', async () => {
    const recipientId = await newRecipient();
    const identity = await db.tenant(tenant).transaction(async (tx) =>
      recipientIdentities.open(tx, {
        recipientId,
        provider: 'sep12',
        providerAccount: 'anchor-one',
      }),
    );
    expect(identity).toMatchObject({
      recipientId,
      provider: 'sep12',
      providerAccount: 'anchor-one',
      chain: null,
      providerRef: null,
      state: 'pending',
      assurance: 'none',
      nullifierHmac: null,
      expiresAt: null,
    });
  });

  it('keeps one row per provider and account for a recipient, with no account counting as one', async () => {
    const recipientId = await newRecipient();
    const open = (provider: string, providerAccount: string | null) =>
      db
        .tenant(tenant)
        .transaction(async (tx) =>
          recipientIdentities.open(tx, { recipientId, provider, providerAccount }),
        );
    await open('self', null);
    expect(await codeOf(open('self', null))).toBe('23505');
    await open('sep12', 'anchor-one');
    await open('sep12', 'anchor-two');
    expect(await codeOf(open('sep12', 'anchor-one'))).toBe('23505');
    await open('principal', null);
  });
});

describe('a provider result', () => {
  it('changes only what it names, and null clears a field', async () => {
    const id = await openSelf();
    const expiresAt = new Date('2028-01-15T08:00:00Z');
    const rawSha256 = randomBytes(32);
    const session = await db.tenant(tenant).transaction(async (tx) =>
      recipientIdentities.update(tx, id, {
        pendingSessionId: 'sess_1',
        pendingSessionUrl: 'https://self.test/session/sess_1',
        pendingSessionExpiresAt: expiresAt,
      }),
    );
    expect(session).toMatchObject({ pendingSessionId: 'sess_1', state: 'pending' });

    const result = await db.tenant(tenant).transaction(async (tx) =>
      recipientIdentities.update(tx, id, {
        state: 'verified',
        providerRef: `ver_${randomUUID()}`,
        providerSubject: 'subject-1',
        providerStatus: 'valid',
        assurance: 'document_zk',
        flowRef: 'flow_prekyc@1',
        rawSha256,
        lastCheckedAt: expiresAt,
        expiresAt,
        failureReason: null,
        pendingSessionId: null,
        pendingSessionUrl: null,
        pendingSessionExpiresAt: null,
      }),
    );
    expect(result).toMatchObject({
      state: 'verified',
      providerStatus: 'valid',
      assurance: 'document_zk',
      flowRef: 'flow_prekyc@1',
      pendingSessionId: null,
      pendingSessionUrl: null,
      failureReason: null,
      expiresAt,
      lastCheckedAt: expiresAt,
    });
    expect(result?.rawSha256?.equals(rawSha256)).toBe(true);

    const reread = await db
      .tenant(tenant)
      .transaction(async (tx) => recipientIdentities.get(tx, id));
    expect(reread?.providerSubject).toBe('subject-1');
    const kept = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        recipientIdentities.update(tx, id, { failureReason: 'session_expired' }),
      );
    expect(kept).toMatchObject({ state: 'verified', failureReason: 'session_expired' });
  });

  it('accepts revoked, and refuses a state or an assurance outside the list', async () => {
    const id = await openSelf();
    const set = (change: Parameters<typeof recipientIdentities.update>[2]) =>
      db.tenant(tenant).transaction(async (tx) => recipientIdentities.update(tx, id, change));
    expect(await set({ state: 'revoked' })).toMatchObject({ state: 'revoked' });
    expect(await codeOf(set({ state: 'unknown' as 'revoked' }))).toBe('23514');
    expect(await codeOf(set({ assurance: 'trust_me' as 'none' }))).toBe('23514');
  });

  it('a hash that is not 32 bytes is refused', async () => {
    const id = await openSelf();
    const short = db
      .tenant(tenant)
      .transaction(async (tx) =>
        recipientIdentities.update(tx, id, { nullifierHmac: randomBytes(16) }),
      );
    expect(await codeOf(short)).toBe('23514');
  });

  it("a provider's reference names one row, across tenants too", async () => {
    const providerRef = `ver_${randomUUID()}`;
    const first = await openSelf();
    const second = await openSelf(otherPrincipal);
    await db
      .tenant(tenant)
      .transaction(async (tx) => recipientIdentities.update(tx, first, { providerRef }));
    const attempt = db
      .tenant(otherPrincipal)
      .transaction(async (tx) => recipientIdentities.update(tx, second, { providerRef }));
    expect(await codeOf(attempt)).toBe('23505');
  });
});

describe('one verified person per principal', () => {
  it('a second verified row with the same nullifier is refused', async () => {
    const nullifier = randomBytes(32);
    const first = await openSelf();
    const second = await openSelf();
    await verify(first, nullifier);
    expect(await codeOf(verify(second, nullifier))).toBe('23505');
  });

  it('holds across the projects of a principal', async () => {
    const nullifier = randomBytes(32);
    await verify(await openSelf(), nullifier);
    const elsewhere = await openSelf(secondProject);
    expect(await codeOf(verify(elsewhere, nullifier, secondProject))).toBe('23505');
  });

  it('finds who holds a nullifier across the projects of a principal, and only when verified', async () => {
    const nullifier = randomBytes(32);
    const id = await openSelf(secondProject);
    const find = () =>
      db
        .principal(tenant, 'app')
        .transaction(async (tx) => recipientIdentities.verifiedByNullifier(tx, nullifier));
    expect(await find()).toBeUndefined();
    await db
      .tenant(secondProject)
      .transaction(async (tx) =>
        recipientIdentities.update(tx, id, { state: 'rejected', nullifierHmac: nullifier }),
      );
    expect(await find()).toBeUndefined();
    await verify(id, nullifier, secondProject);
    expect((await find())?.id).toBe(id);
  });

  it('the same person under another principal is not a duplicate', async () => {
    const nullifier = randomBytes(32);
    await verify(await openSelf(), nullifier);
    const other = await openSelf(otherPrincipal);
    expect(await verify(other, nullifier, otherPrincipal)).toMatchObject({ state: 'verified' });
  });

  it('a rejected duplicate may keep the value, and verifies nobody', async () => {
    const nullifier = randomBytes(32);
    await verify(await openSelf(), nullifier);
    const duplicate = await openSelf();
    const rejected = await db.tenant(tenant).transaction(async (tx) =>
      recipientIdentities.update(tx, duplicate, {
        state: 'rejected',
        failureReason: 'duplicate_person',
        nullifierHmac: nullifier,
      }),
    );
    expect(rejected).toMatchObject({ state: 'rejected', failureReason: 'duplicate_person' });
  });

  it('many rows with no nullifier can be verified', async () => {
    const first = await openSelf();
    const second = await openSelf();
    for (const id of [first, second]) {
      const row = await db
        .tenant(tenant)
        .transaction(async (tx) => recipientIdentities.update(tx, id, { state: 'verified' }));
      expect(row?.state).toBe('verified');
    }
  });
});

describe('the country policy', () => {
  it('a mandate keeps its policy, and one with none allows nobody', async () => {
    const withPolicy = await db.tenant(tenant).transaction(async (tx) =>
      mandates.create(tx, {
        name: 'Listed',
        countryPolicy: { mode: 'deny', countries: ['GH', 'NG'] },
      }),
    );
    expect(withPolicy.countryPolicy).toEqual({ mode: 'deny', countries: ['GH', 'NG'] });
    const none = await db
      .tenant(tenant)
      .transaction(async (tx) => mandates.create(tx, { name: 'Unlisted' }));
    expect(none.countryPolicy).toEqual({ mode: 'allow', countries: [] });
    const reread = await db
      .tenant(tenant)
      .transaction(async (tx) => mandates.get(tx, withPolicy.id));
    expect(reread?.countryPolicy.countries).toEqual(['GH', 'NG']);
  });

  it('refuses a code that is not two capitals, a null entry and an unknown mode', async () => {
    const create = (mode: string, countries: readonly (string | null)[]) =>
      db.tenant(tenant).transaction(async (tx) =>
        mandates.create(tx, {
          name: 'Bad',
          countryPolicy: { mode: mode as 'allow', countries: countries as string[] },
        }),
      );
    expect(await codeOf(create('allow', ['ng']))).toBe('23514');
    expect(await codeOf(create('allow', ['NGA']))).toBe('23514');
    expect(await codeOf(create('allow', ['NG', null]))).toBe('23514');
    expect(await codeOf(create('maybe', ['NG']))).toBe('23514');
  });

  it('an instance keeps the attester key and the policy hash, at their exact lengths', async () => {
    const mandate = await db
      .tenant(tenant)
      .transaction(async (tx) => mandates.create(tx, { name: 'Attested' }));
    const create = (attesterPublicKey: Buffer | null, countryPolicyHash: Buffer | null) =>
      db.tenant(tenant).transaction(async (tx) =>
        mandateInstances.create(tx, {
          mandateId: mandate.id,
          chain: 'stellar',
          contractAddress: `C${randomUUID()}`,
          specVersion: '1',
          asset: 'USDC',
          scale: 7,
          attesterPublicKey,
          countryPolicyHash,
        }),
      );
    // An ed25519 key is 32 bytes; the 65 of a secp256k1 key is refused.
    expect(await codeOf(create(randomBytes(65), null))).toBe('23514');
    expect(await codeOf(create(null, randomBytes(31)))).toBe('23514');
    const key = randomBytes(32);
    const hash = randomBytes(32);
    const instance = await create(key, hash);
    expect(instance.attesterPublicKey?.equals(key)).toBe(true);
    expect(instance.countryPolicyHash?.equals(hash)).toBe(true);
  });
});

describe('the older per chain upsert', () => {
  it('still records a provider on a chain, and reads back whole', async () => {
    const recipientId = await newRecipient();
    const input = {
      recipientId,
      chain: 'stellar',
      provider: 'anchor',
      providerRef: `ref-${randomUUID()}`,
      state: 'pending',
    } as const;
    await db.tenant(tenant).transaction(async (tx) => recipientIdentities.upsert(tx, input));
    const updated = await db
      .tenant(tenant)
      .transaction(async (tx) => recipientIdentities.upsert(tx, { ...input, state: 'verified' }));
    expect(updated).toMatchObject({ chain: 'stellar', state: 'verified', assurance: 'none' });
    const listed = await db
      .tenant(tenant)
      .transaction(async (tx) => recipientIdentities.list(tx, recipientId));
    expect(listed).toHaveLength(1);
  });

  it('a raw insert past the repository is still held to the row rules', async () => {
    const recipientId = await newRecipient();
    const insert = db.tenant(tenant).transaction(async (tx) => {
      await sql`
        insert into ujira.recipient_identities
          (principal_id, project_id, recipient_id, provider, state)
        values
          (${tenant.principalId}, ${tenant.projectId}, ${recipientId}, ${'x'.repeat(65)}, 'pending')
      `.execute(tx);
    });
    expect(await codeOf(insert)).toBe('23514');
  });
});
