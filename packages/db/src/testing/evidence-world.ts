// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One tenant with a recipient, a payout method and a mandate instance, which the
// evidence tests hang their rows on.

import { randomBytes, randomUUID } from 'node:crypto';

import type { Database } from '../database.js';
import { entryPoints, type CreatedPrincipal } from '../repositories/entry-points.js';
import { mandateInstances, mandates } from '../repositories/mandates.js';
import { payoutMethods, recipients } from '../repositories/recipients.js';

export interface EvidenceWorld {
  readonly tenant: CreatedPrincipal;
  readonly recipientId: string;
  readonly methodId: string;
  readonly instanceId: string;
  readonly address: string;
}

export async function evidenceWorld(db: Database): Promise<EvidenceWorld> {
  const tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
  const address = `G${randomUUID()}`;
  return db.tenant(tenant).transaction(async (tx) => {
    const recipient = await recipients.create(tx, {
      recipientRef: randomBytes(32),
      country: 'NG',
    });
    const method = await payoutMethods.create(tx, {
      recipientId: recipient.id,
      method: 'stellar_wallet',
      rail: 'wallet',
      chain: 'stellar',
      destinationAddress: address,
      destinationTag: null,
      details: null,
    });
    const mandate = await mandates.create(tx, { name: 'Attested' });
    const instance = await mandateInstances.create(tx, {
      mandateId: mandate.id,
      chain: 'stellar',
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
    return {
      tenant,
      recipientId: recipient.id,
      methodId: method.id,
      instanceId: instance.id,
      address,
    };
  });
}

export async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
