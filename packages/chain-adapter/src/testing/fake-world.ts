// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Everything a test needs to run the fake adapter, wired together: the
// network, the in-memory store with the network's executor pool, the
// signer with its test keys, sponsorship and alerts. Services above the
// adapter build one of these per test, and the conformance harness wraps
// one for the shared suite.

import type { NetworkId } from '../networks.js';
import type { ChainAddress, Destination, SigningRequest, TenantScope, Uuid } from '../types.js';

import { checkAddress } from './address.js';
import type { AdapterHarness, ChainFaults } from './conformance.js';
import { sep53Hash } from '../stellar/sep53.js';

import { ed25519Sign } from './bytes.js';
import { FakeChainAdapter, signFakeRequest } from './fake-adapter.js';
import { FakeNetwork } from './fake-network.js';
import type { FakeNetworkOptions } from './fake-network.js';
import { FakeAlerts, FakeSigner, FakeSponsorship } from './fake-ports.js';
import { FakeAdapterStore } from './fake-store.js';
import { MemoryPayoutMethods } from './payout-methods.js';
import type { StoreRule } from './fake-store.js';

export interface FakeWorldOptions extends FakeNetworkOptions {
  /** Test only: store rules to stop enforcing. */
  readonly unsafeDisable?: readonly StoreRule[];
}

export interface FakeWorld {
  readonly net: FakeNetwork;
  readonly store: FakeAdapterStore;
  readonly signer: FakeSigner;
  readonly sponsorship: FakeSponsorship;
  readonly alerts: FakeAlerts;
  /** The recipients' payout methods, which the adapter reads each leg's destination from. */
  readonly methods: MemoryPayoutMethods;
  readonly adapter: FakeChainAdapter;
  /** A new adapter on the same network and ports, as after a process restart. */
  restart(): FakeChainAdapter;
}

const SCOPE: TenantScope = {
  principalId: '00000000-0000-4000-8000-000000000001' as Uuid,
  projectId: '00000000-0000-4000-8000-000000000002' as Uuid,
};
const OTHER_SCOPE: TenantScope = {
  principalId: '00000000-0000-4000-8000-000000000003' as Uuid,
  projectId: '00000000-0000-4000-8000-000000000004' as Uuid,
};
const AGENT_ID = '00000000-0000-4000-8000-0000000000a1' as Uuid;

/** The tenant every fake world's harness acts for, and the one it must never reach. */
export const FAKE_SCOPES = Object.freeze({ scope: SCOPE, otherScope: OTHER_SCOPE });

export function createFakeWorld(options: FakeWorldOptions = {}): FakeWorld {
  const net = new FakeNetwork(options);
  const store = new FakeAdapterStore({
    clock: () => net.now(),
    executors: net.executors.map((e) => ({
      address: { network: net.network, value: e.address },
      keyId: e.keyId,
      sequenceOrNonce: 1n,
    })),
    unsafeDisable: options.unsafeDisable ?? [],
  });
  const signer = new FakeSigner(net.faults, () => net.now());
  for (const e of net.executors) signer.addExecutorKey(net.network, e.keyId, e.seed);
  signer.addFeeSponsorKey(net.network, net.feeSponsor.seed);
  const sponsorship = new FakeSponsorship(net.faults);
  const alerts = new FakeAlerts();
  const methods = new MemoryPayoutMethods();
  const ports = { store, signer, sponsorship, alerts, methods };
  return {
    net,
    store,
    signer,
    sponsorship,
    alerts,
    methods,
    adapter: new FakeChainAdapter(net, ports),
    restart: () => new FakeChainAdapter(net, ports),
  };
}

/** Fault controls over a fake world, in the suite's chain neutral terms. */
export function fakeChainFaults(world: FakeWorld): ChainFaults {
  const f = world.net.faults;
  return {
    timeoutAfterLanding: (count) => {
      f.timeoutAfterLanding(count);
    },
    chainDown: (on) => {
      f.chainDown(on);
    },
    rpcLag: (seconds) => {
      f.rpcLag(seconds);
    },
    signerDown: (on) => {
      f.signerDown(on);
    },
    sponsorDenied: (on) => {
      f.sponsorDenied(on);
    },
    transferFails: (destination, on) => {
      f.transferFails(destination.value, on);
    },
    anchorScript: (script) => {
      f.anchorScript(script);
    },
  };
}

/** The conformance harness over a fresh fake world. */
export function fakeAdapterHarness(options: FakeWorldOptions = {}): AdapterHarness & {
  readonly world: FakeWorld;
} {
  const world = createFakeWorld(options);
  const { net } = world;
  const network: NetworkId = net.network;
  const agent = net.account('managed-agent');
  world.signer.addManagedAgentKey(network, SCOPE, AGENT_ID, agent.seed);
  const seeds = new Map<string, Uint8Array>();
  const wallet = (name: string): ChainAddress => {
    const made = net.account(`wallet:${name}`);
    seeds.set(made.address, made.seed);
    return { network, value: made.address };
  };
  return {
    world,
    adapter: world.adapter,
    store: world.store,
    scope: SCOPE,
    otherScope: OTHER_SCOPE,
    factory: { network, value: net.factory.address },
    executors: net.executors.map((e) => ({ network, value: e.address })),
    managedAgent: {
      ref: { kind: 'managed_agent', network, scope: SCOPE, agentId: AGENT_ID },
      address: { network, value: agent.address },
    },
    wallet,
    signMessage: (who: ChainAddress, text: string) => {
      const seed = seeds.get(who.value);
      if (seed === undefined) return Promise.reject(new Error('not a harness wallet'));
      return Promise.resolve(Buffer.from(ed25519Sign(seed, sep53Hash(text))).toString('base64'));
    },
    sign: (request: SigningRequest, who: ChainAddress) => {
      const seed = seeds.get(who.value);
      if (seed === undefined) return Promise.reject(new Error('not a harness wallet'));
      return Promise.resolve(signFakeRequest(request, seed));
    },
    fund: (to, amount) => {
      net.fund(checkAddress('to', to.value), amount);
      return Promise.resolve();
    },
    balance: (of) => Promise.resolve(net.token.balance(of.value)),
    advance: (seconds) => {
      net.advance(seconds);
      return Promise.resolve();
    },
    recipientMethod: (destination: Destination) => world.methods.add(destination),
    mandateAddress: (principal, salt) => ({
      network,
      value: net.factory.mandateAddress(principal.value, salt),
    }),
    moves: () => world.store.moves,
    restart: () => world.restart(),
    faults: fakeChainFaults(world),
  };
}
