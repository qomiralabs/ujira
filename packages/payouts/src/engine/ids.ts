// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The ids a payout carries on chain. The on-chain id is what keeps a retry from paying
// twice: it comes from the tenant, the payout's idempotency key and the attempt number,
// so every retry of an attempt names the same payout, which the mandate records once
// and which the database holds unique per mandate instance. It lives here and not in
// core, because core has no hashing and is bundled for browsers.

import { createHash } from 'node:crypto';

import type { Bytes32, LegKey, PayoutId } from '@ujira/chain-adapter';

// Length prefixed, so no two different inputs can read the same.
function digest(domain: string, fields: readonly string[]): string {
  const hash = createHash('sha256');
  for (const field of [domain, ...fields]) {
    const bytes = Buffer.from(field, 'utf8');
    hash.update(`${String(bytes.length)}:`);
    hash.update(bytes);
  }
  return `0x${hash.digest('hex')}`;
}

export function onChainPayoutId(
  tenant: { readonly principalId: string; readonly projectId: string },
  idempotencyKey: string,
  attemptNumber: number,
): PayoutId {
  return digest('ujira/payout/v1', [
    tenant.principalId,
    tenant.projectId,
    idempotencyKey,
    String(attemptNumber),
  ]) as PayoutId;
}

export function legKeyOf(payoutId: PayoutId, legIndex: number): LegKey {
  return `${payoutId}${legIndex.toString(16).padStart(2, '0')}` as LegKey;
}

// A payout has no task reference of its own yet, so its row id stands in for one.
export function taskRefOf(payoutRowId: string): Bytes32 {
  return digest('ujira/task/v1', [payoutRowId]) as Bytes32;
}

export function bytes32Of(raw: Buffer): Bytes32 {
  return `0x${raw.toString('hex')}` as Bytes32;
}
