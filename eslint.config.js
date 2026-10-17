// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript';
import tseslint from 'typescript-eslint';

import { isChainModule } from './packages/chain-adapter/src/chain-modules.ts';
import { lintProjects } from './scripts/workspace.ts';

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

// Matches money.ts however the path is spelled: dot segments, doubled
// slashes, any casing, with or without an extension. Slashes are written as
// \x2F because the selector parser ends a regex at the first bare slash, and
// one pattern serves both the static and the dynamic import rules.
const MONEY_INTERNALS_SELECTOR = String.raw`(^|\x2F)money\x2F+(\.\x2F+)*money(\.d)?(\.[cm]?[jt]s)?$`;
const MONEY_INTERNALS_PATH = new RegExp(MONEY_INTERNALS_SELECTOR, 'i');
const CREATE_REQUIRE_MESSAGE =
  'createRequire loads modules by path past the import fence. Use a static import.';

const RUNTIME_LOADERS_MESSAGE =
  'node:module, vm and worker_threads load or run code past every lint rule. Use a static import.';
// node:module, vm and worker_threads, with or without the node: prefix.
const RUNTIME_LOADERS_SELECTOR = String.raw`^(node:)?(module|vm|worker_threads)$`;

/**
 * Returns a predicate telling whether an ESTree node has a number type,
 * including unions, intersections and generics constrained to number.
 * Throws when the file was parsed without type information, because a rule
 * that silently passes then would let every float through.
 * @param {import('eslint').Rule.RuleContext} context
 * @param {string} ruleName
 * @returns {(node: unknown) => boolean}
 */
function numberTypeOracle(context, ruleName) {
  /** @type {unknown} */
  const rawServices = context.sourceCode.parserServices;
  const services =
    /** @type {{ program?: ts.Program | null, esTreeNodeToTSNodeMap?: { get(node: unknown): ts.Node } } | undefined} */ (
      rawServices
    );
  const program = services?.program;
  const nodeMap = services?.esTreeNodeToTSNodeMap;
  if (!program || !nodeMap) {
    throw new Error(`${ruleName} needs type information`);
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
  return (node) => involvesNumber(checker.getTypeAtLocation(nodeMap.get(node)));
}

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
    const isNumber = numberTypeOracle(context, 'ujira/no-number-arithmetic');

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

const FORMAT_METHODS = new Set(['format', 'formatToParts', 'formatRange', 'formatRangeToParts']);

/**
 * BigInt(n) of a number is only exact when n already is, and Intl rounds a
 * number argument through a binary float before it formats. A string or a
 * bigint argument is exact, so only number typed arguments are reported.
 * @type {import('eslint').Rule.RuleModule}
 */
const noNumberConversion = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow BigInt of a number and formatting a number' },
    schema: [],
    messages: {
      bigint: 'BigInt of a number is only as exact as the number. Parse from a string instead.',
      format: 'Formatting a number rounds through a float. Pass an exact decimal string.',
    },
  },
  create(context) {
    const isNumber = numberTypeOracle(context, 'ujira/no-number-conversion');
    return {
      CallExpression(node) {
        const { callee } = node;
        const args = node.arguments.filter((arg) => arg.type !== 'SpreadElement');
        if (callee.type === 'Identifier' && callee.name === 'BigInt') {
          const [first] = args;
          if (first !== undefined && isNumber(first)) {
            context.report({ node, messageId: 'bigint' });
          }
          return;
        }
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          FORMAT_METHODS.has(callee.property.name) &&
          args.some((arg) => isNumber(arg))
        ) {
          context.report({ node, messageId: 'format' });
        }
      },
    };
  },
};

// Chain names, the CAIP-2 IDs of the networks UJIRA runs on (and the
// retired Alfajores testnet), and the same Celo chain IDs as numbers.
const CHAIN_NAME = /^(?:stellar|celo|stellar:(?:pubnet|testnet)|eip155:(?:42220|44787|11142220))$/;
const CHAIN_IDS = new Set(['42220', '44787', '11142220']);
const EQUALITY_OPERATORS = new Set(['==', '===', '!=', '!==']);
const MEMBERSHIP_METHODS = new Set(['includes', 'has', 'indexOf', 'lastIndexOf']);
// Type only wrappers that leave the value as it was.
const WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
]);
// Enough for any honest chain of const aliases, and a bound on hostile ones.
const MAX_ALIAS_DEPTH = 8;

/** @typedef {{ type: string } & Record<string, unknown>} AstNode */

/** @param {unknown} value @returns {value is AstNode} */
function isNode(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (/** @type {{ type?: unknown }} */ (value).type) === 'string'
  );
}

/** @param {unknown} node @param {string} key @returns {AstNode | undefined} */
function child(node, key) {
  const value = isNode(node) ? node[key] : undefined;
  return isNode(value) ? value : undefined;
}

/** @param {unknown} node @param {string} key @returns {AstNode[]} */
function children(node, key) {
  const value = isNode(node) ? node[key] : undefined;
  return Array.isArray(value) ? value.filter(isNode) : [];
}

/** @param {unknown} node @param {string} key @returns {unknown} */
function field(node, key) {
  return isNode(node) ? node[key] : undefined;
}

/** @param {unknown} node @returns {AstNode | undefined} */
function unwrap(node) {
  let current = isNode(node) ? node : undefined;
  while (current !== undefined && WRAPPERS.has(current.type)) {
    current = child(current, 'expression');
  }
  return current;
}

/**
 * Follows type wrappers and const bindings in this file to the expression
 * that gives the value, so `const CELO = 'celo'` compares like 'celo' does.
 * @param {import('eslint').Rule.RuleContext} context
 * @param {unknown} node
 * @returns {AstNode | undefined}
 */
function resolve(context, node) {
  let current = unwrap(node);
  for (let depth = 0; depth < MAX_ALIAS_DEPTH && current?.type === 'Identifier'; depth += 1) {
    const name = field(current, 'name');
    let scope = /** @type {import('eslint').Scope.Scope | null} */ (
      context.sourceCode.getScope(
        /** @type {import('eslint').Rule.Node} */ (/** @type {unknown} */ (current)),
      )
    );
    let variable;
    while (scope !== null && variable === undefined) {
      variable = typeof name === 'string' ? scope.set.get(name) : undefined;
      scope = scope.upper;
    }
    const [definition] = variable?.defs ?? [];
    if (
      definition === undefined ||
      variable?.defs.length !== 1 ||
      definition.type !== 'Variable' ||
      field(definition.parent, 'kind') !== 'const'
    ) {
      return current;
    }
    const init = unwrap(field(definition.node, 'init'));
    if (init === undefined) return current;
    current = init;
  }
  return current;
}

/** @param {AstNode | undefined} node @returns {string | undefined} */
function staticString(node) {
  if (node?.type === 'Literal' && typeof node['value'] === 'string') return node['value'];
  if (node?.type === 'TemplateLiteral' && children(node, 'expressions').length === 0) {
    // The quasi's value is a plain { raw, cooked } record, not a node.
    const quasi = /** @type {{ value?: { cooked?: unknown } } | undefined} */ (
      children(node, 'quasis')[0]
    );
    const cooked = quasi?.value?.cooked;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  return undefined;
}

/**
 * @param {import('eslint').Rule.RuleContext} context
 * @param {unknown} node
 */
function isChainLiteral(context, node) {
  const value = resolve(context, node);
  const text = staticString(value);
  if (text !== undefined) return CHAIN_NAME.test(text);
  if (value?.type !== 'Literal') return false;
  if (typeof value['bigint'] === 'string') return CHAIN_IDS.has(value['bigint']);
  return typeof value['value'] === 'number' && CHAIN_IDS.has(String(value['value']));
}

/**
 * Whether an array, a Set or Map built from one, or an object literal holds
 * a chain or network literal as an element or key.
 * @param {import('eslint').Rule.RuleContext} context
 * @param {unknown} node
 * @returns {boolean}
 */
function holdsChainLiteral(context, node) {
  const value = resolve(context, node);
  if (value?.type === 'ArrayExpression') {
    return children(value, 'elements').some(
      (element) => isChainLiteral(context, element) || holdsChainLiteral(context, element),
    );
  }
  if (value?.type === 'NewExpression') {
    const callee = field(child(value, 'callee'), 'name');
    return (
      (callee === 'Set' || callee === 'Map') &&
      holdsChainLiteral(context, children(value, 'arguments')[0])
    );
  }
  if (value?.type === 'ObjectExpression') {
    return children(value, 'properties').some((property) => {
      const key = child(property, 'key');
      if (field(property, 'computed') === true) return isChainLiteral(context, key);
      const name = key?.type === 'Identifier' ? field(key, 'name') : field(key, 'value');
      return typeof name === 'string' && CHAIN_NAME.test(name);
    });
  }
  return false;
}

/**
 * require in every spelling that loads a module by name: the global, an
 * alias of it, module.require, and the function createRequire returns.
 * @param {import('eslint').Rule.RuleContext} context
 * @param {unknown} callee
 */
function isRequire(context, callee) {
  const direct = unwrap(callee);
  if (direct?.type === 'Identifier' && field(direct, 'name') === 'require') return true;
  if (
    direct?.type === 'MemberExpression' &&
    field(child(direct, 'object'), 'name') === 'module' &&
    field(child(direct, 'property'), 'name') === 'require'
  ) {
    return true;
  }
  const value = resolve(context, callee);
  if (value?.type === 'Identifier') return field(value, 'name') === 'require';
  if (value?.type === 'CallExpression') {
    const inner = unwrap(child(value, 'callee'));
    const name =
      inner?.type === 'MemberExpression'
        ? field(child(inner, 'property'), 'name')
        : field(inner, 'name');
    return name === 'createRequire';
  }
  return false;
}

/**
 * Keeps chain knowledge inside the chain adapter: no chain SDK or ABI import
 * and no branch on a chain or network value anywhere else. A comparison
 * against 'stellar' is how a second chain path starts; the adapter interface
 * is where that difference belongs.
 *
 * The rule reads syntax, not types. It sees literals however they are
 * wrapped and through const bindings in the same file, but not a constant
 * imported from another module, a value built by concatenation or by a
 * string method, or a lookup through a Map or a function.
 * @type {import('eslint').Rule.RuleModule}
 */
const noChainBranching = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep chain SDKs and chain comparisons inside the chain adapter' },
    schema: [],
    messages: {
      sdk: 'Chain SDKs and ABIs load only in packages/chain-adapter. Call the adapter instead.',
      compare:
        'Branching on a chain or network belongs in packages/chain-adapter. Ask the adapter or the router config instead.',
    },
  },
  create(context) {
    /** @param {unknown} node @param {'sdk' | 'compare'} messageId */
    const report = (node, messageId) => {
      context.report({ node: /** @type {import('eslint').Rule.Node} */ (node), messageId });
    };
    /** @param {unknown} source @param {unknown} node */
    const checkModule = (source, node) => {
      const name = staticString(resolve(context, source));
      if (name !== undefined && isChainModule(name)) report(node, 'sdk');
    };
    // ESLint's own node types stop at ESTree, so the TypeScript only forms
    // are read through the generic accessors above.
    return {
      ImportDeclaration(node) {
        checkModule(node.source, node);
      },
      ExportNamedDeclaration(node) {
        checkModule(node.source, node);
      },
      ExportAllDeclaration(node) {
        checkModule(node.source, node);
      },
      ImportExpression(node) {
        checkModule(node.source, node);
      },
      /** @param {unknown} node */
      TSImportType(node) {
        checkModule(child(node, 'source') ?? child(child(node, 'argument'), 'literal'), node);
      },
      /** @param {unknown} node */
      TSExternalModuleReference(node) {
        checkModule(child(node, 'expression'), node);
      },
      CallExpression(node) {
        const { callee } = node;
        if (isRequire(context, callee)) {
          checkModule(node.arguments[0], node);
          return;
        }
        const target = unwrap(callee);
        if (target?.type !== 'MemberExpression' || field(target, 'computed') === true) return;
        const method = field(child(target, 'property'), 'name');
        const object = child(target, 'object');
        if (method === 'is' && field(object, 'name') === 'Object') {
          if (node.arguments.some((arg) => isChainLiteral(context, arg))) report(node, 'compare');
          return;
        }
        if (typeof method !== 'string' || !MEMBERSHIP_METHODS.has(method)) return;
        if (
          node.arguments.some((arg) => isChainLiteral(context, arg)) ||
          holdsChainLiteral(context, object)
        ) {
          report(node, 'compare');
        }
      },
      MemberExpression(node) {
        if (node.computed) {
          if (isChainLiteral(context, node.property) || holdsChainLiteral(context, node.object)) {
            report(node, 'compare');
          }
          return;
        }
        const name = field(node.property, 'name');
        if (typeof name === 'string' && CHAIN_NAME.test(name)) report(node, 'compare');
      },
      BinaryExpression(node) {
        if (!EQUALITY_OPERATORS.has(node.operator)) return;
        if (isChainLiteral(context, node.left) || isChainLiteral(context, node.right)) {
          report(node, 'compare');
        }
      },
      SwitchCase(node) {
        if (isChainLiteral(context, node.test)) report(node, 'compare');
      },
    };
  },
};

export default defineConfig(
  {
    // Output folders only where the tools write them, at the root and at each
    // member root. The same names deeper in a member are source and linted.
    ignores: [
      '**/node_modules/**',
      'coverage/**',
      '.turbo/**',
      'packages/*/dist/**',
      'packages/*/coverage/**',
      'packages/*/.turbo/**',
      'apps/*/dist/**',
      'apps/*/coverage/**',
      'apps/*/.turbo/**',
    ],
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
        // An explicit list rather than the nearest tsconfig to each file, so
        // lint sees the same program as typecheck.
        project: lintProjects(import.meta.dirname),
        tsconfigRootDir: import.meta.dirname,
        // typescript-eslint treats CI=true as a single run and stops tracking
        // files it was not started with, which breaks the lint tests that
        // check text not on disk. Keep CI behaving like a local run.
        disallowAutomaticSingleRunInference: true,
      },
    },
    plugins: {
      ujira: {
        rules: {
          'license-header': licenseHeader,
          'no-number-arithmetic': noNumberArithmetic,
          'no-number-conversion': noNumberConversion,
          'no-chain-branching': noChainBranching,
        },
      },
    },
    rules: {
      'ujira/license-header': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'no-console': 'warn',
      // eval runs code that no rule here can see, in any file.
      'no-eval': ['error', { allowIndirect: false }],
      'no-implied-eval': 'error',
    },
  },
  {
    // build and snapshot skip the public factory, so code outside the money
    // module must go through money() and the operations instead.
    files: ['packages/**/*.{ts,tsx,mts,cts}', 'apps/**/*.{ts,tsx,mts,cts}'],
    ignores: ['packages/core/src/money/**'],
    // A disable comment would switch the fence off for one line without
    // review, so inline config has no effect in fenced source.
    linterOptions: { noInlineConfig: true },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // A require made at runtime loads any file by path and no import
          // rule sees what it loads.
          paths: [
            { name: 'node:module', message: CREATE_REQUIRE_MESSAGE },
            { name: 'module', message: CREATE_REQUIRE_MESSAGE },
            { name: 'node:vm', message: RUNTIME_LOADERS_MESSAGE },
            { name: 'vm', message: RUNTIME_LOADERS_MESSAGE },
            { name: 'node:worker_threads', message: RUNTIME_LOADERS_MESSAGE },
            { name: 'worker_threads', message: RUNTIME_LOADERS_MESSAGE },
          ],
          patterns: [
            {
              regex: MONEY_INTERNALS_PATH.source,
              importNames: [
                'build',
                'buildToken',
                'snapshot',
                'snapshotFiat',
                'snapshotToken',
                'withAmount',
              ],
              message:
                'build, buildToken, snapshot, snapshotFiat, snapshotToken and withAmount are internal to the money module. Use money(), moneyAt() or tokenAmount().',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: `ImportExpression[source.value=/${MONEY_INTERNALS_SELECTOR}/i]`,
          message:
            'A dynamic import of money.ts exposes build and snapshot. Import money() statically.',
        },
        {
          // A computed path cannot be checked against the fence at all. This
          // applies to every fenced file, so a future app loading messages by
          // locale with a template path will need a static map instead.
          selector: 'ImportExpression[source.type!="Literal"]',
          message: 'Dynamic imports need a plain string path so the import fence can check them.',
        },
        {
          // The paths option above only sees static imports.
          selector: `ImportExpression[source.value=/${RUNTIME_LOADERS_SELECTOR}/]`,
          message: RUNTIME_LOADERS_MESSAGE,
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'getBuiltinModule',
          message: CREATE_REQUIRE_MESSAGE,
        },
        // Reaching process through the global object would skip the entry above.
        { object: 'globalThis', property: 'process', message: CREATE_REQUIRE_MESSAGE },
        { object: 'global', property: 'process', message: CREATE_REQUIRE_MESSAGE },
      ],
    },
  },
  {
    // Only the chain adapter knows which chain it is on. Core, payouts, the
    // router and every app reach a chain through it.
    files: ['packages/**/*.{ts,tsx,mts,cts}', 'apps/**/*.{ts,tsx,mts,cts}'],
    ignores: ['packages/chain-adapter/**'],
    rules: {
      'ujira/no-chain-branching': 'error',
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
      'ujira/no-number-conversion': 'error',
      // eval and its relatives run code no rule here can see, so a float
      // computation hidden in a string would pass every other check. The
      // eval bans are layered on purpose: no-eval, the eval global, the
      // globalThis and global properties and no-implied-eval each close a
      // different spelling. Do not remove one as a duplicate of another.
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
        { name: 'Atomics', message: 'Atomics reads typed arrays, floats included. Use bigint.' },
        { name: 'Float16Array', message: 'Float arrays hold floats. Use bigint.' },
        // The global object reaches every banned global by name, through an
        // alias, a computed key or nesting such as globalThis.global.Math.
        { name: 'globalThis', message: 'The global object reaches banned globals by name.' },
        { name: 'global', message: 'The global object reaches banned globals by name.' },
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
        ...['call', 'apply', 'bind'].map((property) => ({
          object: 'Number',
          property,
          message: 'Number converts to a float however it is called. Keep amounts as bigint.',
        })),
        ...['asIntN', 'asUintN'].map((property) => ({
          object: 'BigInt',
          property,
          message: 'BigInt wrapping silently changes the amount. Check the range instead.',
        })),
        ...[
          'readDoubleLE',
          'readDoubleBE',
          'readFloatLE',
          'readFloatBE',
          'writeDoubleLE',
          'writeDoubleBE',
          'writeFloatLE',
          'writeFloatBE',
          'getFloat16',
          'getFloat32',
          'getFloat64',
          'setFloat16',
          'setFloat32',
          'setFloat64',
        ].map((property) => ({ property, message: 'Float reads and writes on bytes are floats.' })),
        {
          property: 'toLocaleString',
          message: 'toLocaleString formats through a number. Use formatMoney.',
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
            'Identifier[name="Number"]:not(MemberExpression > Identifier.object):not(MemberExpression[computed=false] > Identifier.property):not(CallExpression > Identifier.callee):not(NewExpression > Identifier.callee):not(Property[computed=false][shorthand=false] > Identifier.key):not(PropertyDefinition[computed=false] > Identifier.key):not(MethodDefinition[computed=false] > Identifier.key):not(TSPropertySignature[computed=false] > Identifier.key):not(TSMethodSignature[computed=false] > Identifier.key)',
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
        {
          // 1e21 and up print in exponent form and lose integer precision.
          selector: 'Literal[raw=/^[0-9_]+[eE][+]?[0-9_]+$/]',
          message: 'Exponent literals are floats past 2^53. Use bigint minor units.',
        },
        {
          // Static, dynamic and re-export forms of the runtime loaders.
          selector: `:matches(ImportDeclaration, ImportExpression, ExportAllDeclaration, ExportNamedDeclaration)[source.value=/${RUNTIME_LOADERS_SELECTOR}/]`,
          message: RUNTIME_LOADERS_MESSAGE,
        },
      ],
    },
  },
);
