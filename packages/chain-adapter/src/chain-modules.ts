// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What counts as chain code. The root lint config loads this file directly
// to keep chain knowledge inside this package, and this package's own
// tests use it to stay SDK free, so the two can never disagree. It has no
// imports so the lint config can load it as it is. Adding a chain means
// adding its namespace and its SDK packages here, and nowhere else.

/** CAIP-2 namespaces of the chains UJIRA settles on. */
export const CHAIN_NAMESPACES = Object.freeze(['stellar'] as const);

export type ChainNamespace = (typeof CHAIN_NAMESPACES)[number];

/**
 * Chain SDK packages. An entry ending in '/' is a whole npm scope; any other
 * entry is a package name, matched with its subpaths.
 */
export const CHAIN_SDK_PACKAGES: readonly string[] = Object.freeze(['@stellar/']);

/** Whether `specifier` names one of `packages`, as CHAIN_SDK_PACKAGES describes them. */
export function matchesPackage(specifier: string, packages: readonly string[]): boolean {
  return packages.some((entry) =>
    entry.endsWith('/')
      ? specifier.startsWith(entry)
      : specifier === entry || specifier.startsWith(`${entry}/`),
  );
}

export function isChainSdkModule(specifier: string): boolean {
  return matchesPackage(specifier, CHAIN_SDK_PACKAGES);
}

// Contract interface files under the common spellings: an abi or abis
// folder, a name ending in .abi, -abi or _abi, or a camel case name ending
// in Abi.
const ABI_FOLDER = /(?:^|\/)abis?(?:\/|$)/i;
const ABI_SUFFIX = /[._-]abi(?:\.[cm]?[jt]s|\.json)?$/i;
const ABI_CAMEL = /[a-z0-9]Abi(?:\.[cm]?[jt]s|\.json)?$/;

export function isChainAbiModule(specifier: string): boolean {
  return [ABI_FOLDER, ABI_SUFFIX, ABI_CAMEL].some((pattern) => pattern.test(specifier));
}

export function isChainModule(specifier: string): boolean {
  return isChainSdkModule(specifier) || isChainAbiModule(specifier);
}
