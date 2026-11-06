// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Proves the number-as-amount ban is wired into the real ESLint config for
// the UI package and the apps. Snippets are linted in memory under a real
// file path, so the scoped config and the type aware parser both apply. The
// types refuse a number too; the lint rule is the second line, for a value
// that reaches a prop through a cast or an any.

import path from 'node:path';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const UI_FILE = path.join(REPO_ROOT, 'packages/ui/src/money/amount-context.tsx');
const UI_TEST_FILE = path.join(REPO_ROOT, 'packages/ui/src/money/amount.test.tsx');
const RULE = 'ujira/no-number-amount';

const HEADER = [
  '// Copyright (c) 2026 Qomira Labs. All rights reserved.',
  '// Proprietary and confidential. Unauthorized copying is prohibited.',
  '',
  "import { Amount } from './amount.js';",
  "import { TokenAmount } from './token-amount.js';",
  "import { formatMoney } from './format.js';",
  '',
].join('\n');

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

async function banErrors(code: string, filePath = UI_FILE): Promise<string[]> {
  const [result] = await eslint.lintText(HEADER + code, { filePath });
  if (result === undefined) throw new Error('ESLint returned no result');
  // A parse failure is also severity 2, so it must never count as the ban.
  expect(result.messages.filter((message) => message.fatal === true)).toEqual([]);
  return result.messages
    .filter((message) => message.severity === 2 && message.ruleId === RULE)
    .map((message) => message.message);
}

// The first lint builds the type checked program for the package, which
// takes a while on a cold cache.
describe('the number amount lint rule', { timeout: 180_000 }, () => {
  it.each([
    ['a float as the value', 'export const a = <Amount value={1.5} />;\n'],
    ['a float as minor units', 'export const a = <Amount minor={1.5} currency="USD" />;\n'],
    ['a whole number as minor units', 'export const a = <Amount minor={96} currency="USD" />;\n'],
    [
      'a number variable',
      'const n: number = 96;\nexport const a = <Amount minor={n} currency="USD" />;\n',
    ],
    [
      'a number cast through unknown',
      'export const a = <Amount minor={96 as unknown as bigint} currency="USD" />;\n',
    ],
    [
      'a number secondary amount',
      'export const a = <Amount minor="96" currency="USD" secondary={0.06} />;\n',
    ],
    ['a number token amount', 'export const a = <TokenAmount value={12.5} />;\n'],
    ['formatMoney of a number', "export const a = formatMoney(1.5, 'USD', 'en');\n"],
  ])('refuses %s', async (_name, code) => {
    expect(await banErrors(code)).toHaveLength(1);
  });

  it('allows bigint minor units, decimal strings and Money', async () => {
    const code = [
      "import { money } from '@ujira/core';",
      'export const a = <Amount minor={9600n} currency="USD" />;',
      'export const b = <Amount minor="9600" currency="USD" />;',
      "export const c = <Amount value={money('9600', 'USD')} />;",
      "export const d = formatMoney(9600n, 'USD', 'en');",
      '',
    ].join('\n');
    expect(await banErrors(code)).toEqual([]);
  });

  it('leaves the non amount props of an amount alone', async () => {
    const code = 'export const a = <Amount minor="96" currency="USD" tabIndex={0} />;\n';
    expect(await banErrors(code)).toEqual([]);
  });

  it('is off in tests, which pass numbers to prove they are refused', async () => {
    expect(await banErrors('export const a = <Amount value={1.5} />;\n', UI_TEST_FILE)).toEqual([]);
  });
});
