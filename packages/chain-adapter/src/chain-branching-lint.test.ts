// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the chain branching rule (ujira/no-chain-branching in the
 * root ESLint config).
 *
 * The rule reads CHAIN_NAMESPACES and CHAIN_SDK_PACKAGES from this
 * package, so it covers every chain listed there and nothing else needs to
 * change when one is added. Outside packages/chain-adapter, in every
 * workspace package and app:
 * - no import, export from, dynamic import, import type, require (direct,
 *   aliased, module.require or through createRequire) of a chain SDK
 *   package or a contract interface (ABI) file;
 * - no ==, ===, != or !== against a namespace name or a `<namespace>:`
 *   network string, in any letter case, on either side;
 * - no switch case on one;
 * - no includes, has, indexOf or lastIndexOf call, and no Object.is, that
 *   tests one, whether the literal is an argument or an element of the
 *   array or Set the call is made on;
 * - no startsWith, endsWith, includes, match or search with a namespace as
 *   a whole token, and no regular expression naming one as a word;
 * - no member access by a namespace key, computed or not, and no computed
 *   lookup into an object literal keyed by one.
 * A literal counts however it is wrapped (as, as const, satisfies, an angle
 * bracket assertion or a non null assertion), through optional chaining, and
 * when it is reached through a const binding in the same file. A let is not
 * followed, since it can be reassigned. Test files relax only the regex and
 * plain property read checks.
 * Inside packages/chain-adapter the same code passes. Snippets are linted
 * in memory under real file paths so the scoped config applies.
 *
 * Lint fixture codecs-no-network, the contract for the codecs fence, shares
 * this file so it reuses the warm linter below. Source under
 * packages/chain-adapter/src/codecs (tests aside) may import only its own
 * folder (a ./ path that never climbs back out), node:crypto, @ujira/core,
 * @stellar/stellar-base and the adapter's errors, networks and types
 * modules. Anything else fails, so an RPC client, the full Stellar SDK, a
 * node network module, an HTTP client or another adapter module cannot be
 * imported or re-exported. Dynamic import fails outright, and so do the
 * network globals fetch, WebSocket, XMLHttpRequest and EventSource, bare or
 * through globalThis or global. The repository's other fences still apply
 * there. Elsewhere in the adapter the same code passes this fence.
 */

import path from 'node:path';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

import { CHAIN_NAMESPACES, CHAIN_SDK_PACKAGES, isChainSdkModule } from './chain-modules.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const PAYOUTS_FILE = path.join(REPO_ROOT, 'packages/payouts/src/index.ts');
const CORE_FILE = path.join(REPO_ROOT, 'packages/core/src/index.ts');
const MONEY_FILE = path.join(REPO_ROOT, 'packages/core/src/money/currencies.ts');
const ADAPTER_FILE = path.join(REPO_ROOT, 'packages/chain-adapter/src/index.ts');
const CODECS_FILE = path.join(REPO_ROOT, 'packages/chain-adapter/src/codecs/index.ts');

const HEADER = [
  '// Copyright (c) 2026 Qomira Labs. All rights reserved.',
  '// Proprietary and confidential. Unauthorized copying is prohibited.',
  '',
].join('\n');

const RULE = 'ujira/no-chain-branching';

// A second chain that exists only in this test, to prove the rule follows
// the namespace list rather than knowing about Stellar.
const TEST_ONLY_NAMESPACE = 'testchain';
const TEST_ONLY_SDK = '@testchain/';

let eslint: ESLint;
let eslintWithSecondChain: ESLint;

// The first typed lint builds the TypeScript program for the whole
// workspace, which can take longer than one test's timeout under coverage.
// Doing it here once keeps that cost out of whichever test happens to run
// first.
beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO_ROOT });
  eslintWithSecondChain = new ESLint({
    cwd: REPO_ROOT,
    overrideConfig: {
      files: ['packages/payouts/**/*.ts'],
      rules: {
        [RULE]: [
          'error',
          {
            namespaces: [...CHAIN_NAMESPACES, TEST_ONLY_NAMESPACE],
            sdkPackages: [...CHAIN_SDK_PACKAGES, TEST_ONLY_SDK],
          },
        ],
      },
    },
  });
  await eslint.lintText(`${HEADER}export {};\n`, { filePath: PAYOUTS_FILE });
  await eslint.lintText(`${HEADER}export {};\n`, { filePath: ADAPTER_FILE });
  await eslint.lintText(`${HEADER}export {};\n`, { filePath: CODECS_FILE });
  await eslintWithSecondChain.lintText(`${HEADER}export {};\n`, { filePath: PAYOUTS_FILE });
}, 120_000);

async function hitsWith(linter: ESLint, code: string, filePath: string): Promise<number> {
  const [result] = await linter.lintText(HEADER + code, { filePath });
  if (result === undefined) throw new Error('ESLint returned no result');
  // A parse failure must never count as the rule firing.
  expect(result.messages.filter((msg) => msg.fatal === true)).toEqual([]);
  return result.messages.filter((msg) => msg.ruleId === RULE && msg.severity === 2).length;
}

const ruleHits = (code: string, filePath: string): Promise<number> =>
  hitsWith(eslint, code, filePath);

const SDK_IMPORTS: [string, string][] = [
  [
    'the Stellar SDK',
    "import * as sdk from '@stellar/stellar-sdk';\nexport const s: unknown = sdk;\n",
  ],
  [
    'a Stellar SDK subpath',
    "import { Server } from '@stellar/stellar-sdk/rpc';\nexport const s: unknown = Server;\n",
  ],
  [
    'another package in the scope',
    "import { isConnected } from '@stellar/freighter-api';\nexport const f: unknown = isConnected;\n",
  ],
  [
    'a type only import',
    "import type { Keypair } from '@stellar/stellar-sdk';\nexport type K = Keypair;\n",
  ],
  ['a re-export', "export { Keypair } from '@stellar/stellar-sdk';\n"],
  ['a star re-export', "export * from '@stellar/stellar-sdk';\n"],
  ['a dynamic import', "export const load = () => import('@stellar/stellar-sdk');\n"],
  ['an import type expression', "export type K = import('@stellar/stellar-sdk').Keypair;\n"],
  [
    'a require call',
    "declare const require: (id: string) => unknown;\nexport const v = require('@stellar/stellar-sdk');\n",
  ],
  [
    'an import equals',
    "import sdk = require('@stellar/stellar-sdk');\nexport const v: unknown = sdk;\n",
  ],
  [
    'createRequire',
    "declare const createRequire: (u: string) => (id: string) => unknown;\nexport const v = createRequire(import.meta.url)('@stellar/stellar-sdk');\n",
  ],
  [
    'an aliased require',
    "declare const require: (id: string) => unknown;\nconst r = require;\nexport const v = r('@stellar/stellar-sdk');\n",
  ],
  [
    'module.require',
    "declare const module: { require(id: string): unknown };\nexport const v = module.require('@stellar/stellar-sdk');\n",
  ],
  ['an ABI folder', "import abi from '../abis/Mandate.json';\nexport const a: unknown = abi;\n"],
  [
    'an ABI file',
    "import { mandateAbi } from './mandate.abi.js';\nexport const a: unknown = mandateAbi;\n",
  ],
];

const COMPARISONS: [string, string][] = [
  ["chain === 'stellar'", "export const f = (chain: string) => chain === 'stellar';\n"],
  ["'stellar' == chain", "export const f = (chain: string) => 'stellar' == chain;\n"],
  ["chain !== 'stellar'", "export const f = (chain: string) => chain !== 'stellar';\n"],
  ['a network ID', "export const f = (n: string) => n === 'stellar:pubnet';\n"],
  ['a testnet ID', "export const f = (n: string) => n != 'stellar:testnet';\n"],
  [
    'another network in the namespace',
    "export const f = (n: string) => n === 'stellar:futurenet';\n",
  ],
  ['a template literal', 'export const f = (chain: string) => chain === `stellar`;\n'],
  ['a capitalised chain', "export const f = (chain: string) => chain === 'Stellar';\n"],
  ['an uppercase chain', "export const f = (chain: string) => 'STELLAR' !== chain;\n"],
  [
    'a switch case',
    "export const f = (chain: string): number => {\n  switch (chain) {\n    case 'stellar':\n      return 1;\n    default:\n      return 0;\n  }\n};\n",
  ],
];

// Each indirect form of the same comparison.
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
    "export const f = (chain: string): number => {\n  switch (chain) {\n    case 'stellar' as const:\n      return 1;\n    default:\n      return 0;\n  }\n};\n",
  ],
  ['a module const', "const S = 'stellar';\nexport const f = (chain: string) => chain === S;\n"],
  [
    'a const of a const',
    "const A = 'stellar:pubnet' as const;\nconst B = A;\nexport const f = (n: string) => n !== B;\n",
  ],
  [
    'a split namespace',
    "export const f = (network: string) => {\n  const [ns] = network.split(':');\n  return ns === 'stellar';\n};\n",
  ],
  ['includes on an array', "export const f = (chain: string) => ['stellar'].includes(chain);\n"],
  [
    'includes on a const array',
    "const CHAINS = ['stellar'];\nexport const f = (chain: string) => CHAINS.includes(chain);\n",
  ],
  [
    'includes with the literal as argument',
    "export const f = (c: string[]) => c.includes('stellar');\n",
  ],
  ['indexOf', "export const f = (c: string[]) => c.indexOf('stellar') >= 0;\n"],
  ['has on a Set', "export const f = (chain: string) => new Set(['stellar']).has(chain);\n"],
  ['Object.is', "export const f = (chain: string) => Object.is(chain, 'stellar');\n"],
  ['a lookup table', "export const f = (chain: 'stellar') => ({ stellar: 1 })[chain];\n"],
  [
    'a const lookup table',
    "const FEES = { 'stellar:pubnet': 1n };\nexport const f = (n: 'stellar:pubnet') => FEES[n];\n",
  ],
  ['a computed key', "const m: Record<string, number> = {};\nexport const v = m['stellar'];\n"],
  ['a member key', 'declare const m: { stellar: number };\nexport const v = m.stellar;\n'],
  [
    'optional chaining',
    'declare const m: { stellar?: number } | undefined;\nexport const v = m?.stellar;\n',
  ],
  ['startsWith a namespace', "export const f = (n: string) => n.startsWith('stellar:');\n"],
  ['endsWith a network', "export const f = (n: string) => n.endsWith(':stellar');\n"],
  ['match with a chain string', "export const f = (n: string) => n.match('stellar') !== null;\n"],
  ['search with a namespace', "export const f = (n: string) => n.search('stellar:') >= 0;\n"],
  ['a regex test', 'export const f = (c: string) => /^stellar/.test(c);\n'],
  ['a word bounded regex', 'export const f = (c: string) => /\\bstellar\\b/.test(c);\n'],
  ['a case insensitive regex', 'export const f = (c: string) => /STELLAR/i.exec(c) !== null;\n'],
  ['new RegExp', "export const f = (n: string) => new RegExp('stellar').test(n);\n"],
  ['RegExp called', "export const f = (n: string) => RegExp('^stellar$', 'i').test(n);\n"],
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

  it('bans each chain SDK package and agrees with the SDK free check', async () => {
    for (const entry of CHAIN_SDK_PACKAGES) {
      const name = entry.endsWith('/') ? `${entry}anything` : entry;
      const code = `import * as sdk from '${name}';\nexport const s: unknown = sdk;\n`;
      expect(await ruleHits(code, PAYOUTS_FILE)).toBe(1);
      expect(isChainSdkModule(name)).toBe(true);
    }
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

  it('a second test-only namespace is caught', async () => {
    const hits = (code: string) => hitsWith(eslintWithSecondChain, code, PAYOUTS_FILE);
    const ns = TEST_ONLY_NAMESPACE;
    expect(await hits(`export const f = (c: string) => c === '${ns}';\n`)).toBe(1);
    expect(await hits(`export const f = (n: string) => n === '${ns}:mainnet';\n`)).toBe(1);
    expect(await hits(`export const f = (n: string) => n.startsWith('${ns}:');\n`)).toBe(1);
    expect(await hits(`export const f = (c: string) => ['${ns}'].includes(c);\n`)).toBe(1);
    expect(await hits(`export const f = (c: string) => /^${ns}/.test(c);\n`)).toBe(1);
    expect(
      await hits(`import * as sdk from '${TEST_ONLY_SDK}sdk';\nexport const s: unknown = sdk;\n`),
    ).toBe(1);
    // Stellar is still covered alongside it.
    expect(await hits("export const f = (c: string) => c === 'stellar';\n")).toBe(1);
    // Without the extra entry, the default rule knows nothing of it.
    expect(await ruleHits(`export const f = (c: string) => c === '${ns}';\n`, PAYOUTS_FILE)).toBe(
      0,
    );
  });

  // Tests assert on displayed text and fixtures, so regexes and property
  // reads that name a chain are allowed there. Imports and comparisons are
  // not.
  it('relaxes only regexes and property reads in test files', async () => {
    const TEST_FILE = path.join(REPO_ROOT, 'packages/core/src/index.test.ts');
    expect(await ruleHits('export const f = (s: string) => /stellar/i.test(s);\n', TEST_FILE)).toBe(
      0,
    );
    expect(
      await ruleHits(
        'declare const theme: { stellar: string };\nexport const v = theme.stellar;\n',
        TEST_FILE,
      ),
    ).toBe(0);
    expect(await ruleHits("export const f = (c: string) => c === 'stellar';\n", TEST_FILE)).toBe(1);
    expect(
      await ruleHits("export const f = (c: string[]) => c.includes('stellar');\n", TEST_FILE),
    ).toBe(1);
    expect(
      await ruleHits(
        "const m: Record<string, number> = {};\nexport const v = m['stellar'];\n",
        TEST_FILE,
      ),
    ).toBe(1);
    expect(
      await ruleHits(
        "import * as sdk from '@stellar/stellar-sdk';\nexport const s: unknown = sdk;\n",
        TEST_FILE,
      ),
    ).toBe(1);
    // The same regex and property read still count in source.
    expect(
      await ruleHits('export const f = (s: string) => /stellar/i.test(s);\n', PAYOUTS_FILE),
    ).toBe(1);
  });

  // Only test file names are relaxed. Production code that happens to live
  // in a spec or __tests__ folder keeps every check.
  it.each([
    'packages/payouts/src/spec/routing.ts',
    'packages/payouts/spec/a.ts',
    'apps/web/src/__tests__/helpers.ts',
    'packages/ui/src/testing/a.tsx',
  ])('keeps every check for %s', async (file) => {
    const config = (await eslint.calculateConfigForFile(path.join(REPO_ROOT, file))) as {
      rules?: Record<string, unknown>;
    };
    expect(config.rules?.[RULE]).toEqual([2]);
  });

  it.each([
    'packages/payouts/src/a.test.ts',
    'packages/payouts/src/a.test-d.ts',
    'packages/ui/src/a.test.tsx',
    'packages/payouts/src/a.spec.ts',
    'apps/web/src/__tests__/a.test.ts',
  ])('uses the relaxed options for %s', async (file) => {
    const config = (await eslint.calculateConfigForFile(path.join(REPO_ROOT, file))) as {
      rules?: Record<string, unknown>;
    };
    expect(config.rules?.[RULE]).toEqual([2, { regex: false, memberNames: false }]);
  });

  it.each(['packages/payouts/src/x.js', 'packages/payouts/src/x.mjs', 'apps/web/src/x.cjs'])(
    'applies to JavaScript files too: %s',
    async (file) => {
      const config = (await eslint.calculateConfigForFile(path.join(REPO_ROOT, file))) as {
        rules?: Record<string, unknown>;
      };
      expect(config.rules?.[RULE]).toEqual([2]);
    },
  );

  it.each([
    ['a chain as data', "export const chain = 'stellar';\n"],
    [
      'unrelated constants',
      "const X = 'stellarx';\nexport const f = (s: string) => s === X || s === 'pubnet';\n",
    ],
    [
      'unrelated lookups',
      "declare const m: { stellarx: number; ['stellar_x']: number };\nexport const v = m.stellarx + m['stellar_x'];\n",
    ],
    [
      'unrelated string methods',
      "export const f = (s: string) => s.startsWith('stellarx') || s.endsWith('.json') || /^stel/.test(s);\n",
    ],
    [
      'unrelated membership',
      "export const f = (s: string) => ['stellarx'].includes(s) || Object.is(s, 'x');\n",
    ],
    [
      // A let can be reassigned, so only const bindings are followed.
      'a let binding',
      "let X = 'stellar';\nX = String(Date.now());\nexport const f = (s: string) => s === X;\n",
    ],
    [
      'words that contain a chain name',
      'export const f = (s: string) => /interstellar/.test(s) || /Stellarium/i.test(s) || /stellar_x/.test(s);\n',
    ],
    ['a lookalike package', "import { z } from 'zod';\nexport const s: unknown = z;\n"],
    ['a package named like the SDK', "export const f = () => import('stellar-sdk-lite');\n"],
    ['a scope that only starts the same', "export const f = () => import('@stellarx/kit');\n"],
  ])('ignores %s outside the adapter', async (_label, code) => {
    expect(await ruleHits(code, PAYOUTS_FILE)).toBe(0);
  });
});

// The rules the codecs fence is built from.
const FENCE_RULES: ReadonlySet<string> = new Set([
  'no-restricted-imports',
  'no-restricted-syntax',
  'no-restricted-properties',
  'no-restricted-globals',
]);

async function fenceHits(code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(HEADER + code, { filePath });
  if (result === undefined) throw new Error('ESLint returned no result');
  expect(result.messages.filter((msg) => msg.fatal === true)).toEqual([]);
  return result.messages.filter(
    (msg) => msg.ruleId !== null && FENCE_RULES.has(msg.ruleId) && msg.severity === 2,
  ).length;
}

const NETWORK_CODE: [string, string][] = [
  [
    'an RPC import',
    "import { Server } from '@stellar/stellar-sdk/rpc';\nexport const s: unknown = Server;\n",
  ],
  [
    'the Stellar SDK, which carries the RPC and Horizon clients',
    "import { rpc } from '@stellar/stellar-sdk';\nexport const r: unknown = rpc;\n",
  ],
  [
    'a Horizon import',
    "import { Horizon } from '@stellar/stellar-sdk';\nexport const h: unknown = Horizon;\n",
  ],
  ['a re-export of the RPC client', "export { Server } from '@stellar/stellar-sdk/rpc';\n"],
  ['a star re-export of the RPC client', "export * from '@stellar/stellar-sdk/rpc';\n"],
  ['node:https', "import https from 'node:https';\nexport const h: unknown = https;\n"],
  ['http without the node prefix', "import http from 'http';\nexport const h: unknown = http;\n"],
  ['node:net', "import net from 'node:net';\nexport const n: unknown = net;\n"],
  ['node:dns', "import dns from 'node:dns';\nexport const d: unknown = dns;\n"],
  ['an HTTP client', "import { request } from 'undici';\nexport const r: unknown = request;\n"],
  [
    'another adapter module',
    "import { createChainAdapterRegistry } from '../registry.js';\nexport const r: unknown = createChainAdapterRegistry;\n",
  ],
  [
    'a path that climbs out of the folder',
    "import { createChainAdapterRegistry } from './../registry.js';\nexport const r: unknown = createChainAdapterRegistry;\n",
  ],
  ['a dynamic import', "export const load = () => import('node:https');\n"],
  ['a dynamic import of an allowed module', "export const load = () => import('node:crypto');\n"],
  ['fetch', "export const f = () => fetch('https://rpc.example');\n"],
  ['globalThis.fetch', "export const f = () => globalThis.fetch('https://rpc.example');\n"],
  ['global.fetch', "export const f = () => global.fetch('https://rpc.example');\n"],
  ['a WebSocket', "export const w = () => new WebSocket('wss://rpc.example');\n"],
  [
    'the runtime loader the repository fence bans',
    "import { createRequire } from 'node:module';\nexport const r: unknown = createRequire;\n",
  ],
];

const PURE_CODE: [string, string][] = [
  [
    'node:crypto',
    "import { createHash } from 'node:crypto';\nexport const h: unknown = createHash;\n",
  ],
  [
    'the Stellar base library',
    "import { xdr } from '@stellar/stellar-base';\nexport const x: unknown = xdr;\n",
  ],
  ['core', "import { money } from '@ujira/core';\nexport const m: unknown = money;\n"],
  [
    'the adapter errors',
    "import { InvalidInputError } from '../errors.js';\nexport const e: unknown = InvalidInputError;\n",
  ],
  ['the adapter types', "import type { Uuid } from '../types.js';\nexport type U = Uuid;\n"],
  [
    'its own folder',
    "import { isAccountAddress } from './strkey.js';\nexport const a: unknown = isAccountAddress;\n",
  ],
];

describe('codecs-no-network', () => {
  it.each(NETWORK_CODE)('fails on %s inside codecs', async (_label, code) => {
    expect(await fenceHits(code, CODECS_FILE)).toBeGreaterThan(0);
  });

  it.each(PURE_CODE)('passes on %s inside codecs', async (_label, code) => {
    expect(await fenceHits(code, CODECS_FILE)).toBe(0);
  });

  // The adapter proper talks to RPC endpoints; only codecs are fenced. The
  // runtime loader is banned in every package, so it is left out here.
  it.each(NETWORK_CODE.filter(([label]) => !label.includes('loader')))(
    'passes on %s elsewhere in the adapter',
    async (_label, code) => {
      expect(await fenceHits(code, ADAPTER_FILE)).toBe(0);
    },
  );
});
