// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What each answer from the database means for a deposit. The SQL and its isolation
// are tested against a real server in the database package.

import { randomUUID } from 'node:crypto';

import type { ChainAddress } from '@ujira/chain-adapter';
import type { Database } from '@ujira/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbWatchedAddresses, type UnroutableAddress } from './watched.js';

const repo = vi.hoisted(() => ({
  resolveMandateInstance: vi.fn(),
  resolveFundingAddress: vi.fn(),
}));

vi.mock('@ujira/db', () => ({ entryPoints: repo }));

const NETWORK = 'stellar:testnet' as const;
const ADDRESS = 'GFORWARDER';
const CONTRACT = 'CMANDATE';
const principalId = randomUUID();
const projectId = randomUUID();
const scope = { principalId, projectId };
const asked: ChainAddress = { network: NETWORK, value: ADDRESS };
const instance = {
  fundingSourceId: randomUUID(),
  mandateInstanceId: randomUUID(),
  contractAddress: CONTRACT,
  asset: 'USDC',
};

function world() {
  const roles: unknown[] = [];
  const tx = { marker: 'tx' };
  const db = {
    unscoped: (work: (t: unknown) => Promise<unknown>, role?: string) => {
      roles.push(role);
      return work(tx);
    },
  } as unknown as Pick<Database, 'unscoped'>;
  const refused: UnroutableAddress[] = [];
  const isWatched = dbWatchedAddresses({
    db,
    network: NETWORK,
    onUnroutable: (event) => refused.push(event),
  });
  return { isWatched, refused, roles, tx };
}

const account = (status: string, instances: readonly (typeof instance)[]) => ({
  principalId,
  projectId,
  fundingAccountId: randomUUID(),
  status,
  instances,
});

beforeEach(() => {
  repo.resolveMandateInstance.mockReset().mockResolvedValue(undefined);
  repo.resolveFundingAddress.mockReset().mockResolvedValue(undefined);
});

describe('a mandate address', () => {
  it('is watched as itself, with no forwarding route and as the indexer', async () => {
    const w = world();
    repo.resolveMandateInstance.mockResolvedValue({
      principalId,
      projectId,
      mandateInstanceId: randomUUID(),
      asset: 'USDC',
      scale: 7,
    });
    const asMandate = { network: NETWORK, value: CONTRACT };
    expect(await w.isWatched(asMandate)).toEqual({
      scope,
      mandate: { network: NETWORK, address: asMandate, specVersion: 1 },
      asset: 'USDC',
    });
    expect(repo.resolveMandateInstance).toHaveBeenCalledWith(w.tx, 'stellar', CONTRACT);
    expect(repo.resolveFundingAddress).not.toHaveBeenCalled();
    expect(w.roles).toEqual(['worker']);
  });

  it('is refused and reported in an asset that is no token', async () => {
    const w = world();
    repo.resolveMandateInstance.mockResolvedValue({
      principalId,
      projectId,
      mandateInstanceId: randomUUID(),
      asset: 'NOPE',
      scale: 7,
    });
    expect(await w.isWatched({ network: NETWORK, value: CONTRACT })).toBeNull();
    expect(w.refused).toEqual([{ network: NETWORK, address: CONTRACT, reason: 'unknown_asset' }]);
  });
});

describe('a forwarding account', () => {
  it('with one mandate is watched, with the route a sweep takes', async () => {
    const w = world();
    repo.resolveFundingAddress.mockResolvedValue(account('active', [instance]));
    expect(await w.isWatched(asked)).toEqual({
      scope,
      mandate: { network: NETWORK, address: { network: NETWORK, value: CONTRACT }, specVersion: 1 },
      asset: 'USDC',
      forwarding: {
        fundingSourceId: instance.fundingSourceId,
        mandateInstanceId: instance.mandateInstanceId,
        forwarder: ADDRESS,
        mandate: CONTRACT,
      },
    });
    expect(repo.resolveFundingAddress).toHaveBeenCalledWith(w.tx, NETWORK, ADDRESS);
    expect(w.roles).toEqual(['worker', 'worker']);
    expect(w.refused).toEqual([]);
  });

  it.each([
    ['rejected', 'account_rejected', () => account('rejected', [instance])],
    ['with no mandate', 'no_mandate', () => account('active', [])],
    ['with several mandates', 'several_mandates', () => account('active', [instance, instance])],
    [
      'in an asset that is no token',
      'unknown_asset',
      () => account('active', [{ ...instance, asset: 'NOPE' }]),
    ],
  ])('%s matches nothing, and is reported', async (_label, reason, answer) => {
    const w = world();
    repo.resolveFundingAddress.mockResolvedValue(answer());
    expect(await w.isWatched(asked)).toBeNull();
    expect(w.refused).toEqual([{ network: NETWORK, address: ADDRESS, reason }]);
  });
});

describe('any other address', () => {
  it('is simply not ours, with nothing to report', async () => {
    const w = world();
    expect(await w.isWatched(asked)).toBeNull();
    expect(w.refused).toEqual([]);
  });

  it('on another network is not looked up at all', async () => {
    const w = world();
    expect(await w.isWatched({ network: 'stellar:pubnet', value: ADDRESS })).toBeNull();
    expect(repo.resolveMandateInstance).not.toHaveBeenCalled();
    expect(repo.resolveFundingAddress).not.toHaveBeenCalled();
  });
});
