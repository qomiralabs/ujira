// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which module specifiers count as chain code. The root lint config loads
// this file directly to ban them outside this package, and this package's
// own tests use it to stay SDK free, so the two can never disagree. It has
// no imports so the lint config can load it as it is.

/** Chain SDK packages: whole scopes, and the bare packages with their subpaths. */
export const CHAIN_SDK_MODULE =
  /^(?:@stellar\/|@celo\/|@mento-protocol\/|@ethersproject\/|@walletconnect\/|@wagmi\/|(?:viem|ethers|web3|wagmi)(?:\/|$))/;

// ABI files under the common spellings: an abi or abis folder, a name
// ending in .abi, -abi or _abi, a camel case name ending in Abi, and the
// Foundry build output of a Solidity file.
const ABI_FOLDER = /(?:^|\/)abis?(?:\/|$)/i;
const ABI_SUFFIX = /[._-]abi(?:\.[cm]?[jt]s|\.json)?$/i;
const ABI_CAMEL = /[a-z0-9]Abi(?:\.[cm]?[jt]s|\.json)?$/;
const FOUNDRY_ARTIFACT = /\.sol\/[^/]+\.json$/;

export function isChainAbiModule(specifier: string): boolean {
  return [ABI_FOLDER, ABI_SUFFIX, ABI_CAMEL, FOUNDRY_ARTIFACT].some((pattern) =>
    pattern.test(specifier),
  );
}

export function isChainModule(specifier: string): boolean {
  return CHAIN_SDK_MODULE.test(specifier) || isChainAbiModule(specifier);
}
