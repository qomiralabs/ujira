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
    expect(ruleErrors(parse).length).toBeGreaterThan(0);
    expect(ruleErrors(literal).length).toBeGreaterThan(0);
  }, 120_000);

  it.each(BANNED)(
    'reports %s as an error',
    async (_label, code) => {
      const messages = await errorsFor(code, MONEY_FILE);
      expect(ruleErrors(messages).length).toBeGreaterThan(0);
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

  it('does not apply outside the money module', async () => {
    const messages = await errorsFor('export const x = Math.max(1, 2) + 0.5;\n', OUTSIDE_FILE);
    expect(messages).toEqual([]);
  }, 120_000);
});
