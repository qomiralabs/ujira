// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The watch over a stand-in flow. The reading of an account, and what counts as a
// change, is tested over the real flow in the chain adapter.

import { randomUUID } from 'node:crypto';

import type {
  FundingAccountFlow,
  FundingAccountRecord,
  NetworkId,
  TenantScope,
} from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import {
  FUNDING_ACCOUNT_WATCH_INTERVAL_SECONDS,
  createFundingAccountWatch,
} from './account-watch.js';
import { FundingInputError } from './errors.js';

const NETWORK: NetworkId = 'stellar:testnet';
const OPTS = { correlationId: 'test' };
const FORWARDER = 'GFORWARDER';
const scope = { principalId: randomUUID(), projectId: randomUUID() } as TenantScope;
const ABORT = new AbortController().signal;

const ACTIVE: FundingAccountRecord = {
  principalId: scope.principalId,
  projectId: scope.projectId,
  network: NETWORK,
  address: FORWARDER,
  sponsor: 'GSPONSOR',
  sponsorTxHash: 'ab'.repeat(32),
  status: 'active',
  faults: [],
};

function watchOver(found: FundingAccountRecord | null) {
  const reads: unknown[] = [];
  const flow = {
    recheck: (asked: TenantScope, opts: unknown) => {
      reads.push({ asked, opts });
      return Promise.resolve(found);
    },
  } as unknown as FundingAccountFlow;
  const flows = new Map([[NETWORK, flow]]);
  return {
    reads,
    watch: createFundingAccountWatch({ flowFor: (network) => flows.get(network) ?? null }),
  };
}

const asked = { scope, network: NETWORK, forwarder: FORWARDER };

describe('account-watch.test.ts', () => {
  it('reads again often enough to catch a change before most later deposits', () => {
    expect(FUNDING_ACCOUNT_WATCH_INTERVAL_SECONDS).toBe(900);
  });

  it('reads the account of the tenant it was given', async () => {
    const { watch, reads } = watchOver(ACTIVE);
    expect(await watch.check(scope, NETWORK, OPTS)).toBe(ACTIVE);
    expect(reads).toEqual([{ asked: scope, opts: OPTS }]);
  });

  it('says so for a network where funding accounts are not offered', async () => {
    const { watch } = watchOver(ACTIVE);
    await expect(watch.check(scope, 'stellar:pubnet', OPTS)).rejects.toBeInstanceOf(
      FundingInputError,
    );
  });

  it('calls an active account at this address usable, after reading it now', async () => {
    const { watch, reads } = watchOver(ACTIVE);
    expect(await watch.accounts.usable(asked, ABORT)).toBe(true);
    expect(reads).toHaveLength(1);
  });

  it.each([
    ['changed', { ...ACTIVE, status: 'changed', faults: ['extra_signer'] }],
    ['rejected', { ...ACTIVE, status: 'rejected', faults: ['extra_signer'] }],
    ['at another address', { ...ACTIVE, address: 'GOTHER' }],
    ['not there', null],
  ] as const)('does not call an account %s usable', async (_name, found) => {
    const { watch } = watchOver(found);
    expect(await watch.accounts.usable(asked, ABORT)).toBe(false);
  });
});
