// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Proves the float ban is wired into the real ESLint config for the money
// module and only there. Snippets are linted in memory under a real file path
// so the scoped config and the type aware parser both apply.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const MONEY_FILE = path.join(REPO_ROOT, 'packages/core/src/money/money.ts');
const OUTSIDE_FILE = path.join(REPO_ROOT, 'packages/core/src/index.ts');
// A second real file, so a ban narrowed to money.ts alone cannot pass.
const SECOND_MONEY_FILE = path.join(REPO_ROOT, 'packages/core/src/money/currencies.ts');
const MONEY_DIR = path.join(REPO_ROOT, 'packages/core/src/money');

const HEADER = [
  '// Copyright (c) 2026 Qomira Labs. All rights reserved.',
  '// Proprietary and confidential. Unauthorized copying is prohibited.',
  '',
].join('\n');

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

async function errorsFor(code: string, filePath: string): Promise<ESLint.LintResult['messages']> {
  const [result] = await eslint.lintText(HEADER + code, { filePath });
  if (result === undefined) throw new Error('ESLint returned no result');
  // A parse failure is also severity 2, so it must never count as the ban firing.
  const fatal = result.messages.filter((msg) => msg.fatal === true);
  expect(fatal).toEqual([]);
  return result.messages;
}

const ruleErrors = (messages: ESLint.LintResult['messages']): ESLint.LintResult['messages'] =>
  messages.filter((msg) => msg.severity === 2 && msg.ruleId !== null);

// The float ban is built from these core rules. Counting only them means an
// unrelated type aware error (an unsafe any, say) can never stand in for it.
const BAN_RULES = new Set([
  'no-restricted-globals',
  'no-restricted-properties',
  'no-restricted-syntax',
  'ujira/no-number-arithmetic',
]);
const banErrors = (messages: ESLint.LintResult['messages']): ESLint.LintResult['messages'] =>
  ruleErrors(messages).filter((msg) => msg.ruleId !== null && BAN_RULES.has(msg.ruleId));

// Ways around the first version of the ban.
const BYPASSES: [string, string][] = [
  ['global.Math', 'export const x = global.Math.floor(15);\n'],
  ['global.parseFloat', "export const x = global.parseFloat('1.5');\n"],
  ['global.Number', "export const x = global.Number('15');\n"],
  ['an aliased Number', 'const N = Number;\nexport const x: unknown = N;\n'],
  ['globalThis.Math', 'export const x = globalThis.Math.floor(15);\n'],
  ['globalThis.parseFloat', "export const x = globalThis.parseFloat('1.5');\n"],
  ['unary plus on a string literal', "export const x = +'1.5';\n"],
  ['unary plus on a value', 'export const toNumber = (s: string): number => +s;\n'],
  ['number division of a value', 'export const half = (s: number): number => s / 2;\n'],
  ['number division of literals', 'export const x = 5 / 10;\n'],
  ['Number.parseInt', "export const x = Number.parseInt('15', 10);\n"],
  ['parseInt', "export const x = parseInt('15', 10);\n"],
  ['JSON.parse', "export const x: unknown = JSON.parse('1.5');\n"],
];

// Inline config must have no effect in money source, so these still report.
const DISABLE_COMMENTS: [string, string][] = [
  [
    'eslint-disable-next-line',
    '// eslint-disable-next-line no-restricted-syntax\nexport const x = 0.5;\n',
  ],
  ['eslint-disable-line', 'export const x = 0.5; // eslint-disable-line no-restricted-syntax\n'],
  ['block eslint-disable', '/* eslint-disable */\nexport const x = 0.5;\n'],
  [
    'rule scoped eslint-disable',
    "/* eslint-disable no-restricted-globals */\nexport const x = parseFloat('1.5');\n",
  ],
  ['inline rule config', '/* eslint no-restricted-syntax: "off" */\nexport const x = 0.5;\n'],
];

const BANNED: [string, string][] = [
  ['parseFloat', "export const x = parseFloat('1.5');\n"],
  ['Number.parseFloat', "export const x = Number.parseFloat('1.5');\n"],
  ['Number(...)', "export const x = Number('15');\n"],
  ['Number(...) on a bigint', 'export const x = Number(15n);\n'],
  ['Math.floor', 'export const x = Math.floor(15);\n'],
  ['Math.round', 'export const x = Math.round(15);\n'],
  ['Math.max', 'export const x = Math.max(1, 2);\n'],
  ['Math.pow', 'export const x = Math.pow(10, 2);\n'],
  ['Math.PI', 'export const x = Math.PI;\n'],
  ['toFixed', 'export const x = (15).toFixed(2);\n'],
  ['toPrecision', 'export const x = (15).toPrecision(2);\n'],
  ['fractional literal 0.5', 'export const x = 0.5;\n'],
  ['fractional literal 1.25', 'export const x = 1.25;\n'],
  ['fractional literal .5', 'export const x = .5;\n'],
  ['fractional literal 1.0', 'export const x = 1.0;\n'],
  ['negative exponent literal 1e-3', 'export const x = 1e-3;\n'],
  ['negative exponent literal 15E-1', 'export const x = 15E-1;\n'],
];

const ALLOWED: [string, string][] = [
  ['bigint arithmetic', 'export const x = 10n ** 6n * 3n;\n'],
  ['integer literal scale', 'export const scale = 2;\n'],
  [
    'integer validation of a scale',
    'export const ok = (s: number): boolean => Number.isSafeInteger(s) && s >= 0;\n',
  ],
  ['BigInt of a string', "export const x = BigInt('15');\n"],
];

describe('float ban in packages/core/src/money', () => {
  it('rejects parseFloat and fractional literals', async () => {
    const parse = await errorsFor("export const x = parseFloat('1.5');\n", MONEY_FILE);
    const literal = await errorsFor('export const x = 0.5;\n', MONEY_FILE);
    expect(banErrors(parse).length).toBeGreaterThan(0);
    expect(banErrors(literal).length).toBeGreaterThan(0);
  }, 120_000);

  it.each(BANNED)(
    'reports %s as an error',
    async (_label, code) => {
      const messages = await errorsFor(code, MONEY_FILE);
      expect(banErrors(messages).length).toBeGreaterThan(0);
    },
    120_000,
  );

  it.each(BYPASSES)(
    'reports the bypass %s as an error',
    async (_label, code) => {
      const messages = await errorsFor(code, MONEY_FILE);
      expect(banErrors(messages).length).toBeGreaterThan(0);
    },
    120_000,
  );

  it.each(DISABLE_COMMENTS)(
    'still reports the ban under the %s comment',
    async (_label, code) => {
      const messages = await errorsFor(code, MONEY_FILE);
      expect(banErrors(messages).length).toBeGreaterThan(0);
    },
    120_000,
  );

  it.each(ALLOWED)(
    'allows %s',
    async (_label, code) => {
      const messages = await errorsFor(code, MONEY_FILE);
      expect(messages).toEqual([]);
    },
    120_000,
  );

  it.each([...BANNED, ...BYPASSES])(
    'reports %s in a second money source file',
    async (_label, code) => {
      const messages = await errorsFor(code, SECOND_MONEY_FILE);
      expect(banErrors(messages).length).toBeGreaterThan(0);
    },
    120_000,
  );

  // Files that do not exist on disk cannot be parsed with type information,
  // so these check the resolved config instead of linting text.
  // Only *.test.ts files are run by vitest and left out of the build, so any
  // other name, test helpers included, ships and must carry the ban.
  it.each([
    'x.ts',
    'x.tsx',
    'x.mts',
    'x.cts',
    'nested/deeper/x.ts',
    'nested/x.mts',
    'round.test.helpers.ts',
    'nested/x.test.helpers.ts',
    'x.test.mts',
    'x.test.cts',
    'x.test.tsx',
    'x.spec.ts',
  ])(
    'applies the ban and ignores inline config for money/%s',
    async (file) => {
      const config = (await eslint.calculateConfigForFile(path.join(MONEY_DIR, file))) as {
        rules: Record<string, unknown>;
        linterOptions: { noInlineConfig?: boolean };
      };
      for (const rule of BAN_RULES) {
        expect(config.rules[rule]).toBeDefined();
        expect((config.rules[rule] as unknown[])[0]).toBe(2);
      }
      expect(config.linterOptions.noInlineConfig).toBe(true);
    },
    120_000,
  );

  it.each(['x.test.ts', 'nested/x.test.ts', 'nested/deeper/x.test.ts'])(
    'exempts the test file money/%s',
    async (file) => {
      const config = (await eslint.calculateConfigForFile(path.join(MONEY_DIR, file))) as {
        rules: Record<string, unknown>;
      };
      expect(config.rules['ujira/no-number-arithmetic']).toBeUndefined();
    },
    120_000,
  );

  // Each case is reported only by the type aware rule, so dropping any branch
  // of it (compound assignment, unary minus, unions, intersections, generic
  // constraints) makes the matching case go quiet.
  it.each([
    ['number division', 'export const f = (a: number, b: number): number => a / b;\n'],
    [
      'compound division',
      'export const f = (s: number): number => {\n  let x = s;\n  x /= 2;\n  return x;\n};\n',
    ],
    ['unary minus on a number', 'export const f = (s: number): number => -s;\n'],
    ['a union of number literals', 'export const f = (s: 1 | 2): number => s * s;\n'],
    [
      'a branded number intersection',
      "type Cents = number & { readonly brand: 'cents' };\nexport const f = (a: Cents, b: Cents): number => a / b;\n",
    ],
    [
      'a generic constrained to number',
      'export const f = <T extends number>(a: T, b: T): number => a % b;\n',
    ],
  ])(
    'reports %s through ujira/no-number-arithmetic',
    async (_label, code) => {
      const messages = await errorsFor(code, MONEY_FILE);
      const hits = messages.filter((msg) => msg.ruleId === 'ujira/no-number-arithmetic');
      expect(hits.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it.each([
    [
      'bigint division and remainder',
      'export const f = (a: bigint, b: bigint): bigint => (a / b) % b;\n',
    ],
    ['bigint negation', 'export const f = (a: bigint): bigint => -a;\n'],
    ['a negative integer literal', 'export const f = (): -1 => -1;\n'],
  ])(
    'does not report %s',
    async (_label, code) => {
      const messages = await errorsFor(code, MONEY_FILE);
      expect(messages.filter((msg) => msg.ruleId === 'ujira/no-number-arithmetic')).toEqual([]);
    },
    120_000,
  );

  it('fails loudly when type information is missing', async () => {
    // Without types every operand looks unknown, so a quiet pass would let
    // number arithmetic through unnoticed.
    const configUrl = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.js')).href;
    const mod = (await import(configUrl)) as {
      default: readonly { plugins?: Record<string, ESLint.Plugin> }[];
    };
    const plugin = mod.default.find((entry) => entry.plugins?.['ujira'] !== undefined)?.plugins?.[
      'ujira'
    ];
    expect(plugin?.rules?.['no-number-arithmetic']).toBeDefined();
    const linter = new Linter({ configType: 'flat' });
    const rules = { 'ujira/no-number-arithmetic': 'error' } as const;
    const code = 'export const x = 1 / 3;\n';
    expect(() =>
      linter.verify(
        code,
        [{ files: ['**/*.js'], plugins: { ujira: plugin ?? {} }, rules }],
        'x.js',
      ),
    ).toThrow(/needs type information/);
    expect(() =>
      linter.verify(
        code,
        [
          {
            files: ['**/*.ts'],
            languageOptions: { parser: tseslint.parser },
            plugins: { ujira: plugin ?? {} },
            rules,
          },
        ],
        'x.ts',
      ),
    ).toThrow(/needs type information/);
  }, 120_000);

  it('does not apply outside the money module', async () => {
    const messages = await errorsFor('export const x = Math.max(1, 2) + 0.5;\n', OUTSIDE_FILE);
    expect(messages).toEqual([]);
  }, 120_000);
});

// build and snapshot skip the public factory, so only the money module may
// reach them. Everything else must go through money() and the operations.
describe('money internals stay inside the money module', () => {
  const ALLOCATE_FILE = path.join(REPO_ROOT, 'packages/core/src/money/allocate.ts');
  const importErrors = (messages: ESLint.LintResult['messages']): ESLint.LintResult['messages'] =>
    messages.filter((msg) => msg.ruleId === 'no-restricted-imports');

  it.each([
    ['build', "import { build } from './money/money.js';\nexport const b = build;\n"],
    ['snapshot', "import { snapshot } from './money/money.js';\nexport const s = snapshot;\n"],
    [
      'a renamed build',
      "import { build as mint } from './money/money.js';\nexport const b = mint;\n",
    ],
    [
      'a namespace import',
      "import * as internals from './money/money.js';\nexport const m = internals;\n",
    ],
    ['a re-export', "export { build } from './money/money.js';\n"],
  ])(
    'reports %s imported from money.ts outside the money module',
    async (_label, code) => {
      const messages = await errorsFor(code, OUTSIDE_FILE);
      expect(importErrors(messages).length).toBeGreaterThan(0);
    },
    120_000,
  );

  it('allows the public API from money.ts outside the money module', async () => {
    const messages = await errorsFor(
      "import { money } from './money/money.js';\nexport const m = money;\n",
      OUTSIDE_FILE,
    );
    expect(importErrors(messages)).toEqual([]);
  }, 120_000);

  it.each([ALLOCATE_FILE, SECOND_MONEY_FILE])(
    'allows build and snapshot inside the money module at %s',
    async (file) => {
      const messages = await errorsFor(
        "import { build, snapshot } from './money.js';\nexport const b = [build, snapshot];\n",
        file,
      );
      expect(importErrors(messages)).toEqual([]);
    },
    120_000,
  );
});
