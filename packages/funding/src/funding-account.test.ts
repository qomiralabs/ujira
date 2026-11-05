// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The service over a stand-in flow for each network, with the store holding what
// the tables hold. The real flow has its own tests in the chain adapter, compiled
// against the same interface, and the real SQL has its own in the database package.

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
import type { FundingAccountService, FundingInstance } from './funding-account.js';
import { MemoryFundingAccounts } from './memory.js';

const TESTNET: NetworkId = 'stellar:testnet';
const PUBNET: NetworkId = 'stellar:pubnet';
const OPTS = { correlationId: 'test' };
const MANDATE = 'CMANDATE';
const SPONSOR_TX = 'ab'.repeat(32);

function tenant(): TenantScope {
  return { principalId: randomUUID(), projectId: randomUUID() } as TenantScope;
}

function otherProject(scope: TenantScope): TenantScope {
  return { principalId: scope.principalId, projectId: randomUUID() } as TenantScope;
}

function on(network: NetworkId | null, contractAddress = MANDATE): FundingInstance {
  return { network, contractAddress };
}

interface World {
  readonly store: MemoryFundingAccounts;
  readonly service: FundingAccountService;
  readonly calls: string[];
  /** A new instance for the tenant, on testnet unless it says otherwise. */
  instance(scope: TenantScope, instance?: FundingInstance): string;
}

// A flow writes the network it was made for, as the real one does. So an account
// on the wrong network can only appear if the service asked the wrong flow.
function flowOn(
  network: NetworkId,
  store: MemoryFundingAccounts,
  calls: string[],
): FundingAccountFlow {
  const ownOf = async (scope: TenantScope): Promise<FundingAccountRecord | null> => {
    const known = await store.forPrincipal(scope, network);
    return known?.projectId === scope.projectId ? known : null;
  };
  return {
    prepare: (req) => {
      calls.push(`prepare ${network} ${req.publicKey} ${String(req.businessVerified)}`);
      return Promise.resolve({ requestId: 'r1', kind: 'stellar_transaction' } as SigningRequest);
    },
    submit: (req) => {
      calls.push(`submit ${network} ${req.requestId} ${req.signed} ${req.correlationId}`);
      return Promise.resolve({ network, txHash: SPONSOR_TX, finality: 'none' });
    },
    confirm: async (req) => {
      const known = await store.forPrincipal(req.scope, network);
      if (known !== null) return known;
      const row: FundingAccountRecord = {
        principalId: req.scope.principalId,
        projectId: req.scope.projectId,
        network,
        address: `GFORWARDER-${network}`,
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
        exchangeDeposit: own?.status === 'active' ? { network, value: own.address } : null,
        walletFunding: { address: { network, value: mandate }, label: 'wallet' },
      };
    },
  };
}

function world(offered: readonly NetworkId[] = [TESTNET, PUBNET]): World {
  const store = new MemoryFundingAccounts();
  const calls: string[] = [];
  const flows = new Map(offered.map((network) => [network, flowOn(network, store, calls)]));
  return {
    store,
    calls,
    instance: (scope, instance = on(TESTNET)) => {
      const id = randomUUID();
      store.addInstance(scope, id, instance);
      return id;
    },
    service: createFundingAccountService({
      flowFor: (network) => flows.get(network) ?? null,
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
    const scope = tenant();
    const request = await w.service.start(
      {
        scope,
        mandateInstanceId: w.instance(scope),
        publicKey: 'GWALLET',
        businessVerified: false,
      },
      OPTS,
    );
    expect(request.requestId).toBe('r1');
    expect(w.calls).toEqual(['prepare stellar:testnet GWALLET false']);
  });

  it('refuses a secret sent alongside the key, and does not repeat it in the error', async () => {
    const w = world();
    const scope = tenant();
    const secret = 'SBSECRETSECRETSECRET';
    const error = await rejected(
      w.service.start(
        {
          scope,
          mandateInstanceId: w.instance(scope),
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
    const scope = tenant();
    const ref = await w.service.submit(
      {
        scope,
        mandateInstanceId: w.instance(scope),
        requestId: 'r1',
        signed: 'SIGNED',
        correlationId: 'c1',
      },
      OPTS,
    );
    expect(ref.txHash).toBe(SPONSOR_TX);
    expect(w.calls).toEqual(['submit stellar:testnet r1 SIGNED c1']);
  });

  it('records a good account as the instance funding source', async () => {
    const w = world();
    const scope = tenant();
    const done = await w.service.confirm(
      { scope, requestId: 'r1', mandateInstanceId: w.instance(scope) },
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
    const req = { scope, requestId: 'r1', mandateInstanceId: w.instance(scope) };
    const first = await w.service.confirm(req, OPTS);
    const second = await w.service.confirm(req, OPTS);
    expect(second.fundingSourceId).toBe(first.fundingSourceId);
    expect(w.store.sources()).toHaveLength(1);
  });

  it('heals on retry when a crash falls between the chain step and the source', async () => {
    const w = world();
    const scope = tenant();
    const req = { scope, requestId: 'r1', mandateInstanceId: w.instance(scope) };
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
    const instance = w.instance(scope);
    await w.store.record({
      principalId: scope.principalId,
      projectId: scope.projectId,
      network: TESTNET,
      address: 'GBAD',
      sponsor: 'GSPONSOR',
      sponsorTxHash: SPONSOR_TX,
      status: 'rejected',
      faults: ['extra_signer'],
    });
    const done = await w.service.confirm(
      { scope, requestId: 'r1', mandateInstanceId: instance },
      OPTS,
    );
    expect(done.account.status).toBe('rejected');
    expect(done.fundingSourceId).toBeNull();
    expect(w.store.sources()).toEqual([]);
    await expect(w.service.attach({ scope, mandateInstanceId: instance })).rejects.toBeInstanceOf(
      FundingAccountStateError,
    );
  });

  it("makes no source in one project from another project's account", async () => {
    const w = world();
    const scope = tenant();
    const elsewhere = otherProject(scope);
    const ours = w.instance(scope);
    await w.service.confirm(
      { scope: elsewhere, requestId: 'r1', mandateInstanceId: w.instance(elsewhere) },
      OPTS,
    );
    const done = await w.service.confirm({ scope, requestId: 'r2', mandateInstanceId: ours }, OPTS);
    expect(done.account.projectId).toBe(elsewhere.projectId);
    expect(done.fundingSourceId).toBeNull();
    await expect(w.service.attach({ scope, mandateInstanceId: ours })).rejects.toBeInstanceOf(
      FundingAccountStateError,
    );
    expect(w.store.sources()).toHaveLength(1);
  });

  it('points a second mandate instance at the account the project has', async () => {
    const w = world();
    const scope = tenant();
    const two = w.instance(scope);
    const done = await w.service.confirm(
      { scope, requestId: 'r1', mandateInstanceId: w.instance(scope) },
      OPTS,
    );
    const source = await w.service.attach({ scope, mandateInstanceId: two });
    expect(source).not.toBe(done.fundingSourceId);
    expect(w.store.sources()).toHaveLength(2);
    expect(await w.service.attach({ scope, mandateInstanceId: two })).toBe(source);
  });

  it('makes no new source from an account that has changed since it was verified', async () => {
    const w = world();
    const scope = tenant();
    const second = w.instance(scope);
    const { account } = await w.service.confirm(
      { scope, requestId: 'r1', mandateInstanceId: w.instance(scope) },
      OPTS,
    );
    await w.store.recordCheck({ ...account, status: 'changed', faults: ['extra_signer'] });
    await expect(w.service.attach({ scope, mandateInstanceId: second })).rejects.toBeInstanceOf(
      FundingAccountStateError,
    );
    expect(w.store.sources()).toHaveLength(1);
  });

  it('refuses to attach with no account', async () => {
    const w = world();
    const scope = tenant();
    await expect(
      w.service.attach({ scope, mandateInstanceId: w.instance(scope) }),
    ).rejects.toBeInstanceOf(FundingAccountStateError);
  });

  describe('networks', () => {
    it('attach refuses an account on another network, in both directions', async () => {
      const w = world();
      const scope = tenant();
      await w.service.confirm(
        { scope, requestId: 'r1', mandateInstanceId: w.instance(scope, on(TESTNET)) },
        OPTS,
      );
      const pubnet = w.instance(scope, on(PUBNET));
      await expect(w.service.attach({ scope, mandateInstanceId: pubnet })).rejects.toBeInstanceOf(
        FundingAccountStateError,
      );
      expect(w.store.sources()).toHaveLength(1);

      const other = world();
      const principal = tenant();
      await other.service.confirm(
        {
          scope: principal,
          requestId: 'r1',
          mandateInstanceId: other.instance(principal, on(PUBNET)),
        },
        OPTS,
      );
      await expect(
        other.service.attach({
          scope: principal,
          mandateInstanceId: other.instance(principal, on(TESTNET)),
        }),
      ).rejects.toBeInstanceOf(FundingAccountStateError);
    });

    it('the store refuses a mismatch even if a caller names the wrong network', async () => {
      const w = world();
      const scope = tenant();
      await w.service.confirm(
        { scope, requestId: 'r1', mandateInstanceId: w.instance(scope, on(TESTNET)) },
        OPTS,
      );
      const pubnet = w.instance(scope, on(PUBNET));
      expect(
        await w.store.attach(scope, { network: TESTNET, mandateInstanceId: pubnet }),
      ).toBeNull();
    });

    it("offers only an account on the mandate's network", async () => {
      const w = world();
      const scope = tenant();
      const testnet = w.instance(scope, on(TESTNET, 'CTEST'));
      await w.service.confirm({ scope, requestId: 'r1', mandateInstanceId: testnet }, OPTS);
      const onTestnet = await w.service.options({ scope, mandateInstanceId: testnet });
      expect(onTestnet.exchangeDeposit).toEqual({
        network: TESTNET,
        value: 'GFORWARDER-stellar:testnet',
      });
      expect(onTestnet.walletFunding.address).toEqual({ network: TESTNET, value: 'CTEST' });

      const pubnet = w.instance(scope, on(PUBNET, 'CREAL'));
      const onPubnet = await w.service.options({ scope, mandateInstanceId: pubnet });
      expect(onPubnet.exchangeDeposit).toBeNull();
      expect(onPubnet.walletFunding.address).toEqual({ network: PUBNET, value: 'CREAL' });
    });

    it('takes the network from the instance, so a caller cannot name one', async () => {
      const w = world();
      const scope = tenant();
      const error = await rejected(
        w.service.options({
          scope,
          mandateInstanceId: w.instance(scope),
          network: PUBNET,
        } as never),
      );
      expect(error).toBeInstanceOf(FundingInputError);
    });

    it('funds nothing from an instance whose network is not known', async () => {
      const w = world();
      const scope = tenant();
      const unknown = w.instance(scope, on(null));
      await expect(
        w.service.start(
          { scope, mandateInstanceId: unknown, publicKey: 'GWALLET', businessVerified: true },
          OPTS,
        ),
      ).rejects.toBeInstanceOf(FundingAccountStateError);
      await expect(
        w.service.submit(
          {
            scope,
            mandateInstanceId: unknown,
            requestId: 'r1',
            signed: 'SIGNED',
            correlationId: 'c1',
          },
          OPTS,
        ),
      ).rejects.toBeInstanceOf(FundingAccountStateError);
      await expect(
        w.service.confirm({ scope, requestId: 'r1', mandateInstanceId: unknown }, OPTS),
      ).rejects.toBeInstanceOf(FundingAccountStateError);
      await expect(w.service.attach({ scope, mandateInstanceId: unknown })).rejects.toBeInstanceOf(
        FundingAccountStateError,
      );
      await expect(w.service.options({ scope, mandateInstanceId: unknown })).rejects.toBeInstanceOf(
        FundingAccountStateError,
      );
      expect(w.calls).toEqual([]);
    });

    it('says so for a network where funding accounts are not offered', async () => {
      const w = world([TESTNET]);
      const scope = tenant();
      const error = await rejected(
        w.service.options({ scope, mandateInstanceId: w.instance(scope, on(PUBNET)) }),
      );
      expect(error).toBeInstanceOf(FundingInputError);
      expect((error as FundingInputError).issues).toEqual(['request.network (not_offered)']);
    });
  });

  it("cannot reach another tenant's mandate instance", async () => {
    const w = world();
    const scope = tenant();
    const theirs = w.instance(tenant());
    await expect(
      w.service.confirm({ scope, requestId: 'r1', mandateInstanceId: theirs }, OPTS),
    ).rejects.toBeInstanceOf(FundingAccountStateError);
    await expect(w.service.options({ scope, mandateInstanceId: theirs })).rejects.toBeInstanceOf(
      FundingAccountStateError,
    );
    await expect(w.service.attach({ scope, mandateInstanceId: theirs })).rejects.toBeInstanceOf(
      FundingAccountStateError,
    );
    expect(w.store.sources()).toEqual([]);
    expect(await w.store.attach(scope, { network: TESTNET, mandateInstanceId: theirs })).toBeNull();
  });

  it('does not show one tenant the account of another', async () => {
    const w = world();
    const scope = tenant();
    const stranger = tenant();
    const mine = w.instance(scope);
    await w.service.confirm({ scope, requestId: 'r1', mandateInstanceId: mine }, OPTS);
    const seen = await w.service.options({ scope, mandateInstanceId: mine });
    expect(seen.exchangeDeposit?.value).toBe('GFORWARDER-stellar:testnet');
    const theirs = await w.service.options({
      scope: stranger,
      mandateInstanceId: w.instance(stranger),
    });
    expect(theirs.exchangeDeposit).toBeNull();
  });

  it('never offers the mandate as the exchange address', async () => {
    const w = world();
    const scope = tenant();
    const view = await w.service.options({ scope, mandateInstanceId: w.instance(scope) });
    expect(view.exchangeDeposit).toBeNull();
    expect(view.walletFunding.address.value).toBe(MANDATE);
  });

  it('holds two tenants off one address', async () => {
    const w = world();
    const scope = tenant();
    const stranger = tenant();
    await w.service.confirm({ scope, requestId: 'r1', mandateInstanceId: w.instance(scope) }, OPTS);
    await expect(
      w.service.confirm(
        { scope: stranger, requestId: 'r2', mandateInstanceId: w.instance(stranger) },
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
      network: TESTNET,
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

  it.each([
    [
      'a scope that is not a tenant',
      (s: FundingAccountService) =>
        s.options({
          scope: { principalId: 'x', projectId: 'y' } as unknown as TenantScope,
          mandateInstanceId: randomUUID(),
        }),
    ],
    [
      'an instance that is no uuid',
      (s: FundingAccountService) => s.attach({ scope: tenant(), mandateInstanceId: 'x' }),
    ],
    [
      'an empty signed payload',
      (s: FundingAccountService) =>
        s.submit(
          {
            scope: tenant(),
            mandateInstanceId: randomUUID(),
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
        s.confirm({ scope: tenant(), requestId: '', mandateInstanceId: randomUUID() }, OPTS),
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
