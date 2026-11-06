// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Mandate flag alerts from the flag to operations, against Postgres: intake flags a
// mandate and records why, and the delivery tells operations, in order, once each.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { PUBLIC_TEST_ATTESTER_KEYS, createEventIntake } from '@ujira/chain-adapter';
import type { Bytes32, LedgerEvent, NetworkId, TenantScope } from '@ujira/chain-adapter';
import { contractAddress } from '@ujira/chain-adapter/testing';
import type { Database } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AlertDeliveryError, createMandateAlertDelivery } from './alerts.js';
import type { MandateAlertSink, MandateFlagAlert } from './alerts.js';
import { dbIntakeStore } from './stores.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const NETWORK: NetworkId = 'stellar:testnet';
const FACTORY = contractAddress(new Uint8Array(32).fill(41));

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

function tagFor(scope: TenantScope, contract: string): Bytes32 {
  const digest = createHash('sha256').update(`${scope.projectId}:${contract}`).digest('hex');
  return `0x${digest}` as Bytes32;
}

let ledger = 500n;

function ledgerEvent(over: Partial<LedgerEvent>): LedgerEvent {
  ledger += 1n;
  return {
    network: NETWORK,
    contractId: FACTORY,
    type: 'contract',
    successful: true,
    txHash: randomBytes(32).toString('hex'),
    eventIndex: 0n,
    ledger,
    closedAt: new Date().toISOString(),
    name: null,
    key: null,
    fields: null,
    ...over,
  };
}

// A mandate the factory made directly, so no tenant claims it, initialized with a key
// anyone can rebuild. Intake flags it and records why.
async function flaggedMandate(): Promise<string> {
  const intake = createEventIntake({
    network: NETWORK,
    store: dbIntakeStore(db),
    trustedFactories: () => [FACTORY],
    tenantTagFor: tagFor,
    nodeEnv: 'production',
  });
  const mandate = contractAddress(randomBytes(32));
  const tag = `0x${randomBytes(32).toString('hex')}` as Bytes32;
  await intake.ingest(
    ledgerEvent({
      name: 'mandate_created',
      key: tag,
      fields: { mandate, principal: 'GPRINCIPAL', asset: 'CUSDC' },
    }),
  );
  const [key = ''] = PUBLIC_TEST_ATTESTER_KEYS;
  const outcome = await intake.ingest(
    ledgerEvent({
      contractId: mandate,
      name: 'mandate_initialized',
      key: tag,
      fields: { principal: 'GPRINCIPAL', attester: `0x${key}` },
    }),
  );
  expect(outcome).toEqual({ action: 'flagged', contractId: mandate });
  return mandate;
}

/** A sink that remembers what it was told, and can be made to fail on one contract. */
function recording(failOn: string | null = null) {
  const told: MandateFlagAlert[] = [];
  const keys: string[] = [];
  const sink: MandateAlertSink = {
    mandateFlagged(alert, opts) {
      if (alert.contractId === failOn) return Promise.reject(new Error('pager down'));
      told.push(alert);
      keys.push(opts.idempotencyKey);
      return Promise.resolve();
    },
  };
  return { sink, told, keys };
}

// Every test reads the same alert table, so each delivers to a sink of its own name and
// keeps only the contracts it flagged.
function sinkName(): string {
  return `test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function contractsOf(alerts: readonly MandateFlagAlert[], mine: readonly string[]): string[] {
  return alerts.map((alert) => alert.contractId).filter((contract) => mine.includes(contract));
}

describe('mandate flag alerts', () => {
  it('a flag on a public test attester key reaches operations, naming the contract and the reason', async () => {
    const mandate = await flaggedMandate();
    const { sink, told } = recording();
    await createMandateAlertDelivery({ db, sink, sinkName: sinkName() }).deliverPending();
    const alert = told.find((each) => each.contractId === mandate);
    expect(alert).toMatchObject({
      network: NETWORK,
      contractId: mandate,
      reason: 'public_test_attester',
    });
    expect(alert?.raisedAt).toBeInstanceOf(Date);
  });

  it('a restart of the delivery neither loses nor repeats an alert', async () => {
    const first = await flaggedMandate();
    const second = await flaggedMandate();
    const name = sinkName();
    const mine = [first, second];

    // The sink fails on the second, so the pass stops there with the first told.
    const failing = recording(second);
    await expect(
      createMandateAlertDelivery({ db, sink: failing.sink, sinkName: name }).deliverPending(),
    ).rejects.toBeInstanceOf(AlertDeliveryError);
    expect(contractsOf(failing.told, mine)).toEqual([first]);

    // A fresh delivery, as after a restart, picks up at the second and tells it once.
    const restarted = recording();
    await createMandateAlertDelivery({ db, sink: restarted.sink, sinkName: name }).deliverPending();
    expect(contractsOf(restarted.told, mine)).toEqual([second]);

    // Another restart has nothing left, until the next flag.
    const again = recording();
    await createMandateAlertDelivery({ db, sink: again.sink, sinkName: name }).deliverPending();
    expect(contractsOf(again.told, mine)).toEqual([]);
    const third = await flaggedMandate();
    await createMandateAlertDelivery({ db, sink: again.sink, sinkName: name }).deliverPending();
    expect(contractsOf(again.told, [...mine, third])).toEqual([third]);
  });

  it('tells each alert once, in the order raised, under a key a sink can drop a repeat by', async () => {
    const flagged = [await flaggedMandate(), await flaggedMandate(), await flaggedMandate()];
    const { sink, told, keys } = recording();
    const delivered = await createMandateAlertDelivery({
      db,
      sink,
      sinkName: sinkName(),
      batchSize: 1,
    }).deliverPending();
    expect(contractsOf(told, flagged)).toEqual(flagged);
    expect(delivered).toBe(told.length);
    const ids = told.map((alert) => alert.alertId);
    expect([...ids].sort((a, b) => (a < b ? -1 : 1))).toEqual(ids);
    expect(keys).toEqual(ids.map((id) => `mandate-alert:${String(id)}`));
  });

  it('gives up on a sink that hangs, and tells that alert on the next pass', async () => {
    const mandate = await flaggedMandate();
    const name = sinkName();
    const hanging: MandateAlertSink = {
      mandateFlagged: (alert) =>
        alert.contractId === mandate ? new Promise(() => undefined) : Promise.resolve(),
    };
    await expect(
      createMandateAlertDelivery({
        db,
        sink: hanging,
        sinkName: name,
        timeoutMs: 50,
      }).deliverPending(),
    ).rejects.toBeInstanceOf(AlertDeliveryError);
    const { sink, told } = recording();
    await createMandateAlertDelivery({ db, sink, sinkName: name }).deliverPending();
    expect(contractsOf(told, [mandate])).toEqual([mandate]);
  });
});
