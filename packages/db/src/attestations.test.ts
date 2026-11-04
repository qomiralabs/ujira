// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomBytes, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  agentIdentityLinks,
  attestations,
  type NewAttestation,
} from './repositories/identity-evidence.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { codeOf, evidenceWorld, type EvidenceWorld } from './testing/evidence-world.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const U256_MAX = 2n ** 256n - 1n;

let database: TestDatabase;
let db: Database;
let world: EvidenceWorld;

function attestation(overrides: Partial<NewAttestation> = {}): NewAttestation {
  return {
    mandateInstanceId: world.instanceId,
    attemptId: randomUUID(),
    legIndex: 0,
    recipientId: world.recipientId,
    methodId: world.methodId,
    destinationAddress: world.address,
    destinationTag: null,
    countryPolicyHash: randomBytes(32),
    policyEpoch: 3n,
    validUntil: new Date('2027-01-16T08:00:00Z'),
    attesterKeyId: '0xattester',
    digest: randomBytes(32),
    ...overrides,
  };
}

const insert = (input: NewAttestation) =>
  db.tenant(world.tenant).transaction(async (tx) => attestations.insertPending(tx, input));

// A raw update past the repository, whose own where clause would hide the
// trigger's refusal.
function rawUpdate(id: string, assignment: string) {
  return db.tenant(world.tenant).transaction(async (tx) => {
    await sql`update ujira.attestations set ${sql.raw(assignment)} where id = ${id}`.execute(tx);
  });
}

async function asSigner<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: roleUrl(roleUrls, 'ujira_signer_attester', database.name),
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
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

describe('attestations', () => {
  it('start pending and read back whole', async () => {
    const input = attestation({ destinationTag: 7n, legIndex: 255 });
    const row = await insert(input);
    expect(row).toMatchObject({
      mandateInstanceId: world.instanceId,
      attemptId: input.attemptId,
      legIndex: 255,
      destinationTag: 7n,
      policyEpoch: 3n,
      validUntil: input.validUntil,
      status: 'pending',
      signature: null,
      failureCode: null,
    });
    const reread = await db
      .tenant(world.tenant)
      .transaction(async (tx) => attestations.get(tx, row.id));
    expect(reread?.digest.equals(input.digest)).toBe(true);
  });

  it('the same digest and key are logged once', async () => {
    const digest = randomBytes(32);
    await insert(attestation({ digest }));
    expect(await codeOf(insert(attestation({ digest })))).toBe('23505');
    // Another key signs its own.
    const other = await insert(attestation({ digest, attesterKeyId: '0xrotated' }));
    expect(other.status).toBe('pending');
  });

  it('moves from pending to signed or failed, once', async () => {
    const signature = randomBytes(64);
    const signed = await insert(attestation());
    const mark = () =>
      db
        .tenant(world.tenant)
        .transaction(async (tx) => attestations.markSigned(tx, signed.id, signature));
    expect(await mark()).toBe(true);
    expect(await mark()).toBe(false);
    const row = await db
      .tenant(world.tenant)
      .transaction(async (tx) => attestations.get(tx, signed.id));
    expect(row?.status).toBe('signed');
    expect(row?.signature?.equals(signature)).toBe(true);

    const failed = await insert(attestation());
    const marked = await db
      .tenant(world.tenant)
      .transaction(async (tx) => attestations.markFailed(tx, failed.id, 'SIGNER_DENIED'));
    expect(marked).toBe(true);
    const failedRow = await db
      .tenant(world.tenant)
      .transaction(async (tx) => attestations.get(tx, failed.id));
    expect(failedRow).toMatchObject({ status: 'failed', failureCode: 'SIGNER_DENIED' });
  });

  it('signed to failed is refused', async () => {
    const row = await insert(attestation());
    await db
      .tenant(world.tenant)
      .transaction(async (tx) => attestations.markSigned(tx, row.id, randomBytes(64)));
    const attempt = rawUpdate(row.id, "status = 'failed', signature = null, failure_code = 'X'");
    expect(await codeOf(attempt)).toBe('UJ020');
    const back = rawUpdate(row.id, "status = 'pending', signature = null");
    expect(await codeOf(back)).toBe('UJ020');
  });

  it('other columns cannot change', async () => {
    const row = await insert(attestation());
    for (const assignment of [
      "destination_address = 'GELSEWHERE'",
      'leg_index = 1',
      "valid_until = '2030-01-01'",
      `attempt_id = '${randomUUID()}'`,
    ]) {
      expect(await codeOf(rawUpdate(row.id, assignment)), assignment).toBe('UJ020');
      const moved = `status = 'failed', failure_code = 'X', ${assignment}`;
      expect(await codeOf(rawUpdate(row.id, moved)), moved).toBe('UJ020');
    }
  });

  it('a signed row needs its signature, and a failed row its code', async () => {
    const row = await insert(attestation());
    expect(await codeOf(rawUpdate(row.id, "status = 'signed'"))).toBe('23514');
    expect(await codeOf(rawUpdate(row.id, "status = 'failed'"))).toBe('23514');
    const short = db
      .tenant(world.tenant)
      .transaction(async (tx) => attestations.markSigned(tx, row.id, randomBytes(63)));
    expect(await codeOf(short)).toBe('23514');
    const prose = db
      .tenant(world.tenant)
      .transaction(async (tx) => attestations.markFailed(tx, row.id, 'it broke for jane'));
    expect(await codeOf(prose)).toBe('23514');
  });

  it('cannot be deleted, and refuses a leg outside a byte', async () => {
    const row = await insert(attestation());
    const remove = db.tenant(world.tenant).transaction(async (tx) => {
      await sql`delete from ujira.attestations where id = ${row.id}`.execute(tx);
    });
    expect(await codeOf(remove)).toBe('42501');
    expect(await codeOf(insert(attestation({ legIndex: 256 })))).toBe('23514');
  });

  it('cannot name a row of another tenant', async () => {
    const other = await evidenceWorld(db);
    for (const overrides of [
      { mandateInstanceId: other.instanceId },
      { recipientId: other.recipientId },
      { methodId: other.methodId },
    ]) {
      expect(await codeOf(insert(attestation(overrides)))).toBe('23503');
    }
  });
});

describe('the attester signer', () => {
  const CALL = 'select * from ujira.attestation_pending($1::bytea)';

  it('pending digest returns its row', async () => {
    const row = await insert(attestation());
    const result = await asSigner((client) => client.query(CALL, [row.digest]));
    expect(result.rows).toEqual([
      {
        principal_id: world.tenant.principalId,
        project_id: world.tenant.projectId,
        attestation_id: row.id,
      },
    ]);
  });

  it('a signed, failed or unknown digest returns nothing', async () => {
    const signed = await insert(attestation());
    const failed = await insert(attestation());
    await db.tenant(world.tenant).transaction(async (tx) => {
      await attestations.markSigned(tx, signed.id, randomBytes(64));
      await attestations.markFailed(tx, failed.id, 'SIGNER_DENIED');
    });
    for (const digest of [signed.digest, failed.digest, randomBytes(32)]) {
      const result = await asSigner((client) => client.query(CALL, [digest]));
      expect(result.rows).toEqual([]);
    }
  });

  it('still reads nothing else', async () => {
    const denied = asSigner((client) => client.query('select * from ujira.attestations'));
    expect(await codeOf(denied)).toBe('42501');
  });
});

describe('agent identity links', () => {
  const link = (overrides: object = {}) => ({
    network: 'stellar:testnet',
    address: `G${randomUUID()}`,
    registry: 'registry-1',
    tokenId: 1n,
    displayName: 'Helper agent',
    humanBackedUntil: null,
    ...overrides,
  });
  const create = (input: ReturnType<typeof link>) =>
    db.tenant(world.tenant).transaction(async (tx) => agentIdentityLinks.create(tx, input));

  it('keep a token id up to 2^256 - 1 exactly, and refuse past it', async () => {
    const row = await create(link({ tokenId: U256_MAX }));
    expect(row).toMatchObject({ tokenId: U256_MAX, status: 'pending', lastCheckedAt: null });
    expect(await codeOf(create(link({ tokenId: U256_MAX + 1n })))).toBe('23514');
    expect(await codeOf(create(link({ tokenId: -1n })))).toBe('23514');
  });

  it('one link per wallet and registry, and a status from the list', async () => {
    const address = `G${randomUUID()}`;
    const row = await create(link({ address }));
    expect(await codeOf(create(link({ address })))).toBe('23505');
    const set = (status: string) =>
      db
        .tenant(world.tenant)
        .transaction(async (tx) => agentIdentityLinks.setStatus(tx, row.id, status as 'active'));
    expect(await set('active')).toBe(true);
    expect(await codeOf(set('maybe'))).toBe('23514');
    const reread = await db
      .tenant(world.tenant)
      .transaction(async (tx) => agentIdentityLinks.get(tx, row.id));
    expect(reread?.status).toBe('active');
    expect(reread?.lastCheckedAt).toBeInstanceOf(Date);
  });
});
