// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
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
      ujira: { rules: { 'license-header': licenseHeader } },
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
    files: ['packages/core/src/money/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money never uses floats. Parse amounts as bigint.' },
        { name: 'Math', message: 'Math works on floats. Use bigint arithmetic.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Money never uses floats. Parse amounts as bigint.',
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
