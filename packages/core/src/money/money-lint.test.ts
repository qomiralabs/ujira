// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Proves the float ban is wired into the real ESLint config for the money
// module and only there. Snippets are linted in memory under a real file path
// so the scoped config and the type aware parser both apply.

import path from 'node:path';

import { ESLint } from 'eslint';
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

  it('does not apply outside the money module', async () => {
    const messages = await errorsFor('export const x = Math.max(1, 2) + 0.5;\n', OUTSIDE_FILE);
    expect(messages).toEqual([]);
  }, 120_000);
});
