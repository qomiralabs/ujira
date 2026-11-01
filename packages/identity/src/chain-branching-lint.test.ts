// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Identity requirements are data on rails and projects, never a chain test.
// The root config's chain branching rule covers every package but the chain
// adapter; this pins that it covers this one, that this package passes it,
// and that a chain literal here would fail. Fixtures are linted in memory
// under real paths in this package, so the scoped config applies to them.

import path from 'node:path';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const SOURCE_FILE = path.join(REPO_ROOT, 'packages/identity/src/eligibility.ts');
const TEST_FILE = path.join(REPO_ROOT, 'packages/identity/src/eligibility.test.ts');
const RULE = 'ujira/no-chain-branching';

const HEADER = [
  '// Copyright (c) 2026 Qomira Labs. All rights reserved.',
  '// Proprietary and confidential. Unauthorized copying is prohibited.',
  '',
].join('\n');

let eslint: ESLint;

// The root config lists every member's tsconfig, and typed linting builds a
// program for each one it tries before it reaches this package's. Pointing
// the parser at this package's tsconfig alone keeps every rule from the root
// config while building one program instead of the whole workspace's.
beforeAll(async () => {
  eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfig: {
      languageOptions: { parserOptions: { project: ['./packages/identity/tsconfig.json'] } },
    },
  });
  await eslint.lintText(`${HEADER}export {};\n`, { filePath: SOURCE_FILE });
}, 180_000);

async function ruleHits(code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(HEADER + code, { filePath });
  if (result === undefined) throw new Error('ESLint returned no result');
  // A parse failure must never count as the rule firing.
  expect(result.messages.filter((message) => message.fatal === true)).toEqual([]);
  return result.messages.filter((message) => message.ruleId === RULE && message.severity === 2)
    .length;
}

const FIXTURES: [string, string][] = [
  [
    'a network comparison',
    "export const onTestnet = (network: string): boolean => network === 'stellar:testnet';\n",
  ],
  [
    'a chain comparison through a const',
    "const CHAIN = 'stellar';\nexport const isIt = (chain: string): boolean => chain === CHAIN;\n",
  ],
  [
    'a switch on a chain',
    "export function kyc(chain: string): boolean {\n  switch (chain) {\n    case 'stellar':\n      return true;\n    default:\n      return false;\n  }\n}\n",
  ],
  [
    'a membership test',
    "export const known = (network: string): boolean => ['stellar:pubnet'].includes(network);\n",
  ],
  [
    'a chain SDK import',
    "import * as sdk from '@stellar/stellar-sdk';\nexport const s: unknown = sdk;\n",
  ],
];

describe('chain branching in packages/identity', () => {
  it('the rule is on for this package', async () => {
    const config = (await eslint.calculateConfigForFile(SOURCE_FILE)) as {
      rules?: Record<string, unknown>;
    };
    expect(config.rules?.[RULE]).toEqual([2]);
  });

  it('every source file passes', async () => {
    const results = await eslint.lintFiles(['packages/identity/src/**/*.ts']);
    expect(results.length).toBeGreaterThan(5);
    const hits = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === RULE)
        .map((message) => `${path.relative(REPO_ROOT, result.filePath)}:${String(message.line)}`),
    );
    expect(hits).toEqual([]);
  });

  it.each(FIXTURES)('fails on a fixture with %s', async (_name, code) => {
    expect(await ruleHits(code, SOURCE_FILE)).toBeGreaterThan(0);
  });

  it.each(FIXTURES)('fails on %s in a test file too', async (_name, code) => {
    expect(await ruleHits(code, TEST_FILE)).toBeGreaterThan(0);
  });

  it('passing a network through without comparing it is fine', async () => {
    const code =
      "import type { NetworkId } from '@ujira/chain-adapter';\nexport const same = (a: NetworkId, b: NetworkId): boolean => a === b;\n";
    expect(await ruleHits(code, SOURCE_FILE)).toBe(0);
  });
});
