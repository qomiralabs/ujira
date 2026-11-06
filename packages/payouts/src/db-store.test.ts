// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which session the method source reads under, and how a stored method becomes the
// destination a payout leg is sent to. The repository is stood in for here, because
// the database test harness belongs to the database package; what it may answer for
// is tested there against a real server.

import { randomUUID } from 'node:crypto';

import type { CallOptions, TenantScope } from '@ujira/chain-adapter';
import type { Database } from '@ujira/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbPayoutMethodSource } from './db-store.js';

const repo = vi.hoisted(() => ({ payable: vi.fn() }));

vi.mock('@ujira/db', () => ({ payoutMethods: { payable: repo.payable } }));

const NETWORK = 'stellar:testnet' as const;
const OPTS: CallOptions = { correlationId: 'method-source' };
const ACCOUNT = 'GA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQHES5';
// ACCOUNT with id 123456.
const MUXED = 'MA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAAAAAAAAAPCICBKU';

const scope = { principalId: randomUUID(), projectId: randomUUID() } as TenantScope;

function database() {
  const opened: unknown[] = [];
  const db = {
    tenant: (context: unknown) => ({
      transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        opened.push(context);
        return work('tx');
      },
    }),
  } as unknown as Pick<Database, 'tenant'>;
  return { db, opened };
}

beforeEach(() => {
  repo.payable.mockReset();
});

describe('the payout method source', () => {
  it("reads under the paying tenant's own session, for the network's chain", async () => {
    const { db, opened } = database();
    const id = randomUUID();
    repo.payable.mockResolvedValue({ destinationAddress: ACCOUNT, destinationTag: null });
    expect(await createDbPayoutMethodSource(db, NETWORK).destination(scope, id, OPTS)).toEqual({
      address: { network: NETWORK, value: ACCOUNT },
      tag: null,
    });
    expect(opened).toEqual([scope]);
    expect(repo.payable).toHaveBeenCalledWith('tx', id, 'stellar');
  });

  it('carries the tag stored beside an account', async () => {
    const { db } = database();
    repo.payable.mockResolvedValue({ destinationAddress: ACCOUNT, destinationTag: 7n });
    expect(
      await createDbPayoutMethodSource(db, NETWORK).destination(scope, randomUUID(), OPTS),
    ).toEqual({ address: { network: NETWORK, value: ACCOUNT }, tag: 7n });
  });

  // Onboarding stores the M address, with its id inside, and the same id as the tag.
  it('reads an M address as the account it pays and its id', async () => {
    const { db } = database();
    repo.payable.mockResolvedValue({ destinationAddress: MUXED, destinationTag: 123456n });
    expect(
      await createDbPayoutMethodSource(db, NETWORK).destination(scope, randomUUID(), OPTS),
    ).toEqual({ address: { network: NETWORK, value: ACCOUNT }, tag: 123456n });
  });

  // Paying either would be a guess about where the money was meant to go.
  it('answers nothing for a stored address and tag that disagree', async () => {
    const { db } = database();
    repo.payable.mockResolvedValue({ destinationAddress: MUXED, destinationTag: 7n });
    expect(
      await createDbPayoutMethodSource(db, NETWORK).destination(scope, randomUUID(), OPTS),
    ).toBeNull();
  });

  it('answers nothing for an address that does not read', async () => {
    const { db } = database();
    repo.payable.mockResolvedValue({ destinationAddress: 'Gnot-an-account', destinationTag: null });
    expect(
      await createDbPayoutMethodSource(db, NETWORK).destination(scope, randomUUID(), OPTS),
    ).toBeNull();
  });

  it('answers nothing where the repository has nothing, or for an id that is no uuid', async () => {
    const { db, opened } = database();
    repo.payable.mockResolvedValue(undefined);
    const source = createDbPayoutMethodSource(db, NETWORK);
    expect(await source.destination(scope, randomUUID(), OPTS)).toBeNull();
    expect(await source.destination(scope, 'not-a-uuid', OPTS)).toBeNull();
    expect(opened).toHaveLength(1);
  });
});
