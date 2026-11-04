// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import type { RpcLedgerEntry } from './rpc.js';
import { ledgerEntryState } from './soroban-rules.js';

const ENTRY: RpcLedgerEntry = { key: 'k', xdr: 'x', lastModifiedLedgerSeq: 1 };

describe('reading an archived entry', () => {
  it('liveUntilLedgerSeq 0 is present and archived', () => {
    const archived = { ...ENTRY, liveUntilLedgerSeq: 0 };
    expect(ledgerEntryState(archived)).toEqual({ state: 'archived', entry: archived });
  });

  it('reads an entry with a live-until ledger, or none at all, as live', () => {
    const live = { ...ENTRY, liveUntilLedgerSeq: 100 };
    expect(ledgerEntryState(live)).toEqual({ state: 'live', entry: live });
    // Entries that do not expire, such as accounts, carry no such field.
    expect(ledgerEntryState(ENTRY)).toEqual({ state: 'live', entry: ENTRY });
  });

  it('calls only a missing entry absent', () => {
    expect(ledgerEntryState(undefined)).toEqual({ state: 'absent' });
  });
});
