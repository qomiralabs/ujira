// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The service over a stand-in flow, with the store holding what the tables hold.
// The real flow has its own tests in the chain adapter, compiled against the same
// interface, and the real SQL has its own in the database package.

import { randomUUID } from 'node:crypto';

import type {
  FundingAccountFlow,
  FundingAccountRecord,
  NetworkId,
  SigningRequest,
  TenantScope,
} from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import * as index from './index.js';
import {
  FundingAccountConflictError,
  FundingAccountStateError,
  FundingInputError,
} from './errors.js';
import { createFundingAccountService } from './funding-account.js';
import type { FundingAccountService } from './funding-account.js';
import { MemoryFundingAccounts } from './memory.js';

const NETWORK: NetworkId = 'stellar:testnet';
const OPTS = { correlationId: 'test' };
const MANDATE = 'CMANDATE';
const SPONSOR_TX = 'ab'.repeat(32);

function tenant(): TenantScope {
  return { principalId: randomUUID(), projectId: randomUUID() } as TenantScope;
}

function otherProject(scope: TenantScope): TenantScope {
  return { principalId: scope.principalId, projectId: randomUUID() } as TenantScope;
}

interface World {
  readonly store: MemoryFundingAccounts;
  readonly service: FundingAccountService;
  readonly calls: string[];
}

function world(): World {
  const store = new MemoryFundingAccounts();
  const calls: string[] = [];
  const ownOf = async (scope: TenantScope): Promise<FundingAccountRecord | null> => {
    const known = await store.forPrincipal(scope, NETWORK);
    return known?.projectId === scope.projectId ? known : null;
  };
  const flow: FundingAccountFlow = {
    prepare: (req) => {
      calls.push(`prepare ${req.publicKey} ${String(req.businessVerified)}`);
      return Promise.resolve({ requestId: 'r1', kind: 'stellar_transaction' } as SigningRequest);
    },
    submit: (req) => {
      calls.push(`submit ${req.requestId} ${req.signed} ${req.correlationId}`);
      return Promise.resolve({ network: NETWORK, txHash: SPONSOR_TX, finality: 'none' });
    },
    confirm: async (req) => {
      const known = await store.forPrincipal(req.scope, NETWORK);
      if (known !== null) return known;
      const row: FundingAccountRecord = {
        principalId: req.scope.principalId,
        projectId: req.scope.projectId,
        network: NETWORK,
        address: 'GFORWARDER',
        sponsor: 'GSPONSOR',
        sponsorTxHash: SPONSOR_TX,
        status: 'active',
        faults: [],
      };
      await store.record(row);
      return row;
    },
    recheck: ownOf,
    account: ownOf,
    fundingOptions: async ({ scope, mandate }) => {
      const own = await ownOf(scope);
      return {
        exchangeDeposit: own?.status === 'active' ? { network: NETWORK, value: own.address } : null,
        walletFunding: { address: { network: NETWORK, value: mandate }, label: 'wallet' },
      };
    },
  };
  const offered = new Map<NetworkId, FundingAccountFlow>([[NETWORK, flow]]);
  return {
    store,
    calls,
    service: createFundingAccountService({
      flowFor: (network) => offered.get(network) ?? null,
      sources: store,
    }),
  };
}

function rejected(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );
}

describe('funding-account.test.ts', () => {
  it('passes the wallet public key to the flow and asks for nothing else', async () => {
    const w = world();
    const request = await w.service.start(
      { scope: tenant(), network: NETWORK, publicKey: 'GWALLET', businessVerified: false },
      OPTS,
    );
    expect(request.requestId).toBe('r1');
    expect(w.calls).toEqual(['prepare GWALLET false']);
  });

  it('refuses a secret sent alongside the key, and does not repeat it in the error', async () => {
    const w = world();
    const secret = 'SBSECRETSECRETSECRET';
    const error = await rejected(
      w.service.start(
        {
          scope: tenant(),
          network: NETWORK,
          publicKey: 'GWALLET',
          businessVerified: true,
          secret,
        } as never,
        OPTS,
      ),
    );
    expect(error).toBeInstanceOf(FundingInputError);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
    expect(w.calls).toEqual([]);
  });

  it('sends on what the wallet signed', async () => {
    const w = world();
    const ref = await w.service.submit(
      {
        scope: tenant(),
        network: NETWORK,
        requestId: 'r1',
        signed: 'SIGNED',
        correlationId: 'c1',
      },
      OPTS,
    );
    expect(ref.txHash).toBe(SPONSOR_TX);
    expect(w.calls).toEqual(['submit r1 SIGNED c1']);
  });

  it('records a good account as the instance funding source', async () => {
    const w = world();
    const scope = tenant();
    const instance = randomUUID();
    w.store.addInstance(scope, instance);
    const done = await w.service.confirm(
      { scope, network: NETWORK, requestId: 'r1', mandateInstanceId: instance },
      OPTS,
    );
    expect(done.account).toMatchObject({
      principalId: scope.principalId,
      projectId: scope.projectId,
      status: 'active',
    });
    expect(done.fundingSourceId).not.toBeNull();
    expect(w.store.sources()).toEqual([done.fundingSourceId]);
  });

  it('makes one source however often a confirmation is repeated', async () => {
    const w = world();
    const scope = tenant();
    const instance = randomUUID();
    w.store.addInstance(scope, instance);
    const req = { scope, network: NETWORK, requestId: 'r1', mandateInstanceId: instance };
    const first = await w.service.confirm(req, OPTS);
    const second = await w.service.confirm(req, OPTS);
    expect(second.fundingSourceId).toBe(first.fundingSourceId);
    expect(w.store.sources()).toHaveLength(1);
  });

  it('heals on retry when a crash falls between the chain step and the source', async () => {
    const w = world();
    const scope = tenant();
    const instance = randomUUID();
    w.store.addInstance(scope, instance);
    const req = { scope, network: NETWORK, requestId: 'r1', mandateInstanceId: instance };
    const crash = new Error('connection lost');
    w.store.failNextAttach = crash;
    expect(await rejected(w.service.confirm(req, OPTS))).toBe(crash);
    expect(w.store.sources()).toEqual([]);
    const done = await w.service.confirm(req, OPTS);
    expect(w.store.sources()).toEqual([done.fundingSourceId]);
  });

  it('never makes a source from a rejected account', async () => {
    const w = world();
    const scope = tenant();
    const instance = randomUUID();
    w.store.addInstance(scope, instance);
    await w.store.record({
      principalId: scope.principalId,
      projectId: scope.projectId,
      network: NETWORK,
      address: 'GBAD',
      sponsor: 'GSPONSOR',
      sponsorTxHash: SPONSOR_TX,
      status: 'rejected',
      faults: ['extra_signer'],
    });
    const done = await w.service.confirm(
      { scope, network: NETWORK, requestId: 'r1', mandateInstanceId: instance },
      OPTS,
    );
    expect(done.account.status).toBe('rejected');
    expect(done.fundingSourceId).toBeNull();
    expect(w.store.sources()).toEqual([]);
    await expect(
      w.service.attach({ scope, network: NETWORK, mandateInstanceId: instance }),
    ).rejects.toBeInstanceOf(FundingAccountStateError);
  });

  it("makes no source in one project from another project's account", async () => {
    const w = world();
    const scope = tenant();
    const elsewhere = otherProject(scope);
    const theirs = randomUUID();
    const ours = randomUUID();
    w.store.addInstance(scope, ours);
    w.store.addInstance(elsewhere, theirs);
    await w.service.confirm(
      { scope: elsewhere, network: NETWORK, requestId: 'r1', mandateInstanceId: theirs },
      OPTS,
    );
    const done = await w.service.confirm(
      { scope, network: NETWORK, requestId: 'r2', mandateInstanceId: ours },
      OPTS,
    );
    expect(done.account.projectId).toBe(elsewhere.projectId);
    expect(done.fundingSourceId).toBeNull();
    await expect(
      w.service.attach({ scope, network: NETWORK, mandateInstanceId: ours }),
    ).rejects.toBeInstanceOf(FundingAccountStateError);
    expect(w.store.sources()).toHaveLength(1);
  });

  it('points a second mandate instance at the account the project has', async () => {
    const w = world();
    const scope = tenant();
    const one = randomUUID();
    const two = randomUUID();
    w.store.addInstance(scope, one);
    w.store.addInstance(scope, two);
    const done = await w.service.confirm(
      { scope, network: NETWORK, requestId: 'r1', mandateInstanceId: one },
      OPTS,
    );
    const source = await w.service.attach({ scope, network: NETWORK, mandateInstanceId: two });
    expect(source).not.toBe(done.fundingSourceId);
    expect(w.store.sources()).toHaveLength(2);
    expect(await w.service.attach({ scope, network: NETWORK, mandateInstanceId: two })).toBe(
      source,
    );
  });

  it('refuses to attach with no account', async () => {
    const w = world();
    const scope = tenant();
    const instance = randomUUID();
    w.store.addInstance(scope, instance);
    await expect(
      w.service.attach({ scope, network: NETWORK, mandateInstanceId: instance }),
    ).rejects.toBeInstanceOf(FundingAccountStateError);
  });

  it("cannot reach another tenant's mandate instance", async () => {
    const w = world();
    const scope = tenant();
    const stranger = tenant();
    const theirs = randomUUID();
    w.store.addInstance(stranger, theirs);
    await expect(
      w.service.confirm(
        { scope, network: NETWORK, requestId: 'r1', mandateInstanceId: theirs },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(FundingAccountStateError);
    expect(w.store.sources()).toEqual([]);
  });

  it('does not show one tenant the account of another', async () => {
    const w = world();
    const scope = tenant();
    const stranger = tenant();
    const instance = randomUUID();
    w.store.addInstance(scope, instance);
    await w.service.confirm(
      { scope, network: NETWORK, requestId: 'r1', mandateInstanceId: instance },
      OPTS,
    );
    const mine = await w.service.options({ scope, network: NETWORK, mandate: MANDATE });
    expect(mine.exchangeDeposit?.value).toBe('GFORWARDER');
    const theirs = await w.service.options({ scope: stranger, network: NETWORK, mandate: MANDATE });
    expect(theirs.exchangeDeposit).toBeNull();
  });

  it('never offers the mandate as the exchange address', async () => {
    const w = world();
    const view = await w.service.options({ scope: tenant(), network: NETWORK, mandate: MANDATE });
    expect(view.exchangeDeposit).toBeNull();
    expect(view.walletFunding.address.value).toBe(MANDATE);
  });

  it('holds two tenants off one address', async () => {
    const w = world();
    const scope = tenant();
    const stranger = tenant();
    const one = randomUUID();
    const two = randomUUID();
    w.store.addInstance(scope, one);
    w.store.addInstance(stranger, two);
    await w.service.confirm(
      { scope, network: NETWORK, requestId: 'r1', mandateInstanceId: one },
      OPTS,
    );
    await expect(
      w.service.confirm(
        { scope: stranger, network: NETWORK, requestId: 'r2', mandateInstanceId: two },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(FundingAccountConflictError);
  });

  it('holds a principal to the account it has', async () => {
    const store = new MemoryFundingAccounts();
    const scope = tenant();
    const row: FundingAccountRecord = {
      principalId: scope.principalId,
      projectId: scope.projectId,
      network: NETWORK,
      address: 'GFIRST',
      sponsor: 'GSPONSOR',
      sponsorTxHash: SPONSOR_TX,
      status: 'active',
      faults: [],
    };
    await store.record(row);
    await store.record(row);
    await expect(store.record({ ...row, address: 'GSECOND' })).rejects.toBeInstanceOf(
      FundingAccountConflictError,
    );
  });

  it('says so for a network where funding accounts are not offered', async () => {
    const w = world();
    const error = await rejected(
      w.service.options({ scope: tenant(), network: 'stellar:pubnet', mandate: MANDATE }),
    );
    expect(error).toBeInstanceOf(FundingInputError);
    expect((error as FundingInputError).issues).toEqual(['request.network (not_offered)']);
  });

  it.each([
    [
      'a scope that is not a tenant',
      (s: FundingAccountService) =>
        s.options({
          scope: { principalId: 'x', projectId: 'y' } as unknown as TenantScope,
          network: NETWORK,
          mandate: MANDATE,
        }),
    ],
    [
      'an unknown network',
      (s: FundingAccountService) =>
        s.options({ scope: tenant(), network: 'nope' as NetworkId, mandate: MANDATE }),
    ],
    [
      'an empty mandate',
      (s: FundingAccountService) => s.options({ scope: tenant(), network: NETWORK, mandate: '' }),
    ],
    [
      'an instance that is no uuid',
      (s: FundingAccountService) =>
        s.attach({ scope: tenant(), network: NETWORK, mandateInstanceId: 'x' }),
    ],
    [
      'an empty signed payload',
      (s: FundingAccountService) =>
        s.submit(
          {
            scope: tenant(),
            network: NETWORK,
            requestId: 'r1',
            signed: '',
            correlationId: 'c1',
          },
          OPTS,
        ),
    ],
    [
      'a confirmation with no request',
      (s: FundingAccountService) =>
        s.confirm(
          { scope: tenant(), network: NETWORK, requestId: '', mandateInstanceId: randomUUID() },
          OPTS,
        ),
    ],
  ])('refuses %s', async (_name, call) => {
    await expect(call(world().service)).rejects.toBeInstanceOf(FundingInputError);
  });

  it('exports the service and its errors', () => {
    expect(index.createFundingAccountService).toBe(createFundingAccountService);
    expect(index.FUNDING_ERROR_CODES).toContain('FUNDING_ACCOUNT_STATE');
    expect(index.FUNDING_ERROR_CODES).toContain('FUNDING_ACCOUNT_CONFLICT');
    expect(new FundingAccountConflictError().code).toBe('FUNDING_ACCOUNT_CONFLICT');
    expect(new FundingAccountStateError().code).toBe('FUNDING_ACCOUNT_STATE');
  });
});
