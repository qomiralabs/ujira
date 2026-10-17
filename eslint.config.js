// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript';
import tseslint from 'typescript-eslint';

// The year on the copyright line is the year the file was created, so any
// four digit year is accepted. Everything else must match exactly.
const HEADER_PATTERNS = [
  /^\/\/ Copyright \(c\) \d{4} Qomira Labs\. All rights reserved\.$/,
  /^\/\/ Proprietary and confidential\. Unauthorized copying is prohibited\.$/,
];

const HEADER_EXAMPLE = [
  `// Copyright (c) ${String(new Date().getFullYear())} Qomira Labs. All rights reserved.`,
  '// Proprietary and confidential. Unauthorized copying is prohibited.',
].join('\n');

/** @type {import('eslint').Rule.RuleModule} */
const licenseHeader = {
  meta: {
    type: 'problem',
    docs: { description: 'Require the proprietary license header at the top of every source file' },
    schema: [],
    messages: {
      missing: 'Missing proprietary license header. The file must start with:\n{{header}}',
    },
  },
  create(context) {
    return {
      Program() {
        const lines = context.sourceCode.lines;
        const ok = HEADER_PATTERNS.every((pattern, i) => pattern.test(lines[i] ?? ''));
        if (!ok) {
          context.report({
            loc: { line: 1, column: 0 },
            messageId: 'missing',
            data: { header: HEADER_EXAMPLE },
          });
        }
      },
    };
  },
};

const ARITHMETIC_OPERATORS = new Set(['+', '-', '*', '/', '%', '**']);
const COMPOUND_OPERATORS = new Set(['+=', '-=', '*=', '/=', '%=', '**=']);

/**
 * Bigint division truncates, number division can return a fraction, and both
 * use the same `/`. Only the operand types tell them apart, so this asks the
 * type checker instead of banning the operator outright.
 * @type {import('eslint').Rule.RuleModule}
 */
const noNumberArithmetic = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow arithmetic on number operands, which can produce floats' },
    schema: [],
    messages: {
      number: 'Arithmetic on a number can produce a float. Use bigint minor units.',
    },
  },
  create(context) {
    /** @type {unknown} */
    const rawServices = context.sourceCode.parserServices;
    const services =
      /** @type {{ program?: ts.Program | null, esTreeNodeToTSNodeMap?: { get(node: unknown): ts.Node } } | undefined} */ (
        rawServices
      );
    const program = services?.program;
    const nodeMap = services?.esTreeNodeToTSNodeMap;
    if (!program || !nodeMap) {
      // Silently passing without types would let every float through.
      throw new Error('ujira/no-number-arithmetic needs type information');
    }
    const checker = program.getTypeChecker();

    /** @param {ts.Type} type @returns {boolean} */
    const involvesNumber = (type) => {
      const resolved = checker.getBaseConstraintOfType(type) ?? type;
      // A branded number such as `number & { brand: 'cents' }` is still a number.
      if (resolved.isUnion() || resolved.isIntersection()) {
        return resolved.types.some(involvesNumber);
      }
      return (resolved.flags & ts.TypeFlags.NumberLike) !== 0;
    };
    /** @param {unknown} node @returns {boolean} */
    const isNumber = (node) => involvesNumber(checker.getTypeAtLocation(nodeMap.get(node)));

    return {
      BinaryExpression(node) {
        if (!ARITHMETIC_OPERATORS.has(node.operator)) return;
        if (isNumber(node.left) || isNumber(node.right)) {
          context.report({ node, messageId: 'number' });
        }
      },
      AssignmentExpression(node) {
        if (!COMPOUND_OPERATORS.has(node.operator)) return;
        if (isNumber(node.left) || isNumber(node.right)) {
          context.report({ node, messageId: 'number' });
        }
      },
      UnaryExpression(node) {
        if (node.operator !== '+' && node.operator !== '-') return;
        // A negative integer constant such as -1 is a value, not a computation.
        // Fractional literals are caught by the literal ban.
        const arg = node.argument;
        if (node.operator === '-' && arg.type === 'Literal' && typeof arg.value === 'number') {
          return;
        }
        if (isNumber(arg)) context.report({ node, messageId: 'number' });
      },
    };
  },
};

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.turbo/**'],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      ujira: {
        rules: { 'license-header': licenseHeader, 'no-number-arithmetic': noNumberArithmetic },
      },
    },
    rules: {
      'ujira/license-header': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'no-console': 'warn',
    },
  },
  {
    // Money is integer minor units held in bigint. Anything that can produce a
    // binary float is banned here so a rounding bug cannot get in by accident.
    // Tests are exempt because they feed floats in to prove they are rejected.
    files: ['packages/core/src/money/**/*.{ts,tsx,mts,cts}'],
    ignores: ['**/*.test.ts'],
    // A disable comment in money source would switch the ban off for one line
    // without review, so inline config is ignored here.
    linterOptions: { noInlineConfig: true },
    rules: {
      'ujira/no-number-arithmetic': 'error',
      // eval and its relatives run code no rule here can see, so a float
      // computation hidden in a string would pass every other check.
      'no-eval': ['error', { allowIndirect: false }],
      'no-implied-eval': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money never uses floats. Parse amounts as bigint.' },
        { name: 'Math', message: 'Math works on floats. Use bigint arithmetic.' },
        { name: 'parseInt', message: 'parseInt returns a number. Parse amounts as bigint.' },
        { name: 'eval', message: 'eval runs code the float ban cannot check.' },
        { name: 'Reflect', message: 'Reflect can fetch banned globals by name.' },
        { name: 'Float32Array', message: 'Float arrays hold floats. Use bigint.' },
        { name: 'Float64Array', message: 'Float arrays hold floats. Use bigint.' },
        { name: 'DataView', message: 'DataView reads floats from bytes. Use bigint.' },
        { name: 'performance', message: 'performance.now returns a float.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Money never uses floats. Parse amounts as bigint.',
        },
        {
          object: 'Number',
          property: 'parseInt',
          message: 'Number.parseInt returns a number. Parse amounts as bigint.',
        },
        {
          object: 'globalThis',
          property: 'parseFloat',
          message: 'Money never uses floats. Parse amounts as bigint.',
        },
        {
          object: 'globalThis',
          property: 'parseInt',
          message: 'parseInt returns a number. Parse amounts as bigint.',
        },
        {
          object: 'globalThis',
          property: 'Math',
          message: 'Math works on floats. Use bigint arithmetic.',
        },
        {
          object: 'globalThis',
          property: 'Number',
          message: 'Number converts to a float. Keep amounts as bigint.',
        },
        {
          object: 'global',
          property: 'parseFloat',
          message: 'Money never uses floats. Parse amounts as bigint.',
        },
        {
          object: 'global',
          property: 'parseInt',
          message: 'parseInt returns a number. Parse amounts as bigint.',
        },
        {
          object: 'global',
          property: 'Math',
          message: 'Math works on floats. Use bigint arithmetic.',
        },
        {
          object: 'global',
          property: 'Number',
          message: 'Number converts to a float. Keep amounts as bigint.',
        },
        {
          object: 'globalThis',
          property: 'eval',
          message: 'eval runs code the float ban cannot check.',
        },
        {
          object: 'global',
          property: 'eval',
          message: 'eval runs code the float ban cannot check.',
        },
        {
          object: 'globalThis',
          property: 'Reflect',
          message: 'Reflect can fetch banned globals by name.',
        },
        {
          object: 'Number',
          property: 'EPSILON',
          message: 'Number.EPSILON is a float.',
        },
        {
          object: 'Number',
          property: 'MIN_VALUE',
          message: 'Number.MIN_VALUE is a float.',
        },
        {
          object: 'Number',
          property: 'MAX_VALUE',
          message: 'Number.MAX_VALUE is past the safe integer range.',
        },
        {
          object: 'JSON',
          property: 'parse',
          message: 'JSON.parse turns numeric text into floats. Validate and parse to bigint.',
        },
        { property: 'toFixed', message: 'toFixed rounds a float. Format from bigint instead.' },
        {
          property: 'toPrecision',
          message: 'toPrecision rounds a float. Format from bigint instead.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.type="Identifier"][callee.name="Number"]',
          message: 'Number(...) converts to a float. Keep amounts as bigint.',
        },
        {
          selector: 'NewExpression[callee.type="Identifier"][callee.name="Number"]',
          message: 'Number(...) converts to a float. Keep amounts as bigint.',
        },
        {
          // Catches aliasing such as `const N = Number`; member access like
          // Number.isSafeInteger stays allowed.
          selector:
            'Identifier[name="Number"]:not(MemberExpression > Identifier.object):not(MemberExpression[computed=false] > Identifier.property):not(CallExpression > Identifier.callee):not(NewExpression > Identifier.callee)',
          message: 'Number used as a value converts to a float. Keep amounts as bigint.',
        },
        {
          selector: 'UnaryExpression[operator="+"]',
          message: 'Unary plus converts to a number. Parse amounts as bigint.',
        },
        {
          // Matches the raw source text, so digits inside strings never match.
          selector: 'Literal[raw=/^[0-9_]*[.][0-9_]*([eE][-+]?[0-9_]+)?$/]',
          message: 'Fractional numeric literals are floats. Use bigint minor units.',
        },
        {
          selector: 'Literal[raw=/^[0-9_]+[eE][-][0-9_]+$/]',
          message: 'Negative exponent literals are floats. Use bigint minor units.',
        },
      ],
    },
  },
);
