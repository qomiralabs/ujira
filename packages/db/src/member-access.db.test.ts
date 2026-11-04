// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Invitations are bound to a hashed secret and tied to their status, a wallet
// links to one member at a time, and a member below admin reaches only the
// projects listed for them.

import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import { memberProjects, memberWallets } from './repositories/member-access.js';
import { memberSessions } from './repositories/sessions.js';
import { members } from './repositories/tenancy.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let tenant: ProjectContext;
let owner: string;

const INVITE_EXPIRY = new Date('2030-01-01T00:00:00Z');

const codeOf = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => 'resolved',
    (error: unknown) => (error as { code?: unknown }).code,
  );

async function newMember(role: 'admin' | 'developer' | 'viewer' = 'viewer'): Promise<string> {
  const userId = randomUUID();
  await db.tenant(tenant).transaction(async (tx) => members.add(tx, { userId, role }));
  return userId;
}

const insertMember = (status: string, values: readonly unknown[]) =>
  admin.query(
    `insert into ujira.principal_members
       (principal_id, user_id, role, status, invite_secret_hash, invite_expires_at, invited_by)
     values ($1, $2, 'viewer', $3, $4, $5, $6)`,
    [tenant.principalId, randomUUID(), status, ...values],
  );

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  owner = randomUUID();
  const created = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, { name: 'p', projectName: 'one', ownerUserId: owner }),
  );
  tenant = { principalId: created.principalId, projectId: created.projectId };
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('invitations', () => {
  it('invited without secret or expiry is refused', async () => {
    expect(await codeOf(insertMember('invited', [null, INVITE_EXPIRY, owner]))).toBe('23514');
    expect(await codeOf(insertMember('invited', [randomBytes(32), null, owner]))).toBe('23514');
    expect(await codeOf(insertMember('invited', [randomBytes(32), INVITE_EXPIRY, null]))).toBe(
      '23514',
    );
    expect(await codeOf(insertMember('invited', [null, null, null]))).toBe('23514');
  });

  it('an invite secret on a member who is not invited is refused', async () => {
    expect(await codeOf(insertMember('active', [randomBytes(32), INVITE_EXPIRY, owner]))).toBe(
      '23514',
    );
  });

  it('a whole invitation is accepted', async () => {
    expect(await codeOf(insertMember('invited', [randomBytes(32), INVITE_EXPIRY, owner]))).toBe(
      'resolved',
    );
  });

  it('the same secret hash on two invitations is refused', async () => {
    const hash = randomBytes(32);
    await insertMember('invited', [hash, INVITE_EXPIRY, owner]);
    expect(await codeOf(insertMember('invited', [hash, INVITE_EXPIRY, owner]))).toBe('23505');
  });

  it('a secret hash of the wrong length is refused', async () => {
    expect(await codeOf(insertMember('invited', [randomBytes(16), INVITE_EXPIRY, owner]))).toBe(
      '23514',
    );
  });

  it('accepting clears the secret, so an invitation works once', async () => {
    const userId = randomUUID();
    const secretHash = randomBytes(32);
    const accept = () =>
      db.tenant(tenant).transaction(async (tx) => members.acceptInvite(tx, secretHash));
    await db.tenant(tenant).transaction(async (tx) =>
      members.invite(tx, {
        userId,
        role: 'viewer',
        secretHash,
        expiresAt: INVITE_EXPIRY,
        invitedBy: owner,
      }),
    );
    expect(await accept()).toBe(userId);
    expect(await accept()).toBeUndefined();
    const { rows } = await admin.query<{ status: string; invite_secret_hash: Buffer | null }>(
      `select status, invite_secret_hash from ujira.principal_members where user_id = $1`,
      [userId],
    );
    expect(rows).toEqual([{ status: 'active', invite_secret_hash: null }]);
  });

  it('an expired invitation cannot be accepted', async () => {
    const userId = randomUUID();
    const secretHash = randomBytes(32);
    await db.tenant(tenant).transaction(async (tx) =>
      members.invite(tx, {
        userId,
        role: 'viewer',
        secretHash,
        expiresAt: new Date(Date.now() - 1000),
        invitedBy: owner,
      }),
    );
    expect(
      await db.tenant(tenant).transaction(async (tx) => members.acceptInvite(tx, secretHash)),
    ).toBeUndefined();
  });
});

describe('member wallets', () => {
  const link = (userId: string, address: string) =>
    db.tenant(tenant).transaction(async (tx) =>
      memberWallets.link(tx, {
        userId,
        network: 'stellar:testnet',
        address,
        verifiedAt: new Date('2027-01-01T00:00:00Z'),
      }),
    );

  it('a second live link of the same address is refused', async () => {
    const address = `G${randomUUID()}`;
    await link(await newMember(), address);
    expect(await codeOf(link(await newMember(), address))).toBe('23505');
  });

  it('an address can be linked again once the link has ended, and the old row stays', async () => {
    const address = `G${randomUUID()}`;
    const first = await newMember();
    const wallet = await link(first, address);
    expect(
      await db.tenant(tenant).transaction(async (tx) => memberWallets.remove(tx, wallet.id)),
    ).toBe(true);
    expect(
      await db.tenant(tenant).transaction(async (tx) => memberWallets.remove(tx, wallet.id)),
    ).toBe(false);
    await link(await newMember(), address);
    const kept = await db.tenant(tenant).transaction(async (tx) => memberWallets.list(tx, first));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.removedAt).toBeInstanceOf(Date);
  });

  it('refuses a wallet for someone who is not a member', async () => {
    expect(await codeOf(link(randomUUID(), `G${randomUUID()}`))).toBe('23503');
  });

  it('refuses a network that is not in the chain form', async () => {
    const userId = await newMember();
    expect(
      await codeOf(
        db.tenant(tenant).transaction(async (tx) =>
          memberWallets.link(tx, {
            userId,
            network: 'Stellar Testnet',
            address: 'G1',
            verifiedAt: new Date(),
          }),
        ),
      ),
    ).toBe('23514');
  });

  it("erasing a member removes all of their wallets and nobody else's", async () => {
    const erased = await newMember();
    const other = await newMember();
    await link(erased, `G${randomUUID()}`);
    await link(erased, `G${randomUUID()}`);
    await link(other, `G${randomUUID()}`);
    expect(
      await db.tenant(tenant).transaction(async (tx) => memberWallets.eraseMember(tx, erased)),
    ).toBe(2);
    expect(
      await db.tenant(tenant).transaction(async (tx) => memberWallets.list(tx, erased)),
    ).toEqual([]);
    expect(
      await db.tenant(tenant).transaction(async (tx) => memberWallets.list(tx, other)),
    ).toHaveLength(1);
  });
});

describe('project access', () => {
  async function sessionFor(userId: string): Promise<Buffer> {
    const secretHash = randomBytes(32);
    await db.unscoped(async (tx) =>
      memberSessions.create(tx, {
        secretHash,
        authSubject: userId,
        supabaseSessionId: `s-${randomUUID()}`,
        aal: 'aal1',
        idleSeconds: 600,
        absoluteSeconds: 3600,
        ipHmac: null,
        userAgentFamily: null,
      }),
    );
    return secretHash;
  }
  const select = (hash: Buffer) =>
    db.unscoped(async (tx) =>
      memberSessions.select(tx, hash, tenant.principalId, tenant.projectId),
    );
  const resolve = (hash: Buffer) => db.unscoped(async (tx) => memberSessions.resolve(tx, hash));
  const grant = (userId: string) =>
    db.tenant(tenant).transaction(async (tx) => memberProjects.grant(tx, userId, owner));
  const revoke = (userId: string) =>
    db.tenant(tenant).transaction(async (tx) => memberProjects.revoke(tx, userId));

  it('a member below admin cannot select a project not listed for them', async () => {
    const hash = await sessionFor(await newMember('developer'));
    expect(await select(hash)).toBe(false);
  });

  it('a member below admin can select a project listed for them', async () => {
    const userId = await newMember('viewer');
    await grant(userId);
    const hash = await sessionFor(userId);
    expect(await select(hash)).toBe(true);
    expect((await resolve(hash))?.projectId).toBe(tenant.projectId);
  });

  it('losing the listing ends the session on that project', async () => {
    const userId = await newMember('developer');
    await grant(userId);
    const hash = await sessionFor(userId);
    expect(await select(hash)).toBe(true);
    expect(await revoke(userId)).toBe(true);
    expect(await resolve(hash)).toBeUndefined();
    expect(await revoke(userId)).toBe(false);
  });

  it('an admin and an owner need no listing', async () => {
    for (const userId of [await newMember('admin'), owner]) {
      const hash = await sessionFor(userId);
      expect(await select(hash)).toBe(true);
      expect((await resolve(hash))?.projectId).toBe(tenant.projectId);
    }
  });

  it('granting twice changes nothing, and lists who granted it', async () => {
    const userId = await newMember();
    await grant(userId);
    await grant(userId);
    const page = await db
      .tenant(tenant)
      .transaction(async (tx) => memberProjects.list(tx, { limit: 100 }));
    expect(page.items.filter((item) => item.userId === userId)).toEqual([
      expect.objectContaining({ userId, grantedBy: owner }),
    ]);
  });

  it('refuses listing someone who is not a member', async () => {
    expect(await codeOf(grant(randomUUID()))).toBe('23503');
  });
});
