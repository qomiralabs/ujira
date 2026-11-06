// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The custody guard over real data, from the event to the signature, as the real roles.
 *
 * - A role event read by the indexer's intake store seats or unseats the address, so a
 *   managed key a principal adds straight on the contract is seen, not only one UJIRA's
 *   own flow adds.
 * - A managed key seated on a mandate that pays attested recipients only is refused, and
 *   so is one seated where the mode is not known yet.
 * - The mode is written once and never changes.
 * - One tenant's seats never decide another tenant's key.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { withCustodyGuard } from '@ujira/mandates';
import type { InstanceKey } from '@ujira/mandates';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { Database } from './database.js';
import { createManagedAgentPorts } from './managed-agent-ports.js';
import { mandateEventStore } from './repositories/mandate-registry.js';
import { managedAgents } from './repositories/managed-agents.js';
import { instanceRoles, mandateInstances } from './repositories/mandates.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { TESTNET, payoutFixture, type PayoutFixture } from './testing/payout-fixture.js';

type Uuid = InstanceKey['principalId'];
type GuardedSigner = Parameters<typeof withCustodyGuard>[0];

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const OPTS = { correlationId: 'custody', signal: new AbortController().signal };
const ROLE_AGENT = 1;
const ROLE_APPROVER = 2;

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let events = 0;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 8);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

/** A key UJIRA holds for an agent of this tenant, at a fresh address. */
async function managedKey(fixture: PayoutFixture): Promise<{ agentId: Uuid; address: string }> {
  const agentId = randomUUID() as Uuid;
  const address = `G${randomBytes(20).toString('hex').toUpperCase()}`;
  await admin.query(
    `insert into ujira.managed_signers
       (principal_id, project_id, network, agent_id, key_ref, address, consented_by_member_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      fixture.tenant.principalId,
      fixture.tenant.projectId,
      TESTNET,
      agentId,
      `agent-${agentId}`,
      address,
      fixture.memberId,
    ],
  );
  return { agentId, address };
}

async function contractOf(fixture: PayoutFixture): Promise<string> {
  const { rows } = await admin.query<{ contract_address: string }>(
    'select contract_address from ujira.mandate_instances where id = $1',
    [fixture.instanceId],
  );
  const contract = rows[0]?.contract_address;
  if (contract === undefined) throw new Error('the fixture has an instance');
  return contract;
}

async function setMode(fixture: PayoutFixture, mode: 'allowlist' | 'attested' | 'both') {
  return db
    .tenant(fixture.tenant)
    .transaction((tx) => mandateInstances.setRecipientMode(tx, fixture.instanceId, mode));
}

/** A role event on this tenant's mandate, through the store the indexer's intake writes with. */
async function roleEvent(
  fixture: PayoutFixture,
  name: 'role_added' | 'role_removed',
  role: number,
  account: string,
  txHash = randomBytes(32).toString('hex'),
) {
  events += 1;
  const store = mandateEventStore(db, () => 'stellar');
  return store.book({
    tenant: {
      scope: { principalId: fixture.tenant.principalId, projectId: fixture.tenant.projectId },
      mandateInstanceId: fixture.instanceId,
    },
    network: TESTNET,
    contractId: await contractOf(fixture),
    txHash,
    eventIndex: 0n,
    ledger: BigInt(1000 + events),
    closedAt: new Date().toISOString(),
    name,
    payload: { role, account },
    payoutId: null,
  });
}

function guarded(fixture: PayoutFixture) {
  const backend = {
    sign: vi.fn(() => Promise.resolve({ signature: 'signed' })),
    address: vi.fn(),
    health: vi.fn(),
  };
  const ports = createManagedAgentPorts({ db });
  const signer = withCustodyGuard(backend as unknown as GuardedSigner, {
    mandates: ports.mandates,
    timeoutMs: 5_000,
  });
  const sign = (agentId: Uuid, scope = fixture.tenant) =>
    signer.sign(
      {
        kind: 'managed_agent',
        network: TESTNET,
        scope: scope as never,
        agentId,
      } as never,
      { kind: 'stellar_tx', network: TESTNET, xdr: 'AAAA' } as never,
      OPTS,
    );
  return { sign, backend };
}

describe('the custody guard over the chain', () => {
  it('a managed key added directly on chain is refused', async () => {
    const fixture = await payoutFixture(db);
    await setMode(fixture, 'attested');
    const { agentId, address } = await managedKey(fixture);
    const { sign, backend } = guarded(fixture);

    await expect(sign(agentId)).resolves.toMatchObject({ signature: 'signed' });

    // The principal adds UJIRA's key straight on the contract; only the event tells.
    expect(await roleEvent(fixture, 'role_added', ROLE_AGENT, address)).toBe(true);

    await expect(sign(agentId)).rejects.toMatchObject({ code: 'SIGNER_DENIED' });
    expect(backend.sign).toHaveBeenCalledTimes(1);
  });

  it('signs again once the key is removed on chain', async () => {
    const fixture = await payoutFixture(db);
    await setMode(fixture, 'attested');
    const { agentId, address } = await managedKey(fixture);
    const { sign } = guarded(fixture);
    await roleEvent(fixture, 'role_added', ROLE_AGENT, address);
    await expect(sign(agentId)).rejects.toMatchObject({ code: 'SIGNER_DENIED' });

    await roleEvent(fixture, 'role_removed', ROLE_AGENT, address);

    await expect(sign(agentId)).resolves.toMatchObject({ signature: 'signed' });
  });

  it('signs for a key seated where the principal allowlist binds the destination', async () => {
    for (const mode of ['allowlist', 'both'] as const) {
      const fixture = await payoutFixture(db);
      await setMode(fixture, mode);
      const { agentId, address } = await managedKey(fixture);
      await roleEvent(fixture, 'role_added', ROLE_AGENT, address);
      await expect(guarded(fixture).sign(agentId)).resolves.toMatchObject({ signature: 'signed' });
    }
  });

  it('refuses a key seated where the mode is not known yet', async () => {
    const fixture = await payoutFixture(db);
    const { agentId, address } = await managedKey(fixture);
    await roleEvent(fixture, 'role_added', ROLE_AGENT, address);
    await expect(guarded(fixture).sign(agentId)).rejects.toMatchObject({
      code: 'SIGNER_UNAVAILABLE',
    });
  });

  it('mirrors each event once, and the other roles too', async () => {
    const fixture = await payoutFixture(db);
    const { address } = await managedKey(fixture);
    const txHash = randomBytes(32).toString('hex');
    expect(await roleEvent(fixture, 'role_added', ROLE_APPROVER, address, txHash)).toBe(true);
    expect(await roleEvent(fixture, 'role_added', ROLE_APPROVER, address, txHash)).toBe(false);
    const held = await db
      .tenant(fixture.tenant)
      .transaction((tx) => instanceRoles.list(tx, fixture.instanceId, { limit: 100 }));
    expect(held.items.map((r) => [r.role, r.address, r.revokedEventId])).toEqual([
      ['approver', address, null],
    ]);
  });

  it('refuses a role event it cannot read, and records nothing of it', async () => {
    const fixture = await payoutFixture(db);
    await expect(roleEvent(fixture, 'role_added', 99, 'GSOMEONE')).rejects.toThrow();
    const held = await db
      .tenant(fixture.tenant)
      .transaction((tx) => instanceRoles.list(tx, fixture.instanceId, { limit: 100 }));
    expect(held.items).toEqual([]);
  });

  it("one tenant's seat never affects another", async () => {
    const owner = await payoutFixture(db);
    const other = await payoutFixture(db);
    await setMode(owner, 'allowlist');
    await setMode(other, 'attested');
    const { agentId, address } = await managedKey(owner);
    await roleEvent(owner, 'role_added', ROLE_AGENT, address);
    // Another tenant seats the owner's key on its own attested mandate.
    await roleEvent(other, 'role_added', ROLE_AGENT, address);

    await expect(guarded(owner).sign(agentId)).resolves.toMatchObject({ signature: 'signed' });
    expect(
      await db.tenant(other.tenant).transaction((tx) => managedAgents.seats(tx, agentId)),
    ).toEqual([]);
  });
});

describe('the recipient mode', () => {
  it('is written once and never changes', async () => {
    const fixture = await payoutFixture(db);
    expect(await setMode(fixture, 'allowlist')).toBe(true);
    expect(await setMode(fixture, 'allowlist')).toBe(false);
    expect(await setMode(fixture, 'attested')).toBe(false);
    await expect(
      admin.query(`update ujira.mandate_instances set recipient_mode = 'attested' where id = $1`, [
        fixture.instanceId,
      ]),
    ).rejects.toMatchObject({ code: 'UJ022' });
    await expect(
      admin.query(`update ujira.mandate_instances set recipient_mode = 'sometimes' where id = $1`, [
        fixture.instanceId,
      ]),
    ).rejects.toThrow();
  });
});

describe('managed keys', () => {
  it('knows the addresses this tenant holds keys for, and no other tenant does', async () => {
    const owner = await payoutFixture(db);
    const other = await payoutFixture(db);
    const { address } = await managedKey(owner);
    const ports = createManagedAgentPorts({ db });
    const agent = { network: TESTNET, value: address } as never;
    expect(await ports.keys.isManaged(owner.tenant as never, agent, OPTS)).toBe(true);
    expect(await ports.keys.isManaged(other.tenant as never, agent, OPTS)).toBe(false);
    expect(
      await ports.keys.isManaged(
        owner.tenant as never,
        { network: TESTNET, value: 'GNOBODY' } as never,
        OPTS,
      ),
    ).toBe(false);
  });
});
