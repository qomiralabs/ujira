// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the chain branching rule (ujira/no-chain-branching in the
 * root ESLint config).
 *
 * Outside packages/chain-adapter, in every workspace package and app:
 * - no import, export from, dynamic import, import type, require (direct,
 *   aliased, module.require or through createRequire) of a chain SDK or a
 *   chain ABI file. Chain SDKs are every package under @stellar/, @celo/,
 *   @mento-protocol/, @ethersproject/, @walletconnect/ and @wagmi/, and
 *   viem, ethers, web3 and wagmi with their subpaths.
 * - no ==, ===, != or !== against a chain or network literal ('stellar',
 *   'celo', a Stellar network, a Celo CAIP-2 ID, or a Celo chain ID as a
 *   number or bigint), on either side;
 * - no switch case on one;
 * - no includes, has, indexOf or lastIndexOf call, and no Object.is, that
 *   tests one, whether the literal is an argument or an element of the
 *   array or Set the call is made on;
 * - no member access by a chain or network key, computed or not, and no
 *   computed lookup into an object literal keyed by one.
 * A literal counts however it is wrapped (as, as const, satisfies, an angle
 * bracket assertion or a non null assertion), through optional chaining, and
 * when it is reached through a const binding in the same file. A let is not
 * followed, since it can be reassigned.
 * Inside packages/chain-adapter the same code passes. Snippets are linted
 * in memory under real file paths so the scoped config applies.
 */

import path from 'node:path';

import { ESLint } from 'eslint';

import { CHAIN_SDK_MODULE } from './chain-modules.js';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const PAYOUTS_FILE = path.join(REPO_ROOT, 'packages/payouts/src/index.ts');
const CORE_FILE = path.join(REPO_ROOT, 'packages/core/src/index.ts');
const MONEY_FILE = path.join(REPO_ROOT, 'packages/core/src/money/currencies.ts');
const ADAPTER_FILE = path.join(REPO_ROOT, 'packages/chain-adapter/src/index.ts');

const HEADER = [
  '// Copyright (c) 2026 Qomira Labs. All rights reserved.',
  '// Proprietary and confidential. Unauthorized copying is prohibited.',
  '',
].join('\n');

const RULE = 'ujira/no-chain-branching';

let eslint: ESLint;

// The first typed lint builds the TypeScript program for the whole
// workspace, which can take longer than one test's timeout under coverage.
// Doing it here once keeps that cost out of whichever test happens to run
// first.
beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO_ROOT });
  await eslint.lintText(`${HEADER}export {};\n`, { filePath: PAYOUTS_FILE });
  await eslint.lintText(`${HEADER}export {};\n`, { filePath: ADAPTER_FILE });
}, 120_000);

async function ruleHits(code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(HEADER + code, { filePath });
  if (result === undefined) throw new Error('ESLint returned no result');
  // A parse failure must never count as the rule firing.
  expect(result.messages.filter((msg) => msg.fatal === true)).toEqual([]);
  return result.messages.filter((msg) => msg.ruleId === RULE && msg.severity === 2).length;
}

const SDK_IMPORTS: [string, string][] = [
  [
    'viem',
    "import { createPublicClient } from 'viem';\nexport const c: unknown = createPublicClient;\n",
  ],
  ['a viem subpath', "import { celo } from 'viem/chains';\nexport const c: unknown = celo;\n"],
  [
    'the Stellar SDK',
    "import * as sdk from '@stellar/stellar-sdk';\nexport const s: unknown = sdk;\n",
  ],
  [
    'a Stellar SDK subpath',
    "import { Server } from '@stellar/stellar-sdk/rpc';\nexport const s: unknown = Server;\n",
  ],
  [
    'stellar-base',
    "import { Keypair } from '@stellar/stellar-base';\nexport const k: unknown = Keypair;\n",
  ],
  [
    'the Mento SDK',
    "import { Mento } from '@mento-protocol/mento-sdk';\nexport const m: unknown = Mento;\n",
  ],
  ['a type only import', "import type { Address } from 'viem';\nexport type A = Address;\n"],
  ['a re-export', "export { parseUnits } from 'viem';\n"],
  ['a star re-export', "export * from '@stellar/stellar-sdk';\n"],
  ['a dynamic import', "export const load = () => import('viem');\n"],
  ['an import type expression', "export type A = import('viem').Address;\n"],
  [
    'a require call',
    "declare const require: (id: string) => unknown;\nexport const v = require('viem');\n",
  ],
  ['an import equals', "import viem = require('viem');\nexport const v: unknown = viem;\n"],
  ['an ABI module', "import abi from '../abis/Mandate.json';\nexport const a: unknown = abi;\n"],
  [
    'an ABI file',
    "import { mandateAbi } from './mandate.abi.js';\nexport const a: unknown = mandateAbi;\n",
  ],
  ['a dashed ABI file', "import abi from './erc20-abi.json';\nexport const a: unknown = abi;\n"],
  ['a camel case ABI file', "import { x } from './ERC20Abi.js';\nexport const a: unknown = x;\n"],
  [
    'a Foundry artifact',
    "import a from '../out/Mandate.sol/Mandate.json';\nexport const v: unknown = a;\n",
  ],
  [
    'createRequire',
    "declare const createRequire: (u: string) => (id: string) => unknown;\nexport const v = createRequire(import.meta.url)('viem');\n",
  ],
  [
    'an aliased require',
    "declare const require: (id: string) => unknown;\nconst r = require;\nexport const v = r('viem');\n",
  ],
  [
    'module.require',
    "declare const module: { require(id: string): unknown };\nexport const v = module.require('viem');\n",
  ],
];

// Every chain SDK family, so the ban and the package's own SDK free check
// cannot drift apart.
const SDK_PACKAGES = [
  '@stellar/stellar-sdk',
  '@stellar/stellar-base',
  '@stellar/js-xdr',
  '@stellar/freighter-api',
  '@celo/contractkit',
  '@celo/abis',
  '@mento-protocol/mento-sdk',
  '@ethersproject/abi',
  '@walletconnect/sign-client',
  '@wagmi/core',
  'viem',
  'viem/chains',
  'ethers',
  'ethers/lib/utils',
  'web3',
  'wagmi',
];

const COMPARISONS: [string, string][] = [
  ["chain === 'stellar'", "export const f = (chain: string) => chain === 'stellar';\n"],
  ["'celo' == chain", "export const f = (chain: string) => 'celo' == chain;\n"],
  ["chain !== 'celo'", "export const f = (chain: string) => chain !== 'celo';\n"],
  ['a network ID', "export const f = (n: string) => n === 'eip155:42220';\n"],
  ['a testnet ID', "export const f = (n: string) => n != 'stellar:testnet';\n"],
  ['a template literal', 'export const f = (chain: string) => chain === `stellar`;\n'],
  [
    'a switch case',
    "export const f = (chain: string): number => {\n  switch (chain) {\n    case 'celo':\n      return 1;\n    default:\n      return 0;\n  }\n};\n",
  ],
];

// Each form a reviewer found getting past the first version of the rule.
const WRAPPED_AND_INDIRECT: [string, string][] = [
  ['as const', "export const f = (chain: string) => chain === ('stellar' as const);\n"],
  ['as a type', "export const f = (chain: string) => chain === ('stellar' as typeof chain);\n"],
  ['satisfies', "export const f = (chain: string) => chain === ('stellar' satisfies string);\n"],
  [
    'an angle bracket assertion',
    "export const f = (chain: string) => chain === <const>'stellar';\n",
  ],
  ['a non null assertion', "export const f = (chain: string) => chain === 'stellar'!;\n"],
  [
    'a wrapped switch case',
    "export const f = (chain: string): number => {\n  switch (chain) {\n    case 'celo' as const:\n      return 1;\n    default:\n      return 0;\n  }\n};\n",
  ],
  ['a module const', "const CELO = 'celo';\nexport const f = (chain: string) => chain === CELO;\n"],
  [
    'a const of a const',
    "const A = 'stellar:pubnet' as const;\nconst B = A;\nexport const f = (n: string) => n !== B;\n",
  ],
  [
    'a const in a switch case',
    "const S = 'stellar';\nexport const f = (c: string): number => {\n  switch (c) {\n    case S:\n      return 1;\n    default:\n      return 0;\n  }\n};\n",
  ],
  ['a numeric chain ID', 'export const f = (id: number) => id === 42220;\n'],
  ['a bigint chain ID', 'export const f = (id: bigint) => id === 42220n;\n'],
  ['the Alfajores chain ID', 'export const f = (id: number) => 44787 === id;\n'],
  ['the Celo Sepolia chain ID', 'export const f = (id: number) => id !== 11142220;\n'],
  ['the Alfajores network ID', "export const f = (n: string) => n === 'eip155:44787';\n"],
  ['a const chain ID', 'const CELO_ID = 42220;\nexport const f = (id: number) => id == CELO_ID;\n'],
  ['includes on an array', "export const f = (chain: string) => ['celo'].includes(chain);\n"],
  [
    'includes on a const array',
    "const CHAINS = ['stellar', 'celo'];\nexport const f = (chain: string) => CHAINS.includes(chain);\n",
  ],
  [
    'includes with the literal as argument',
    "export const f = (chains: string[]) => chains.includes('celo');\n",
  ],
  ['indexOf', "export const f = (chains: string[]) => chains.indexOf('stellar') >= 0;\n"],
  ['has on a Set', "export const f = (chain: string) => new Set(['stellar']).has(chain);\n"],
  ['Object.is', "export const f = (chain: string) => Object.is(chain, 'celo');\n"],
  [
    'a lookup table',
    "export const f = (chain: 'celo' | 'stellar') => ({ celo: 1, stellar: 2 })[chain];\n",
  ],
  [
    'a const lookup table',
    "const FEES = { 'eip155:42220': 1n };\nexport const f = (n: 'eip155:42220') => FEES[n];\n",
  ],
  ['a computed key', "const m: Record<string, number> = {};\nexport const v = m['celo'];\n"],
  ['a member key', 'declare const m: { celo: number };\nexport const v = m.celo;\n'],
  [
    'optional chaining',
    'declare const m: { stellar?: number } | undefined;\nexport const v = m?.stellar;\n',
  ],
];

describe('the chain branching rule', () => {
  it.each(SDK_IMPORTS)('fails on %s in packages/payouts', async (_label, code) => {
    expect(await ruleHits(code, PAYOUTS_FILE)).toBeGreaterThan(0);
  });

  it.each(COMPARISONS)('fails on %s in packages/payouts', async (_label, code) => {
    expect(await ruleHits(code, PAYOUTS_FILE)).toBe(1);
  });

  it.each(WRAPPED_AND_INDIRECT)('fails on %s in packages/payouts', async (_label, code) => {
    expect(await ruleHits(code, PAYOUTS_FILE)).toBeGreaterThan(0);
  });

  it.each(SDK_PACKAGES)('bans %s and agrees with the SDK free check', async (name) => {
    const code = `import * as sdk from '${name}';\nexport const s: unknown = sdk;\n`;
    expect(await ruleHits(code, PAYOUTS_FILE)).toBe(1);
    expect(CHAIN_SDK_MODULE.test(name)).toBe(true);
  });

  it('applies in core and its money module too', async () => {
    const [, sdk] = SDK_IMPORTS[0] ?? ['', ''];
    const [, compare] = COMPARISONS[0] ?? ['', ''];
    expect(await ruleHits(sdk, CORE_FILE)).toBeGreaterThan(0);
    expect(await ruleHits(compare, CORE_FILE)).toBe(1);
    expect(await ruleHits(compare, MONEY_FILE)).toBe(1);
  });

  it.each([...SDK_IMPORTS, ...COMPARISONS, ...WRAPPED_AND_INDIRECT])(
    'passes on %s inside the chain adapter',
    async (_label, code) => {
      expect(await ruleHits(code, ADAPTER_FILE)).toBe(0);
    },
  );

  it.each([
    ['a chain as data', "export const chain = 'stellar';\n"],
    [
      'unrelated constants',
      "const X = 'stellarx';\nconst N = 4222;\nexport const f = (s: string, n: number) => s === X || n === N;\n",
    ],
    [
      'unrelated lookups',
      "declare const m: { celsius: number; ['eip155:1']: number };\nexport const v = m.celsius + m['eip155:1'];\n",
    ],
    [
      'unrelated membership',
      "export const f = (s: string) => ['stellarx'].includes(s) || Object.is(s, 'x');\n",
    ],
    ['a chain ID in arithmetic', 'export const f = (id: number) => id + 42220;\n'],
    [
      // A let can be reassigned, so only const bindings are followed.
      'a let binding',
      "let X = 'celo';\nX = String(Date.now());\nexport const f = (s: string) => s === X;\n",
    ],
    ['other literals', "export const f = (s: string) => s === 'stellarx' || s === 'eip155:1';\n"],
    ['a lookalike package', "import { z } from 'zod';\nexport const s: unknown = z;\n"],
    ['a package named like viem', "export const f = () => import('viem-lite');\n"],
  ])('ignores %s outside the adapter', async (_label, code) => {
    expect(await ruleHits(code, PAYOUTS_FILE)).toBe(0);
  });
});
