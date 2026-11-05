// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Standard fee terms against real Postgres, as the real roles.
 *
 * - Every project has terms from the instant it exists, by every path that creates one,
 *   so no payout is refused for having none and every attempt can name its terms.
 * - A month's rate follows the principal's executed volume in the month before, in UTC.
 *   Reaching a band's floor earns its rate. Only executed attempts count, each once.
 * - The rate moves by a new row, so an attempt keeps the terms it was charged under.
 * - Terms somebody agreed are never overwritten, and a rate never passes the mandate's cap.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import { FeeVolumeAttemptUnknownError, InvalidFeeMonthError, fees } from './repositories/fees.js';
import { mandateInstances, mandates } from './repositories/mandates.js';
import { payoutAttempts, payouts } from './repositories/payouts.js';
import { payoutMethods, recipients } from './repositories/recipients.js';
import { projects } from './repositories/tenancy.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  ONE_USDC,
  newAttempt,
  newLeg,
  newPayout,
  payoutFixture,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const STANDARD_START = 90;
const YEAR = new Date().getUTCFullYear() + 1;
const month = (index: number) => new Date(Date.UTC(YEAR, index, 1));
const JANUARY = month(0);
const FEBRUARY = month(1);
const MARCH = month(2);
const APRIL = month(3);
const MID_JANUARY = new Date(Date.UTC(YEAR, 0, 15));
const MID_FEBRUARY = new Date(Date.UTC(YEAR, 1, 15));
const usd = (dollars: bigint) => dollars * ONE_USDC;
// The contract's fee_cap expression, the same one the fee builder and the database use.
const feeAt = (total: bigint, bps: number) =>
  (total / 10_000n) * BigInt(bps) + ((total % 10_000n) * BigInt(bps)) / 10_000n;

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

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

/** A final attempt of the given total, the only kind that moves a rate. */
async function executedAttempt(fixture: PayoutFixture, total: bigint): Promise<string> {
  return db.tenant(fixture.tenant).transaction(async (tx) => {
    const { payout } = await payouts.create(tx, newPayout(fixture, { requested: usdc(total) }));
    const attempt = await payoutAttempts.create(
      tx,
      newAttempt(fixture, payout.id, { total: usdc(total), legs: [newLeg(fixture, total)] }),
    );
    await payoutAttempts.transition(tx, attempt.id, { from: 'created', to: 'requested' });
    await payoutAttempts.transition(tx, attempt.id, { from: 'requested', to: 'executing' });
    await payoutAttempts.transition(tx, attempt.id, { from: 'executing', to: 'final' });
    return attempt.id;
  });
}

async function volumeIn(fixture: PayoutFixture, total: bigint, at: Date): Promise<void> {
  const attemptId = await executedAttempt(fixture, total);
  await db.tenant(fixture.tenant).transaction((tx) => fees.recordExecutedVolume(tx, attemptId, at));
}

async function apply(fixture: PayoutFixture, monthStart: Date) {
  return db.tenant(fixture.tenant).transaction((tx) => fees.applyStandardRate(tx, monthStart));
}

async function rateAt(fixture: PayoutFixture, at: Date) {
  return db.tenant(fixture.tenant).transaction((tx) => fees.termsAt(tx, at));
}

async function termsRows(projectId: string): Promise<number> {
  const { rows } = await admin.query<{ count: string }>(
    'select count(*) from ujira.fee_terms where project_id = $1',
    [projectId],
  );
  return Number(rows[0]?.count);
}

async function auditRows(projectId: string): Promise<number> {
  const { rows } = await admin.query<{ count: string }>(
    `select count(*) from ujira.audit_log where project_id = $1 and action = 'fee_terms.recorded'`,
    [projectId],
  );
  return Number(rows[0]?.count);
}

/** A second project of the same principal, with what it takes to pay from it. */
async function secondProject(fixture: PayoutFixture): Promise<PayoutFixture> {
  const projectId = await db
    .tenant(fixture.tenant)
    .transaction((tx) => projects.create(tx, { name: `Second ${randomUUID()}` }));
  const tenant = { ...fixture.tenant, projectId };
  return db.tenant(tenant).transaction(async (tx) => {
    const recipient = await recipients.create(tx, { recipientRef: randomBytes(32), country: 'NG' });
    const mandate = await mandates.create(tx, { name: 'Second' });
    const instance = await mandateInstances.create(tx, {
      mandateId: mandate.id,
      chain: 'stellar',
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
    const destinationAddress = `G${randomUUID()}`;
    const method = await payoutMethods.create(tx, {
      recipientId: recipient.id,
      method: 'stellar_wallet',
      rail: 'wallet',
      chain: 'stellar',
      destinationAddress,
      destinationTag: null,
      details: null,
    });
    return {
      ...fixture,
      tenant,
      recipientId: recipient.id,
      mandateId: mandate.id,
      instanceId: instance.id,
      methodId: method.id,
      destinationAddress,
      methods: [{ id: method.id, destinationAddress }],
    };
  });
}

describe('every project has terms', () => {
  it('from the moment a principal is created, at the top standard rate', async () => {
    const memberId = randomUUID();
    const tenant = await db.unscoped((tx) =>
      entryPoints.createPrincipal(tx, { name: 'New', projectName: 'Main', ownerUserId: memberId }),
    );
    const terms = await db
      .tenant(tenant)
      .transaction((tx) => fees.termsAt(tx, new Date(Date.now() + 1000)));
    expect(terms).toMatchObject({ rateBps: STANDARD_START, basis: 'standard' });
  });

  it('when a principal adds a project', async () => {
    const fixture = await payoutFixture(db);
    const second = await secondProject(fixture);
    expect(await rateAt(second, new Date(Date.now() + 1000))).toMatchObject({
      rateBps: STANDARD_START,
      basis: 'standard',
    });
  });

  it('whoever inserts the project, even by hand', async () => {
    const fixture = await payoutFixture(db);
    const id = randomUUID();
    await admin.query(
      `insert into ujira.projects (principal_id, id, name) values ($1, $2, 'Hand')`,
      [fixture.tenant.principalId, id],
    );
    expect(await termsRows(id)).toBe(1);
  });

  it('and writes no audit entry, since a default is no one deciding anything', async () => {
    const fixture = await payoutFixture(db);
    expect(await auditRows(fixture.tenant.projectId)).toBe(0);
    expect(await termsRows(fixture.tenant.projectId)).toBeGreaterThan(0);
  });

  it('and audits a rate that moves, as the system', async () => {
    const fixture = await payoutFixture(db);
    await volumeIn(fixture, usd(100_000n), MID_JANUARY);
    await apply(fixture, FEBRUARY);
    const { rows } = await admin.query<{ actor_kind: string; actor_id: string | null }>(
      `select actor_kind, actor_id from ujira.audit_log
        where project_id = $1 and action = 'fee_terms.recorded'`,
      [fixture.tenant.projectId],
    );
    expect(rows).toEqual([{ actor_kind: 'system', actor_id: null }]);
  });

  it('and gives a project from before this existed its terms too', async () => {
    const fixture = await payoutFixture(db);
    const id = randomUUID();
    await admin.query('alter table ujira.projects disable trigger projects_standard_fee_terms');
    try {
      await admin.query(
        `insert into ujira.projects (principal_id, id, name) values ($1, $2, 'Old')`,
        [fixture.tenant.principalId, id],
      );
    } finally {
      await admin.query('alter table ujira.projects enable trigger projects_standard_fee_terms');
    }
    expect(await termsRows(id)).toBe(0);

    await admin.query('select ujira.backfill_standard_fee_terms()');
    await admin.query('select ujira.backfill_standard_fee_terms()');

    expect(await termsRows(id)).toBe(1);
    const { rows } = await admin.query<{ count: string }>(
      `select count(*) from ujira.projects as p
        where not exists (select 1 from ujira.fee_terms as t where t.project_id = p.id)`,
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('the bands', () => {
  // The floor of a band earns that band's rate, so one raw unit below it does not.
  it.each([
    [0n, 90],
    [usd(100_000n) - 1n, 90],
    [usd(100_000n), 70],
    [usd(1_000_000n) - 1n, 70],
    [usd(1_000_000n), 50],
    [usd(10_000_000n) - 1n, 50],
    [usd(10_000_000n), 35],
    [usd(50_000_000n) - 1n, 35],
    [usd(50_000_000n), 25],
    [usd(500_000_000n), 25],
  ])('a month of %s raw units gives %i basis points', async (volume, rate) => {
    const fixture = await payoutFixture(db);
    if (volume > 0n) await volumeIn(fixture, volume, MID_JANUARY);

    const result = await apply(fixture, FEBRUARY);

    expect(result.rateBps).toBe(rate);
    expect((await rateAt(fixture, FEBRUARY))?.rateBps).toBe(rate);
  });

  it('are whole basis points that only fall, within what a mandate can carry', async () => {
    const { rows } = await admin.query<{ floor_amount: string; rate_bps: string }>(
      'select floor_amount, rate_bps from ops.standard_fee_tiers order by floor_amount',
    );
    expect(rows.map((row) => row.floor_amount)[0]).toBe('0');
    const rates = rows.map((row) => Number(row.rate_bps));
    expect(rates).toEqual([90, 70, 50, 35, 25]);
    expect(rates.every((rate) => Number.isInteger(rate) && rate <= 100)).toBe(true);
    await expect(
      admin.query(
        `insert into ops.standard_fee_tiers (floor_amount, rate_bps, asset, scale)
         values (1, 101, 'USDC', 7)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('never let a rate pass the mandate cap, whatever the terms say', async () => {
    const fixture = await payoutFixture(db);
    const session = db.tenant(fixture.tenant);
    const total = 100n * ONE_USDC;
    const terms = await rateAt(fixture, new Date(Date.now() + 1000));
    if (terms === undefined) throw new Error('every project has terms');
    expect(terms.rateBps).toBe(STANDARD_START);

    const capped = await session.transaction(async (tx) => {
      const mandate = await mandates.create(tx, { name: 'Capped' });
      return mandateInstances.create(tx, {
        mandateId: mandate.id,
        chain: 'stellar',
        contractAddress: `C${randomUUID()}`,
        specVersion: '1',
        asset: 'USDC',
        scale: 7,
        maxFeeBps: 50,
        feeAddress: 'GFEE',
      });
    });
    const attemptAt = (bps: number) =>
      session.transaction(async (tx) => {
        const mandateId = capped.mandateId;
        const { payout } = await payouts.create(
          tx,
          newPayout(fixture, { mandateId, requested: usdc(total) }),
        );
        return payoutAttempts.create(
          tx,
          newAttempt(fixture, payout.id, {
            mandateInstanceId: capped.id,
            total: usdc(total),
            legs: [newLeg(fixture, total)],
            fee: { amount: feeAt(total, bps), bps, termsId: terms.id },
          }),
        );
      });

    await expect(attemptAt(STANDARD_START)).rejects.toMatchObject({ code: '23514' });
    const atCap = await attemptAt(Math.min(STANDARD_START, capped.maxFeeBps ?? 0));
    expect(atCap.feeBps).toBe(50);
    expect(atCap.fee.amount).toBe(feeAt(total, 50));
  });
});

describe('a month rolling over', () => {
  it('moves the rate for the next month only, and back when volume falls', async () => {
    const fixture = await payoutFixture(db);
    await volumeIn(fixture, usd(100_000n), MID_JANUARY);

    expect(await apply(fixture, FEBRUARY)).toEqual({ rateBps: 70, applied: true });
    expect(await apply(fixture, MARCH)).toEqual({ rateBps: 90, applied: true });

    expect((await rateAt(fixture, new Date(FEBRUARY.getTime() - 1)))?.rateBps).toBe(STANDARD_START);
    expect((await rateAt(fixture, FEBRUARY))?.rateBps).toBe(70);
    expect((await rateAt(fixture, new Date(MARCH.getTime() - 1)))?.rateBps).toBe(70);
    expect((await rateAt(fixture, MARCH))?.rateBps).toBe(90);
  });

  it('counts the last instant of a month in that month, and the next in the next', async () => {
    const fixture = await payoutFixture(db);
    await volumeIn(fixture, usd(100_000n), new Date(FEBRUARY.getTime() - 1));
    await volumeIn(fixture, usd(1_000_000n), FEBRUARY);

    expect((await apply(fixture, FEBRUARY)).rateBps).toBe(70);
    expect((await apply(fixture, MARCH)).rateBps).toBe(50);
  });

  it('crosses from December into January on UTC', async () => {
    const fixture = await payoutFixture(db);
    const december = new Date(Date.UTC(YEAR, 11, 1));
    const nextJanuary = new Date(Date.UTC(YEAR + 1, 0, 1));
    await volumeIn(fixture, usd(1_000_000n), new Date(Date.UTC(YEAR, 11, 31, 23, 59, 59)));
    await volumeIn(fixture, usd(10_000_000n), new Date(Date.UTC(YEAR, 10, 30, 23, 59, 59)));

    expect((await apply(fixture, december)).rateBps).toBe(35);
    expect((await apply(fixture, nextJanuary)).rateBps).toBe(50);
  });

  it('adds nothing when the rate would not change', async () => {
    const fixture = await payoutFixture(db);
    const before = await termsRows(fixture.tenant.projectId);
    expect(await apply(fixture, FEBRUARY)).toEqual({ rateBps: STANDARD_START, applied: false });
    expect(await termsRows(fixture.tenant.projectId)).toBe(before);
  });

  it('writes one row and one audit entry however many jobs run at once', async () => {
    const fixture = await payoutFixture(db);
    await volumeIn(fixture, usd(100_000n), MID_JANUARY);
    const { projectId } = fixture.tenant;
    const rows = await termsRows(projectId);
    const audits = await auditRows(projectId);

    const results = await Promise.all(Array.from({ length: 20 }, () => apply(fixture, FEBRUARY)));

    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(results.every((r) => r.rateBps === 70)).toBe(true);
    expect(await termsRows(projectId)).toBe(rows + 1);
    expect(await auditRows(projectId)).toBe(audits + 1);
    expect(await apply(fixture, FEBRUARY)).toEqual({ rateBps: 70, applied: false });
  });

  it('is held to one row per instant by the table itself', async () => {
    const fixture = await payoutFixture(db);
    await volumeIn(fixture, usd(100_000n), MID_JANUARY);
    await apply(fixture, FEBRUARY);
    await expect(
      admin.query(
        `insert into ujira.fee_terms (principal_id, project_id, rate_bps, basis, valid_from)
         values ($1, $2, 70, 'standard', $3)`,
        [fixture.tenant.principalId, fixture.tenant.projectId, FEBRUARY],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('keeps the rate it wrote when an execution is recorded late', async () => {
    const fixture = await payoutFixture(db);
    await volumeIn(fixture, usd(100_000n), MID_JANUARY);
    await apply(fixture, FEBRUARY);
    await volumeIn(fixture, usd(1_000_000n), MID_JANUARY);

    expect(await apply(fixture, FEBRUARY)).toMatchObject({ applied: false });
    expect((await rateAt(fixture, FEBRUARY))?.rateBps).toBe(70);
  });

  it('leaves an attempt on the terms it was charged under', async () => {
    const fixture = await payoutFixture(db);
    const first = await rateAt(fixture, new Date(Date.now() + 1000));
    if (first === undefined) throw new Error('every project has terms');
    const total = 100n * ONE_USDC;
    const attempt = await db.tenant(fixture.tenant).transaction(async (tx) => {
      const { payout } = await payouts.create(tx, newPayout(fixture, { requested: usdc(total) }));
      return payoutAttempts.create(
        tx,
        newAttempt(fixture, payout.id, {
          total: usdc(total),
          legs: [newLeg(fixture, total)],
          fee: {
            amount: feeAt(total, first.rateBps),
            bps: first.rateBps,
            termsId: first.id,
          },
        }),
      );
    });

    await volumeIn(fixture, usd(1_000_000n), MID_JANUARY);
    await apply(fixture, FEBRUARY);

    const after = await db
      .tenant(fixture.tenant)
      .transaction((tx) => payoutAttempts.get(tx, attempt.id));
    expect(after).toMatchObject({ feeTermsId: first.id, feeBps: first.rateBps });
    expect((await rateAt(fixture, new Date(FEBRUARY.getTime() - 1)))?.id).toBe(first.id);
    await expect(
      admin.query('update ujira.fee_terms set rate_bps = 1 where id = $1', [first.id]),
    ).rejects.toThrow();
  });

  it('never overwrites terms somebody agreed', async () => {
    for (const basis of ['committed_volume', 'negotiated', 'internal_at_cost'] as const) {
      const fixture = await payoutFixture(db);
      await db.tenant(fixture.tenant).transaction((tx) =>
        fees.recordTerms(tx, {
          rateBps: 40,
          basis,
          validFrom: new Date(Date.now() + 1000),
          contractReference: null,
          actor: { kind: 'member', id: fixture.memberId },
        }),
      );
      await volumeIn(fixture, usd(50_000_000n), MID_JANUARY);

      expect(await apply(fixture, FEBRUARY)).toEqual({ rateBps: null, applied: false });
      expect(await rateAt(fixture, FEBRUARY)).toMatchObject({ rateBps: 40, basis });
    }
  });

  it('does not reach back before a project existed', async () => {
    const fixture = await payoutFixture(db);
    const before = await termsRows(fixture.tenant.projectId);
    const longAgo = new Date(Date.UTC(2020, 0, 1));
    expect(await apply(fixture, longAgo)).toEqual({ rateBps: null, applied: false });
    expect(await termsRows(fixture.tenant.projectId)).toBe(before);
  });

  it('refuses anything but the first instant of a UTC month', async () => {
    const fixture = await payoutFixture(db);
    for (const notAMonth of [MID_JANUARY, new Date(FEBRUARY.getTime() + 1), new Date(Number.NaN)]) {
      await expect(apply(fixture, notAMonth)).rejects.toBeInstanceOf(InvalidFeeMonthError);
    }
    await expect(
      db
        .tenant(fixture.tenant)
        .transaction((tx) =>
          sql`select * from ujira.apply_standard_fee_rate(${MID_JANUARY}::timestamptz)`.execute(tx),
        ),
    ).rejects.toMatchObject({ code: '22023' });
  });
});

describe('recording volume', () => {
  it('counts each attempt once however many runs record it at once', async () => {
    const fixture = await payoutFixture(db);
    const attemptId = await executedAttempt(fixture, usd(10n));
    const session = db.tenant(fixture.tenant);

    const recorded = await Promise.all(
      Array.from({ length: 20 }, () =>
        session.transaction((tx) => fees.recordExecutedVolume(tx, attemptId, MID_JANUARY)),
      ),
    );

    expect(recorded.filter(Boolean)).toHaveLength(1);
    const volume = await session.transaction((tx) => fees.executedVolume(tx, JANUARY));
    expect(volume).toEqual(usdc(usd(10n)));
  });

  it('adds up different attempts recorded at once, to the raw unit', async () => {
    const fixture = await payoutFixture(db);
    const session = db.tenant(fixture.tenant);
    const amounts = Array.from({ length: 12 }, (_, i) => usd(10n) + BigInt(i));
    const attempts = await Promise.all(amounts.map((a) => executedAttempt(fixture, a)));

    await Promise.all(
      attempts.map((attemptId) =>
        session.transaction((tx) => fees.recordExecutedVolume(tx, attemptId, MID_JANUARY)),
      ),
    );

    const volume = await session.transaction((tx) => fees.executedVolume(tx, JANUARY));
    expect(volume.amount).toBe(amounts.reduce((sum, a) => sum + a, 0n));
  });

  it('refuses an attempt that has not executed', async () => {
    const fixture = await payoutFixture(db);
    const session = db.tenant(fixture.tenant);
    const attemptId = await session.transaction(async (tx) => {
      const { payout } = await payouts.create(tx, newPayout(fixture));
      return (await payoutAttempts.create(tx, newAttempt(fixture, payout.id))).id;
    });
    await expect(
      session.transaction((tx) => fees.recordExecutedVolume(tx, attemptId, MID_JANUARY)),
    ).rejects.toMatchObject({ code: 'UJ021' });
  });

  it('stops counting an attempt that settled and then died', async () => {
    const fixture = await payoutFixture(db);
    const session = db.tenant(fixture.tenant);
    const attemptId = await session.transaction(async (tx) => {
      const { payout } = await payouts.create(tx, newPayout(fixture));
      const attempt = await payoutAttempts.create(tx, newAttempt(fixture, payout.id));
      await payoutAttempts.transition(tx, attempt.id, { from: 'created', to: 'requested' });
      await payoutAttempts.transition(tx, attempt.id, { from: 'requested', to: 'executing' });
      await payoutAttempts.transition(tx, attempt.id, { from: 'executing', to: 'settled' });
      return attempt.id;
    });
    await session.transaction((tx) => fees.recordExecutedVolume(tx, attemptId, MID_JANUARY));
    expect((await session.transaction((tx) => fees.executedVolume(tx, JANUARY))).amount).toBe(
      5n * ONE_USDC,
    );

    await session.transaction((tx) =>
      payoutAttempts.markDead(tx, attemptId, { from: 'settled', proof: { kind: 'reorged' } }),
    );

    expect((await session.transaction((tx) => fees.executedVolume(tx, JANUARY))).amount).toBe(0n);
  });

  it('takes the amount from the attempt, whatever a caller says', async () => {
    const fixture = await payoutFixture(db);
    const attemptId = await executedAttempt(fixture, usd(10n));
    const { rows } = await admin.query<{ payout_id: string }>(
      'select payout_id from ujira.payout_attempts where id = $1',
      [attemptId],
    );
    await expect(
      admin.query(
        `insert into ujira.fee_volume_entries
           (principal_id, project_id, attempt_id, payout_id, amount, chain, asset, scale, executed_at)
         values ($1, $2, $3, $4, 1, 'stellar', 'USDC', 7, $5)`,
        [
          fixture.tenant.principalId,
          fixture.tenant.projectId,
          attemptId,
          rows[0]?.payout_id,
          MID_JANUARY,
        ],
      ),
    ).rejects.toMatchObject({ code: 'UJ021' });
  });

  it('is never edited or removed, even by the owner', async () => {
    const fixture = await payoutFixture(db);
    await volumeIn(fixture, usd(10n), MID_JANUARY);
    for (const statement of [
      'update ujira.fee_volume_entries set executed_at = now() where project_id = $1',
      'delete from ujira.fee_volume_entries where project_id = $1',
    ]) {
      await expect(admin.query(statement, [fixture.tenant.projectId])).rejects.toThrow();
    }
  });

  it('adds up across the projects of a principal, and moves each of them', async () => {
    const fixture = await payoutFixture(db);
    const second = await secondProject(fixture);
    await volumeIn(fixture, usd(60_000n), MID_JANUARY);
    await volumeIn(second, usd(40_000n), MID_JANUARY);

    expect((await apply(fixture, FEBRUARY)).rateBps).toBe(70);
    expect((await apply(second, FEBRUARY)).rateBps).toBe(70);
    expect((await rateAt(second, FEBRUARY))?.rateBps).toBe(70);
  });

  it('never counts another principal', async () => {
    const fixture = await payoutFixture(db);
    const stranger = await payoutFixture(db);
    await volumeIn(stranger, usd(50_000_000n), MID_FEBRUARY);
    expect(await apply(fixture, MARCH)).toEqual({ rateBps: STANDARD_START, applied: false });
    expect(
      (await db.tenant(fixture.tenant).transaction((tx) => fees.executedVolume(tx, FEBRUARY)))
        .amount,
    ).toBe(0n);
  });

  it('cannot record an attempt of another tenant', async () => {
    const fixture = await payoutFixture(db);
    const stranger = await payoutFixture(db);
    const attemptId = await executedAttempt(stranger, usd(10n));
    await expect(
      db
        .tenant(fixture.tenant)
        .transaction((tx) => fees.recordExecutedVolume(tx, attemptId, MID_JANUARY)),
    ).rejects.toBeInstanceOf(FeeVolumeAttemptUnknownError);
    expect(APRIL.getTime()).toBeGreaterThan(MARCH.getTime());
  });
});
