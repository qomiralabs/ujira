// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { AttestationStateError } from '../errors.js';
import type { AttestationRecord } from '../types.js';

import { InMemoryAttestationLog, InMemoryPayoutLegs } from './attestation.js';
import { TEST_NOW, bytes32Of, legRow, mandateRow, methodRow, newId, newScope } from './fixtures.js';

function pendingRow(): AttestationRecord {
  const scope = newScope();
  const method = methodRow(scope, newId());
  const id = newId();
  return {
    scope,
    id,
    attemptId: newId(),
    legIndex: 0,
    mandateInstanceId: newId(),
    recipientId: method.recipientId,
    methodId: method.id,
    destination: method.destination,
    countryPolicyHash: bytes32Of('policy'),
    policyEpoch: 0n,
    validUntil: TEST_NOW,
    attesterKeyId: '0xabc',
    message: new Uint8Array([1, 2, 3]),
    digest: bytes32Of(`digest:${id}`),
    status: 'pending',
    signature: null,
    failureCode: null,
  };
}

describe('InMemoryAttestationLog', () => {
  it('moves a row from pending once, and only within its tenant', async () => {
    const log = new InMemoryAttestationLog();
    const row = pendingRow();
    await log.insertPending(row);
    expect(log.isPending(row.message, row.attesterKeyId)).toBe(true);
    expect(log.isPending(row.message, '0xother')).toBe(false);
    expect(log.isPending(new Uint8Array([9]), row.attesterKeyId)).toBe(false);

    await expect(log.markSigned(newScope(), row.id, new Uint8Array(64))).rejects.toThrow(
      AttestationStateError,
    );
    await log.markSigned(row.scope, row.id, new Uint8Array(64));
    expect(log.isPending(row.message, row.attesterKeyId)).toBe(false);
    await expect(log.markFailed(row.scope, row.id, 'X')).rejects.toThrow(AttestationStateError);
    await expect(log.markSigned(row.scope, row.id, new Uint8Array(64))).rejects.toThrow(
      AttestationStateError,
    );
    expect(log.rows(row.scope)).toMatchObject([{ status: 'signed' }]);
    expect(log.rows(newScope())).toEqual([]);
  });

  it('a failed row stays failed', async () => {
    const log = new InMemoryAttestationLog();
    const row = pendingRow();
    await log.insertPending(row);
    await log.markFailed(row.scope, row.id, 'SIGNER_DENIED');
    await expect(log.markSigned(row.scope, row.id, new Uint8Array(64))).rejects.toThrow(
      AttestationStateError,
    );
    expect(log.rows(row.scope)).toMatchObject([{ status: 'failed', failureCode: 'SIGNER_DENIED' }]);
  });
});

describe('InMemoryPayoutLegs', () => {
  it('returns a leg to its own tenant only', async () => {
    const scope = newScope();
    const method = methodRow(scope, newId());
    const leg = legRow(mandateRow(scope), method, { legIndex: 3 });
    const legs = new InMemoryPayoutLegs().put(leg);
    expect(await legs.leg(scope, leg.attemptId, 3)).toBe(leg);
    expect(await legs.leg(scope, leg.attemptId, 0)).toBeNull();
    expect(await legs.leg(newScope(), leg.attemptId, 3)).toBeNull();
  });
});
