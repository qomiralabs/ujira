// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the chain module data (chain-modules.ts), shared by the root
 * lint rule and the SDK free check.
 *
 * CHAIN_NAMESPACES lists the CAIP-2 namespaces UJIRA settles on: stellar.
 * CHAIN_SDK_PACKAGES lists chain SDK packages: '@stellar/', a whole scope.
 * matchesPackage(specifier, packages) treats an entry ending in '/' as a
 * scope and any other entry as a package name with its subpaths.
 * isChainSdkModule uses CHAIN_SDK_PACKAGES. isChainAbiModule matches an abi
 * or abis folder, a .abi, -abi or _abi suffix and a camel case Abi suffix.
 * isChainModule is either.
 */

import { describe, expect, it } from 'vitest';

import {
  CHAIN_NAMESPACES,
  CHAIN_SDK_PACKAGES,
  isChainAbiModule,
  isChainModule,
  isChainSdkModule,
  matchesPackage,
} from './chain-modules.js';

describe('chain module data', () => {
  it('lists the Stellar namespace and SDK scope, frozen', () => {
    expect([...CHAIN_NAMESPACES]).toEqual(['stellar']);
    expect([...CHAIN_SDK_PACKAGES]).toEqual(['@stellar/']);
    expect(Object.isFrozen(CHAIN_NAMESPACES)).toBe(true);
    expect(Object.isFrozen(CHAIN_SDK_PACKAGES)).toBe(true);
  });

  it.each(['@stellar/stellar-sdk', '@stellar/stellar-sdk/rpc', '@stellar/freighter-api'])(
    'treats %s as a chain SDK',
    (name) => {
      expect(isChainSdkModule(name)).toBe(true);
      expect(isChainModule(name)).toBe(true);
    },
  );

  it('matches a scope entry by prefix and a package entry with its subpaths', () => {
    const packages = ['@scope/', 'pkg'];
    expect(matchesPackage('@scope/anything', packages)).toBe(true);
    expect(matchesPackage('pkg', packages)).toBe(true);
    expect(matchesPackage('pkg/sub/path', packages)).toBe(true);
    expect(matchesPackage('pkg-lite', packages)).toBe(false);
    expect(matchesPackage('@scope', packages)).toBe(false);
    expect(matchesPackage('@scoped/x', packages)).toBe(false);
  });

  it.each([
    './abis/Mandate.json',
    'abi',
    './mandate.abi.js',
    './token-abi.json',
    './token_abi.ts',
    './TokenAbi.js',
  ])('treats %s as a contract interface file', (name) => {
    expect(isChainAbiModule(name)).toBe(true);
    expect(isChainModule(name)).toBe(true);
  });

  it.each([
    'zod',
    'stellar-sdk-lite',
    '@stellarx/x',
    '@ujira/core',
    './vocabulary.js',
    './kohlrabi.ts',
    './stable.json',
    'node:crypto',
  ])('leaves %s alone', (name) => {
    expect(isChainModule(name)).toBe(false);
  });
});
