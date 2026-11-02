// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import type { TenantScope, UnixSeconds, Uuid } from '../types.js';
import { createMemorySigningRequestStore } from './requests.js';
import type { StoredSigningRequest } from './requests.js';

const scope: TenantScope = {
  principalId: '11111111-1111-4111-8111-111111111111' as Uuid,
  projectId: '22222222-2222-4222-8222-222222222222' as Uuid,
};
const other: TenantScope = { ...scope, projectId: '33333333-3333-4333-8333-333333333333' as Uuid };

const request: StoredSigningRequest = {
  requestId: 'r1',
  scope,
  network: 'stellar:testnet',
  op: 'pause',
  mandate: null,
  payoutId: null,
  signer: 'G',
  kind: 'stellar_transaction',
  payload: 'xdr',
  hostFunction: null,
  sequence: 1n,
  fee: 100n,
  validUntil: 10n as UnixSeconds,
  summary: { action: 'pause', feePaidBy: 'ujira' },
};

describe('the in-memory signing request store', () => {
  it('keeps each request to its tenant and lets it be claimed once', async () => {
    const store = createMemorySigningRequestStore();
    await store.save(request);
    await expect(store.save(request)).rejects.toThrow('already used');
    expect(await store.load(other, 'r1')).toBeNull();
    expect(await store.load(scope, 'r1')).toEqual({ request, use: null });

    await expect(store.setTxHash(scope, 'r1', 'h')).rejects.toThrow('not claimed');
    await expect(store.claim(other, 'r1', 's')).rejects.toThrow('no such');
    expect(await store.claim(scope, 'r1', 'signed')).toBeNull();
    expect(await store.claim(scope, 'r1', 'other')).toEqual({ signed: 'signed', txHash: null });
    await store.setTxHash(scope, 'r1', 'hash');
    expect((await store.load(scope, 'r1'))?.use).toEqual({ signed: 'signed', txHash: 'hash' });
    await expect(store.setTxHash(other, 'r1', 'h')).rejects.toThrow('not claimed');
  });
});
