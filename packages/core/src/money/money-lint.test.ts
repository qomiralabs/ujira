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
  'no-eval',
  'no-implied-eval',
  'ujira/no-number-conversion',
]);
const banErrors = (messages: ESLint.LintResult['messages']): ESLint.LintResult['messages'] =>
  ruleErrors(messages).filter((msg) => msg.ruleId !== null && BAN_RULES.has(msg.ruleId));

// Ways around the first version of the ban.
const BYPASSES: [string, string][] = [
  // Global object aliases and nesting.
  ['an alias of globalThis', 'const g = globalThis;\nexport const x = g.Math.round(1);\n'],
  ['an alias of global', 'const g = global;\nexport const x = g.Math.round(1);\n'],
  ['computed globalThis access', "export const x: unknown = globalThis['Math'];\n"],
  ['globalThis.global.Math', 'export const x = globalThis.global.Math.round(1);\n'],
  ['global.globalThis.Math', 'export const x = global.globalThis.Math.round(1);\n'],
  // Number reached without calling it directly.
  ['Number.call', "export const x = Number.call(null, '15');\n"],
  ['Number.apply', "export const x = Number.apply(null, ['15']);\n"],
  ['Number.bind', "export const x = Number.bind(null)('15');\n"],
  ['shorthand Number in an object', 'const o = { Number };\nexport const x: unknown = o;\n'],
  ['Number.MAX_VALUE', 'export const x = Number.MAX_VALUE;\n'],
  // Other float sources.
  ['Atomics', 'export const x = Atomics.load(new BigInt64Array(1), 0);\n'],
  ['Float16Array', 'export const x: unknown = new Float16Array(1);\n'],
  ['a Buffer double read', 'export const f = (b: Buffer): number => b.readDoubleLE(0);\n'],
  ['a Buffer float read', 'export const f = (b: Buffer): number => b.readFloatBE(0);\n'],
  [
    'a getFloat64 call on any view',
    'export const f = (v: { getFloat64(o: number): number }): number => v.getFloat64(0);\n',
  ],
  ['a large exponent literal 1e21', 'export const x = 1e21;\n'],
  ['a positive exponent literal 2E+3', 'export const x = 2E+3;\n'],
  // Conversions between number and bigint.
  ['BigInt of a number variable', 'export const f = (n: number): bigint => BigInt(n);\n'],
  ['BigInt of an integer literal', 'export const x = BigInt(15);\n'],
  ['BigInt.asIntN', 'export const x = BigInt.asIntN(64, 2n ** 70n);\n'],
  ['BigInt.asUintN', 'export const x = BigInt.asUintN(64, 2n ** 70n);\n'],
  // Formatting that works on a number.
  ['toLocaleString on a bigint', 'export const x = (15n).toLocaleString();\n'],
  ['Intl formatting of a number', "export const x = new Intl.NumberFormat('en-US').format(15);\n"],
  [
    'Intl formatToParts of a number',
    "export const x = new Intl.NumberFormat('en-US').formatToParts(15);\n",
  ],
  // Runtime loaders that reach code no import rule sees.
  ['a dynamic import of node:module', "export const m: unknown = await import('node:module');\n"],
  ['a dynamic import of module', "export const m: unknown = await import('module');\n"],
  ['a dynamic import of node:vm', "export const m: unknown = await import('node:vm');\n"],
  ['a dynamic import of vm', "export const m: unknown = await import('vm');\n"],
  [
    'a dynamic import of node:worker_threads',
    "export const m: unknown = await import('node:worker_threads');\n",
  ],
  [
    'a dynamic import of worker_threads',
    "export const m: unknown = await import('worker_threads');\n",
  ],
  ['a static import of node:vm', "import vm from 'node:vm';\nexport const v: unknown = vm;\n"],
  ['global.Math', 'export const x = global.Math.floor(15);\n'],
  ['direct eval', "export const x: unknown = eval('Math.round(1.005 * 100)');\n"],
  ['indirect eval', "export const x: unknown = (0, eval)('Math.round(1.005 * 100)');\n"],
  [
    'an eval alias',
    "const run = eval;\nexport const x: unknown = run('Math.round(1.005 * 100)');\n",
  ],
  ['globalThis.eval', "export const x: unknown = globalThis.eval('1.5');\n"],
  ['global.eval', "export const x: unknown = global.eval('1.5');\n"],
  [
    'eval wrapped in BigInt',
    "export const x = BigInt(eval('Math.round(1.005 * 100)') as string);\n",
  ],
  ['Reflect.get on globalThis', "export const x: unknown = Reflect.get(globalThis, 'Math');\n"],
  ['globalThis.Reflect', "export const x: unknown = globalThis.Reflect.get(globalThis, 'Math');\n"],
  ['Float64Array', 'export const x = new Float64Array(1);\n'],
  ['Float32Array', 'export const x = new Float32Array(1);\n'],
  ['DataView', 'export const x = new DataView(new ArrayBuffer(8));\n'],
  ['performance.now', 'export const x = performance.now();\n'],
  ['Number.EPSILON', 'export const x = Number.EPSILON;\n'],
  ['Number.MIN_VALUE', 'export const x = Number.MIN_VALUE;\n'],
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
  ['an object key named Number', 'export const x = { Number: 1n };\n'],
  ['a type member named Number', 'export interface Row {\n  Number: bigint;\n}\n'],
  [
    'Intl formatting of a numeric string',
    "export const x = new Intl.NumberFormat('en-US').format('15' as `${number}`);\n",
  ],
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

  it('makes the number conversion rule fail loudly when type information is missing', async () => {
    const configUrl = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.js')).href;
    const mod = (await import(configUrl)) as {
      default: readonly { plugins?: Record<string, ESLint.Plugin> }[];
    };
    const plugin = mod.default.find((entry) => entry.plugins?.['ujira'] !== undefined)?.plugins?.[
      'ujira'
    ];
    expect(plugin?.rules?.['no-number-conversion']).toBeDefined();
    const linter = new Linter({ configType: 'flat' });
    expect(() =>
      linter.verify(
        'export const x = BigInt(1);\n',
        [
          {
            files: ['**/*.js'],
            plugins: { ujira: plugin ?? {} },
            rules: { 'ujira/no-number-conversion': 'error' },
          },
        ],
        'x.js',
      ),
    ).toThrow(/needs type information/);
  }, 120_000);

  it('does not apply outside the money module', async () => {
    const messages = await errorsFor('export const x = Math.max(1, 2) + 0.5;\n', OUTSIDE_FILE);
    expect(messages).toEqual([]);
  }, 120_000);
});

// process reaches getBuiltinModule, and through it createRequire and vm. A
// property ban on process.getBuiltinModule only sees that exact spelling, so
// money source may not touch process at all, under any name.
const PROCESS_FIXTURES: [string, string][] = [
  [
    'process-alias.ts',
    "const p = process;\nexport const m: unknown = p.getBuiltinModule('node:module');\n",
  ],
  [
    'a destructured getBuiltinModule',
    "const { getBuiltinModule } = process;\nexport const m: unknown = getBuiltinModule('node:vm');\n",
  ],
  [
    'process passed as a value',
    'export const keep = (p: unknown): unknown => p;\nkeep(process);\n',
  ],
  [
    'process.getBuiltinModule',
    "export const m: unknown = process.getBuiltinModule('node:module');\n",
  ],
  [
    'globalThis.process',
    "export const m: unknown = globalThis.process.getBuiltinModule('node:vm');\n",
  ],
  ['global.process', "export const m: unknown = global.process.getBuiltinModule('node:vm');\n"],
  [
    'an alias of globalThis.process',
    'const g = globalThis;\nexport const p: unknown = g.process;\n',
  ],
];

describe('process is unreachable from money source', () => {
  it.each(PROCESS_FIXTURES)(
    'reports %s',
    async (_label, code) => {
      for (const file of [MONEY_FILE, SECOND_MONEY_FILE]) {
        const messages = await errorsFor(code, file);
        expect(banErrors(messages).length).toBeGreaterThan(0);
      }
    },
    120_000,
  );

  it('names process in the restricted globals of every money source file', async () => {
    for (const file of ['money.ts', 'nested/x.ts', 'x.mts'].map((f) => path.join(MONEY_DIR, f))) {
      const config = (await eslint.calculateConfigForFile(file)) as {
        rules: Record<string, unknown[] | undefined>;
      };
      const names = (config.rules['no-restricted-globals'] ?? [])
        .slice(1)
        .map((entry) => (entry as { name?: unknown }).name);
      expect(names).toContain('process');
    }
  }, 120_000);
});

// eval runs code no rule can see, so it is banned in every file, not only in
// money source.
describe('eval is banned across the repo', () => {
  const ROOT_FILE = path.join(REPO_ROOT, 'vitest.config.ts');
  const SCRIPT_FILE = path.join(REPO_ROOT, 'scripts/check-licenses.ts');

  it.each([OUTSIDE_FILE, ROOT_FILE, SCRIPT_FILE])(
    'turns on no-eval and no-implied-eval for %s',
    async (file) => {
      const config = (await eslint.calculateConfigForFile(file)) as {
        rules: Record<string, unknown>;
      };
      for (const rule of ['no-eval', 'no-implied-eval']) {
        expect((config.rules[rule] as unknown[] | undefined)?.[0]).toBe(2);
      }
    },
    120_000,
  );

  it.each([
    ['direct eval', "export const x: unknown = eval('1');\n"],
    ['indirect eval', "export const x: unknown = (0, eval)('1');\n"],
  ])(
    'reports %s outside the money module',
    async (_label, code) => {
      for (const file of [OUTSIDE_FILE, ROOT_FILE]) {
        const messages = await errorsFor(code, file);
        expect(messages.filter((msg) => msg.ruleId === 'no-eval').length).toBeGreaterThan(0);
      }
    },
    120_000,
  );
});

// Outside the money module the fence keeps build and snapshot out of reach.
// Runtime loaders and the process object can reach any file by path, and an
// inline disable comment must not switch the fence off.
describe('the import fence closes runtime loaders', () => {
  const restricted = (messages: ESLint.LintResult['messages']): ESLint.LintResult['messages'] =>
    messages.filter(
      (msg) =>
        msg.ruleId === 'no-restricted-syntax' ||
        msg.ruleId === 'no-restricted-properties' ||
        msg.ruleId === 'no-restricted-imports',
    );

  it.each([
    ['node:module', "export const m: unknown = await import('node:module');\n"],
    ['module', "export const m: unknown = await import('module');\n"],
    ['node:vm', "export const m: unknown = await import('node:vm');\n"],
    ['vm', "export const m: unknown = await import('vm');\n"],
    ['node:worker_threads', "export const m: unknown = await import('node:worker_threads');\n"],
    ['worker_threads', "export const m: unknown = await import('worker_threads');\n"],
    ['a static node:vm import', "import vm from 'node:vm';\nexport const v: unknown = vm;\n"],
    [
      'a static worker_threads import',
      "import { Worker } from 'node:worker_threads';\nexport const w: unknown = Worker;\n",
    ],
    [
      'globalThis.process',
      "export const m: unknown = globalThis.process.getBuiltinModule('node:module');\n",
    ],
    [
      'global.process',
      "export const m: unknown = global.process.getBuiltinModule('node:module');\n",
    ],
  ])(
    'reports %s outside the money module',
    async (_label, code) => {
      const messages = await errorsFor(code, OUTSIDE_FILE);
      expect(restricted(messages).length).toBeGreaterThan(0);
    },
    120_000,
  );

  it.each([
    [
      'eslint-disable-next-line',
      "// eslint-disable-next-line no-restricted-syntax\nexport const m: unknown = await import('node:vm');\n",
    ],
    [
      'block eslint-disable',
      "/* eslint-disable */\nexport const m: unknown = await import('node:module');\n",
    ],
  ])(
    'ignores a %s comment in fenced source',
    async (_label, code) => {
      const messages = await errorsFor(code, OUTSIDE_FILE);
      expect(restricted(messages).length).toBeGreaterThan(0);
    },
    120_000,
  );

  it('sets noInlineConfig for fenced source', async () => {
    const config = (await eslint.calculateConfigForFile(OUTSIDE_FILE)) as {
      linterOptions: { noInlineConfig?: boolean };
    };
    expect(config.linterOptions.noInlineConfig).toBe(true);
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
    ...['buildToken', 'withAmount', 'snapshotFiat', 'snapshotToken'].map(
      (name): [string, string] => [
        name,
        `import { ${name} } from './money/money.js';\nexport const x = ${name};\n`,
      ],
    ),
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

  // Each of these passed lint and typecheck before the fence covered them.
  // Any rule that blocks the path counts, since the point is that none lints clean.
  const FENCE_RULES = new Set([
    'no-restricted-imports',
    'no-restricted-syntax',
    'no-restricted-properties',
    '@typescript-eslint/no-require-imports',
  ]);
  const fenceErrors = (messages: ESLint.LintResult['messages']): ESLint.LintResult['messages'] =>
    messages.filter((msg) => msg.ruleId !== null && FENCE_RULES.has(msg.ruleId));

  it.each([
    [
      'an awaited dynamic import',
      "const internals = await import('./money/money.js');\nexport const b: unknown = internals;\n",
    ],
    [
      'a dynamic import with then',
      "export const p = import('./money/money.js').then((m) => m.snapshot);\n",
    ],
    [
      'a dynamic import of money.ts',
      "export const p: Promise<unknown> = import('./money/money.ts');\n",
    ],
    [
      'a dynamic import with a dot segment',
      "export const p: Promise<unknown> = import('./money/./money.js');\n",
    ],
    [
      'a dynamic import with a doubled slash',
      "export const p: Promise<unknown> = import('./money//money.js');\n",
    ],
    [
      'a dynamic import from a template literal',
      'export const p: Promise<unknown> = import(`./money/money.js`);\n',
    ],
    [
      'a dynamic import from a computed path',
      "const where = './money/' + 'money.js';\nexport const p: Promise<unknown> = import(where);\n",
    ],
    [
      'a static import with a dot segment',
      "import { build } from './money/./money.js';\nexport const b = build;\n",
    ],
    [
      'a static import with a doubled slash',
      "import { build } from './money//money.js';\nexport const b = build;\n",
    ],
    [
      'a static import with a parent dot segment',
      "import { snapshot } from '../src/money/./money.js';\nexport const s = snapshot;\n",
    ],
    [
      'a static import with different casing',
      "import { build } from './Money/MONEY.js';\nexport const b = build;\n",
    ],
    [
      'a dynamic import with different casing',
      "export const p: Promise<unknown> = import('./Money/money.JS');\n",
    ],
    [
      'createRequire from node:module',
      "import { createRequire } from 'node:module';\nexport const m: unknown = createRequire(import.meta.url)('./money/money.js');\n",
    ],
    [
      'createRequire from module',
      "import { createRequire } from 'module';\nexport const r = createRequire;\n",
    ],
    [
      'a namespace import of node:module',
      "import * as nodeModule from 'node:module';\nexport const r = nodeModule.createRequire;\n",
    ],
    [
      'a default import of node:module',
      "import nodeModule from 'node:module';\nexport const r = nodeModule.createRequire;\n",
    ],
    [
      'node:module through getBuiltinModule',
      "export const m: unknown = process.getBuiltinModule('node:module');\n",
    ],
    ['require', "export const m: unknown = require('./money/money.js');\n"],
  ])(
    'reports %s outside the money module',
    async (_label, code) => {
      const messages = await errorsFor(code, OUTSIDE_FILE);
      expect(fenceErrors(messages).length).toBeGreaterThan(0);
    },
    120_000,
  );

  it.each([
    [
      'a dynamic import of the public money index',
      "export const p: Promise<unknown> = import('./money/index.js');\n",
    ],
    ['a dynamic import of a package', "export const p: Promise<unknown> = import('node:path');\n"],
    [
      'a static import of a sibling named like money',
      "import { money } from './money/index.js';\nexport const m = money;\n",
    ],
  ])(
    'allows %s outside the money module',
    async (_label, code) => {
      const messages = await errorsFor(code, OUTSIDE_FILE);
      expect(fenceErrors(messages)).toEqual([]);
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
