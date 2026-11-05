// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What every payout test starts from: a tenant with a recipient and one mandate
// deployed on one network.

import { randomBytes, randomUUID } from 'node:crypto';

import { tokenAmount, type TokenAmount } from '@ujira/core';

import type { Database } from '../database.js';
import { entryPoints, type CreatedPrincipal } from '../repositories/entry-points.js';
import { mandateInstances, mandates } from '../repositories/mandates.js';
import type { NewPayout, NewPayoutAttempt, NewPayoutLeg } from '../repositories/payouts.js';
import { payoutMethods, recipients } from '../repositories/recipients.js';

export interface PayoutFixture {
  readonly tenant: CreatedPrincipal;
  readonly memberId: string;
  readonly recipientId: string;
  readonly methodId: string;
  readonly destinationAddress: string;
  readonly mandateId: string;
  readonly instanceId: string;
}

// In raw token units, so 1.00 USDC is 10_000_000n.
export function usdc(amount: bigint): TokenAmount {
  return tokenAmount(amount, 'USDC', 'stellar');
}

export const ONE_USDC = 10_000_000n;

// The network every fixture instance is on.
export const TESTNET = 'stellar:testnet';

export async function payoutFixture(db: Database): Promise<PayoutFixture> {
  const memberId = randomUUID();
  const tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, { name: 'Acme', projectName: 'Main', ownerUserId: memberId }),
  );
  const rows = await db.tenant(tenant).transaction(async (tx) => {
    const recipient = await recipients.create(tx, {
      recipientRef: randomBytes(32),
      country: 'NG',
    });
    const mandate = await mandates.create(tx, { name: 'Payroll' });
    const instance = await mandateInstances.create(tx, {
      network: 'stellar:testnet',
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
      recipientId: recipient.id,
      methodId: method.id,
      destinationAddress,
      mandateId: mandate.id,
      instanceId: instance.id,
    };
  });
  return { tenant, memberId, ...rows };
}

export function newLeg(fixture: PayoutFixture, amount: bigint): NewPayoutLeg {
  return {
    payoutMethodId: fixture.methodId,
    method: 'stellar_wallet',
    destinationAddress: fixture.destinationAddress,
    amount,
  };
}

// One leg carrying the whole total, unless the caller says otherwise.
export function newAttempt(
  fixture: PayoutFixture,
  payoutId: string,
  overrides: Partial<NewPayoutAttempt> = {},
): NewPayoutAttempt {
  const total = overrides.total ?? usdc(5n * ONE_USDC);
  return {
    payoutId,
    mandateInstanceId: fixture.instanceId,
    network: TESTNET,
    total,
    deadline: new Date(Date.now() + 3_600_000),
    legs: [newLeg(fixture, total.amount)],
    ...overrides,
  };
}

export function newPayout(fixture: PayoutFixture, overrides: Partial<NewPayout> = {}): NewPayout {
  return {
    idempotencyKey: randomUUID(),
    recipientId: fixture.recipientId,
    mandateId: fixture.mandateId,
    method: 'stellar_wallet',
    requested: usdc(5n * ONE_USDC),
    ...overrides,
  };
}
