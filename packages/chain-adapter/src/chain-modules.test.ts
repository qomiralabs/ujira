// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the chain module patterns (chain-modules.ts), shared by the
 * root lint rule and the SDK free check. CHAIN_SDK_MODULE matches every
 * package under @stellar/, @celo/, @mento-protocol/, @ethersproject/,
 * @walletconnect/ and @wagmi/, and viem, ethers, web3 and wagmi with their
 * subpaths. isChainAbiModule matches an abi or abis folder, a .abi, -abi
 * or _abi suffix, a camel case Abi suffix and Foundry artifacts.
 * isChainModule is either.
 */

import { describe, expect, it } from 'vitest';

import { CHAIN_SDK_MODULE, isChainAbiModule, isChainModule } from './chain-modules.js';

describe('chain module patterns', () => {
  it.each([
    '@stellar/stellar-sdk',
    '@celo/contractkit',
    '@mento-protocol/mento-sdk',
    '@ethersproject/abi',
    '@walletconnect/sign-client',
    '@wagmi/core',
    'viem',
    'viem/chains',
    'ethers',
    'web3',
    'wagmi',
  ])('treats %s as a chain SDK', (name) => {
    expect(CHAIN_SDK_MODULE.test(name)).toBe(true);
    expect(isChainModule(name)).toBe(true);
  });

  it.each([
    './abis/Mandate.json',
    'abi',
    './mandate.abi.js',
    './erc20-abi.json',
    './erc20_abi.ts',
    './ERC20Abi.js',
    '../out/Mandate.sol/Mandate.json',
  ])('treats %s as an ABI', (name) => {
    expect(isChainAbiModule(name)).toBe(true);
    expect(isChainModule(name)).toBe(true);
  });

  it.each([
    'zod',
    'viem-lite',
    'ethereal',
    '@ujira/core',
    './vocabulary.js',
    './kohlrabi.ts',
    './stable.json',
    'node:crypto',
  ])('leaves %s alone', (name) => {
    expect(isChainModule(name)).toBe(false);
  });
});
