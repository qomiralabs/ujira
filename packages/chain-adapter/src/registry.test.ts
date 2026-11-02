// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the adapter registry (registry.ts).
 *
 * createChainAdapterRegistry({ adapters, config }) holds one adapter per
 * network. `config` returns the current validated NetworksConfig snapshot
 * and is read on every call, so a config swap enables or disables a network
 * without a restart.
 *
 * get(network) returns the adapter when the network has an adapter, a
 * config entry and enabled: true; otherwise it throws UnsupportedError
 * carrying the network. list() returns the enabled adapters in NETWORK_IDS
 * order, as a frozen array.
 *
 * Construction throws InvalidInputError for two adapters on one network, an
 * unknown network, an interface version other than
 * CHAIN_ADAPTER_INTERFACE_VERSION, or a chain that does not match the
 * network family.
 */

import { describe, expect, it } from 'vitest';

import {
  CHAIN_ADAPTER_INTERFACE_VERSION,
  InvalidInputError,
  UnsupportedError,
  createChainAdapterRegistry,
} from './index.js';
import type { ChainAdapter, NetworkId, NetworksConfig } from './index.js';

function unsupported(): never {
  throw new UnsupportedError();
}

function fakeAdapter(network: NetworkId, overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  return {
    interfaceVersion: CHAIN_ADAPTER_INTERFACE_VERSION,
    network,
    chain: 'stellar',
    capabilities: unsupported,
    health: unsupported,
    parseAddress: unsupported,
    parseDestination: unsupported,
    attestationMessage: unsupported,
    readMandate: unsupported,
    prepareMandateAction: unsupported,
    submitSigned: unsupported,
    fundingInstructions: unsupported,
    prepareFunding: unsupported,
    scanDeposits: unsupported,
    quote: unsupported,
    pay: unsupported,
    payBatch: unsupported,
    status: unsupported,
    proveDead: unsupported,
    receipt: unsupported,
    verifyReceipt: unsupported,
    ...overrides,
  };
}

// The registry only reads `enabled`, so the rest of each entry is not built.
function configWith(enabled: Partial<Record<NetworkId, boolean>>): NetworksConfig {
  const config: Record<string, { enabled: boolean }> = {};
  for (const [network, on] of Object.entries(enabled)) config[network] = { enabled: on };
  return config;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('createChainAdapterRegistry', () => {
  const pubnet = fakeAdapter('stellar:pubnet');
  const testnet = fakeAdapter('stellar:testnet');

  it('returns the adapter for an enabled network', () => {
    const registry = createChainAdapterRegistry({
      adapters: [testnet, pubnet],
      config: () => configWith({ 'stellar:pubnet': true, 'stellar:testnet': true }),
    });
    expect(registry.get('stellar:pubnet')).toBe(pubnet);
    expect(registry.get('stellar:testnet')).toBe(testnet);
  });

  it('lists enabled adapters in network order, frozen', () => {
    const registry = createChainAdapterRegistry({
      adapters: [testnet, pubnet],
      config: () => configWith({ 'stellar:pubnet': true, 'stellar:testnet': true }),
    });
    const list = registry.list();
    expect(list).toEqual([pubnet, testnet]);
    expect(Object.isFrozen(list)).toBe(true);
    const some = createChainAdapterRegistry({
      adapters: [testnet, pubnet],
      config: () => configWith({ 'stellar:pubnet': false, 'stellar:testnet': true }),
    });
    expect(some.list()).toEqual([testnet]);
  });

  it.each([
    ['disabled', configWith({ 'stellar:pubnet': false })],
    ['missing from config', configWith({ 'stellar:testnet': true })],
  ])('refuses a network that is %s', (_label, config) => {
    const registry = createChainAdapterRegistry({
      adapters: [pubnet, testnet],
      config: () => config,
    });
    const err = thrown(() => registry.get('stellar:pubnet'));
    expect(err).toBeInstanceOf(UnsupportedError);
    expect((err as UnsupportedError).network).toBe('stellar:pubnet');
  });

  it('refuses an enabled network with no adapter, and an unknown network', () => {
    const registry = createChainAdapterRegistry({
      adapters: [pubnet],
      config: () => configWith({ 'stellar:pubnet': true, 'stellar:testnet': true }),
    });
    expect(thrown(() => registry.get('stellar:testnet'))).toBeInstanceOf(UnsupportedError);
    expect(thrown(() => registry.get('stellar:futurenet' as NetworkId))).toBeInstanceOf(
      UnsupportedError,
    );
    expect(registry.list()).toEqual([pubnet]);
  });

  it('reads the config on every call, so a swap takes effect at once', () => {
    let on = true;
    const registry = createChainAdapterRegistry({
      adapters: [pubnet],
      config: () => configWith({ 'stellar:pubnet': on }),
    });
    expect(registry.get('stellar:pubnet')).toBe(pubnet);
    on = false;
    expect(thrown(() => registry.get('stellar:pubnet'))).toBeInstanceOf(UnsupportedError);
    expect(registry.list()).toEqual([]);
  });

  it.each([
    ['two adapters on one network', [pubnet, fakeAdapter('stellar:pubnet')]],
    ['an unknown network', [fakeAdapter('stellar:futurenet' as NetworkId)]],
    [
      'another interface version',
      [fakeAdapter('stellar:pubnet', { interfaceVersion: 2 as never })],
    ],
    // Only one chain exists, so a mismatch is forged; the check still guards
    // an adapter wired to the wrong network once a second chain is added.
    ['a chain that does not match', [fakeAdapter('stellar:pubnet', { chain: 'other' as never })]],
  ])('refuses %s', (_label, adapters) => {
    const err = thrown(() =>
      createChainAdapterRegistry({ adapters, config: () => configWith({}) }),
    );
    expect(err).toBeInstanceOf(InvalidInputError);
  });
});
