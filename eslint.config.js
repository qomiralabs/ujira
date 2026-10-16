// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const HEADER = [
  '// Copyright (c) 2026 Qomira Labs. All rights reserved.',
  '// Proprietary and confidential. Unauthorized copying is prohibited.',
];

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
        const ok = HEADER.every((expected, i) => lines[i] === expected);
        if (!ok) {
          context.report({
            loc: { line: 1, column: 0 },
            messageId: 'missing',
            data: { header: HEADER.join('\n') },
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
);
