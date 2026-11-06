// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { logMandateAlertSink } from './alerts.js';

describe('the log sink', () => {
  it('writes one error line naming the alert, the contract and the reason, and nothing else', async () => {
    const lines: Record<string, unknown>[] = [];
    const sink = logMandateAlertSink((line) => lines.push(line));
    await sink.mandateFlagged(
      {
        alertId: 7n,
        network: 'stellar:testnet',
        contractId: 'CCONTRACT',
        reason: 'tenant_tag_mismatch',
        raisedAt: new Date('2026-11-06T10:00:00Z'),
      },
      { signal: new AbortController().signal, idempotencyKey: 'mandate-alert:7' },
    );
    expect(lines).toEqual([
      {
        time: expect.any(String) as unknown,
        level: 'error',
        event: 'mandate_flagged',
        alertId: '7',
        network: 'stellar:testnet',
        contractId: 'CCONTRACT',
        reason: 'tenant_tag_mismatch',
        raisedAt: '2026-11-06T10:00:00.000Z',
      },
    ]);
  });
});
