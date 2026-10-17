// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the chain branching rule (ujira/no-chain-branching in the
 * root ESLint config).
 *
 * Outside packages/chain-adapter, in every workspace package and app:
 * - no import, export from, dynamic import, require or import type of
 *   @stellar/stellar-sdk, @stellar/stellar-base, viem,
 *   @mento-protocol/mento-sdk, any of their subpaths, or a chain ABI file;
 * - no ==, ===, != or !== against a chain or network literal ('stellar',
 *   'celo', a Stellar network or a Celo chain ID), on either side;
 * - no switch case on one.
 * Inside packages/chain-adapter the same code passes. Snippets are linted
 * in memory under real file paths so the scoped config applies.
 */

import path from 'node:path';

import { ESLint } from 'eslint';
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

describe('the chain branching rule', () => {
  it.each(SDK_IMPORTS)('fails on %s in packages/payouts', async (_label, code) => {
    expect(await ruleHits(code, PAYOUTS_FILE)).toBeGreaterThan(0);
  });

  it.each(COMPARISONS)('fails on %s in packages/payouts', async (_label, code) => {
    expect(await ruleHits(code, PAYOUTS_FILE)).toBe(1);
  });

  it('applies in core and its money module too', async () => {
    const [, sdk] = SDK_IMPORTS[0] ?? ['', ''];
    const [, compare] = COMPARISONS[0] ?? ['', ''];
    expect(await ruleHits(sdk, CORE_FILE)).toBeGreaterThan(0);
    expect(await ruleHits(compare, CORE_FILE)).toBe(1);
    expect(await ruleHits(compare, MONEY_FILE)).toBe(1);
  });

  it.each([...SDK_IMPORTS, ...COMPARISONS])(
    'passes on %s inside the chain adapter',
    async (_label, code) => {
      expect(await ruleHits(code, ADAPTER_FILE)).toBe(0);
    },
  );

  it.each([
    ['a chain as data', "export const chain = 'stellar';\n"],
    [
      'a lookup by key',
      "const m: Record<string, number> = { celo: 1 };\nexport const v = m['celo'];\n",
    ],
    ['other literals', "export const f = (s: string) => s === 'stellarx' || s === 'eip155:1';\n"],
    ['a lookalike package', "import { z } from 'zod';\nexport const s: unknown = z;\n"],
    ['a package named like viem', "export const f = () => import('viem-lite');\n"],
  ])('ignores %s outside the adapter', async (_label, code) => {
    expect(await ruleHits(code, PAYOUTS_FILE)).toBe(0);
  });
});
