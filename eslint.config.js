// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript';
import tseslint from 'typescript-eslint';

import {
  CHAIN_NAMESPACES,
  CHAIN_SDK_PACKAGES,
  isChainAbiModule,
  matchesPackage,
} from './packages/chain-adapter/src/chain-modules.ts';
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

const STRING_TESTS = new Set(['startsWith', 'endsWith', 'includes', 'match', 'search']);

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What counts as chain text, built from the namespaces the chain adapter
 * exports, so adding a chain there extends this rule with no change here.
 * @typedef {{
 *   isName: (text: string) => boolean,
 *   isToken: (text: string) => boolean,
 *   isPattern: (source: string) => boolean,
 * }} ChainText
 * @param {readonly string[]} namespaces
 * @returns {ChainText}
 */
function chainText(namespaces) {
  const names = namespaces.map(escapeRegExp).join('|');
  // A namespace on its own in any letter case, or a CAIP-2 network in it.
  const name = new RegExp(`^(?:${names})(?::[-a-z0-9_]{1,32})?$`, 'i');
  // A namespace as a whole token of a longer string, for tests such as
  // startsWith('stellar:').
  const token = new RegExp(`(?:^|:)(?:${names})(?::|$)`, 'i');
  // A namespace as a whole word in a regular expression's source, so a
  // longer word that merely contains it is not chain code. Word boundary
  // escapes are blanked first so a bounded name still counts.
  const pattern = new RegExp(`(?:^|[^a-z0-9_])(?:${names})(?![a-z0-9_])`, 'i');
  return {
    isName: (text) => name.test(text),
    isToken: (text) => token.test(text),
    isPattern: (source) => pattern.test(source.replaceAll('\\b', ' ')),
  };
}

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
 * that gives the value, so `const STELLAR = 'stellar'` compares like 'stellar' does.
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
 * @param {ChainText} chain
 * @param {unknown} node
 */
function isChainLiteral(context, chain, node) {
  const text = staticString(resolve(context, node));
  return text !== undefined && chain.isName(text);
}

/**
 * Whether an array, a Set or Map built from one, or an object literal holds
 * a chain or network literal as an element or key.
 * @param {import('eslint').Rule.RuleContext} context
 * @param {ChainText} chain
 * @param {unknown} node
 * @returns {boolean}
 */
function holdsChainLiteral(context, chain, node) {
  const value = resolve(context, node);
  if (value?.type === 'ArrayExpression') {
    return children(value, 'elements').some(
      (element) =>
        isChainLiteral(context, chain, element) || holdsChainLiteral(context, chain, element),
    );
  }
  if (value?.type === 'NewExpression') {
    const callee = field(child(value, 'callee'), 'name');
    return (
      (callee === 'Set' || callee === 'Map') &&
      holdsChainLiteral(context, chain, children(value, 'arguments')[0])
    );
  }
  if (value?.type === 'ObjectExpression') {
    return children(value, 'properties').some((property) => {
      const key = child(property, 'key');
      if (field(property, 'computed') === true) return isChainLiteral(context, chain, key);
      const name = key?.type === 'Identifier' ? field(key, 'name') : field(key, 'value');
      return typeof name === 'string' && chain.isName(name);
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
 * Keeps chain knowledge inside the chain adapter: no chain SDK or contract
 * interface import, and no branch on a chain or network value anywhere
 * else. A comparison against 'stellar' is how a second chain path starts;
 * the adapter interface is where that difference belongs.
 *
 * The rule is data driven. It reads the chain namespaces and SDK packages
 * the chain adapter exports (CHAIN_NAMESPACES and CHAIN_SDK_PACKAGES), so a
 * chain added there is covered here with no change to the rule. It flags
 * any comparison, switch case, membership test, lookup or string test
 * against a namespace name or a `<namespace>:` network string.
 *
 * It reads syntax, not types. It sees literals in any letter case however
 * they are wrapped, through const bindings in the same file, prefix and
 * suffix tests, and regular expressions that name a namespace as a word. It
 * does not see a constant imported from another module, a const object or
 * enum member, a value built by concatenation or transformed by a string
 * method, or a lookup through a Map or a function. Any `.stellar` property
 * access is reported, whatever the object.
 *
 * Network specific display, such as a network's name or icon, comes from
 * the adapter's capabilities, which callers render without branching. That
 * is the reviewed way to show per chain UI, so a lookup table keyed by
 * chain in app code is never needed.
 *
 * Options: `regex` (default on) reports regular expressions that name a
 * chain, and `memberNames` (default on) reports `.stellar` reads. Test
 * files, matched by name (*.test.*, *.spec.*, *.test-d.ts), turn both off,
 * because tests assert on displayed text and on fixtures. Imports,
 * comparisons, membership calls and computed lookups are reported there as
 * everywhere else. `namespaces` and `sdkPackages` replace the adapter's
 * lists, which only the rule's own tests do.
 * @type {import('eslint').Rule.RuleModule}
 */
const noChainBranching = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep chain SDKs and chain comparisons inside the chain adapter' },
    schema: [
      {
        type: 'object',
        properties: {
          regex: { type: 'boolean' },
          memberNames: { type: 'boolean' },
          namespaces: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
          sdkPackages: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      sdk: 'Chain SDKs and contract interfaces load only in packages/chain-adapter. Call the adapter instead.',
      compare:
        'Branching on a chain or network belongs in packages/chain-adapter. Ask the adapter or the router config instead.',
    },
  },
  create(context) {
    /** @type {unknown} */
    const rawOptions = context.options[0];
    const options =
      /** @type {{ regex?: boolean, memberNames?: boolean, namespaces?: string[], sdkPackages?: string[] } | undefined} */ (
        rawOptions
      );
    const checkRegex = options?.regex !== false;
    const checkMemberNames = options?.memberNames !== false;
    const chain = chainText(options?.namespaces ?? CHAIN_NAMESPACES);
    const sdkPackages = options?.sdkPackages ?? CHAIN_SDK_PACKAGES;
    /** @param {unknown} node @param {'sdk' | 'compare'} messageId */
    const report = (node, messageId) => {
      context.report({ node: /** @type {import('eslint').Rule.Node} */ (node), messageId });
    };
    /** new RegExp('stellar') and RegExp('stellar') name a chain as a regex does. */
    const checkRegExpCall = (/** @type {unknown} */ node) => {
      if (!checkRegex || field(child(node, 'callee'), 'name') !== 'RegExp') return;
      const source = staticString(resolve(context, children(node, 'arguments')[0]));
      if (source !== undefined && chain.isPattern(source)) report(node, 'compare');
    };
    /** @param {unknown} source @param {unknown} node */
    const checkModule = (source, node) => {
      const name = staticString(resolve(context, source));
      if (name !== undefined && (matchesPackage(name, sdkPackages) || isChainAbiModule(name))) {
        report(node, 'sdk');
      }
    };
    /** @param {unknown} node */
    const isChain = (node) => isChainLiteral(context, chain, node);
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
        checkRegExpCall(node);
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
          if (node.arguments.some(isChain)) report(node, 'compare');
          return;
        }
        if (typeof method !== 'string') return;
        if (STRING_TESTS.has(method)) {
          const text = staticString(resolve(context, node.arguments[0]));
          if (text !== undefined && chain.isToken(text)) {
            report(node, 'compare');
            return;
          }
        }
        if (!MEMBERSHIP_METHODS.has(method)) return;
        if (node.arguments.some(isChain) || holdsChainLiteral(context, chain, object)) {
          report(node, 'compare');
        }
      },
      /** @param {unknown} node */
      NewExpression(node) {
        checkRegExpCall(node);
      },
      MemberExpression(node) {
        if (node.computed) {
          if (isChain(node.property) || holdsChainLiteral(context, chain, node.object)) {
            report(node, 'compare');
          }
          return;
        }
        // Any .stellar access counts, on any object: a property named after
        // a chain is a lookup by chain.
        const name = field(node.property, 'name');
        if (checkMemberNames && typeof name === 'string' && chain.isName(name)) {
          report(node, 'compare');
        }
      },
      Literal(node) {
        const { regex } = /** @type {{ regex?: { pattern: string } }} */ (node);
        if (checkRegex && regex !== undefined && chain.isPattern(regex.pattern)) {
          report(node, 'compare');
        }
      },
      BinaryExpression(node) {
        if (!EQUALITY_OPERATORS.has(node.operator)) return;
        if (isChain(node.left) || isChain(node.right)) report(node, 'compare');
      },
      SwitchCase(node) {
        if (isChain(node.test)) report(node, 'compare');
      },
    };
  },
};

// The driver and the query builder are importable only inside packages/db.
// Every query goes through that package, under a tenant context, inside one
// transaction; an import elsewhere would be a query with no context on a
// pooled connection.
const DB_DRIVER_PATHS = [
  {
    name: 'pg',
    message: 'The Postgres driver loads only in packages/db. Use the repository layer it exports.',
  },
  {
    name: 'pg-pool',
    message: 'The Postgres driver loads only in packages/db. Use the repository layer it exports.',
  },
  {
    name: 'kysely',
    message: 'The query builder loads only in packages/db. Use the repository layer it exports.',
  },
  {
    name: 'node-pg-migrate',
    message: 'Migrations run from packages/db, which owns the migration tool.',
  },
];

const DB_DRIVER_PATTERNS = [
  {
    group: ['pg/*', 'kysely/*', '@ujira/db/src/*', '@ujira/db/dist/*'],
    message: 'Import the public entry of packages/db, not its internals or its driver.',
  },
];

// A type parser changes how every value of a Postgres type is read in the
// process, including inside the driver's own bookkeeping, so changing one is
// a repository wide decision rather than a local choice.
const SET_TYPE_PARSER_PROPERTIES = [
  {
    object: 'types',
    property: 'setTypeParser',
    message:
      'Type parsers stay as pg ships them: changing one changes every value of that type in the process.',
  },
  {
    object: 'pg',
    property: 'setTypeParser',
    message:
      'Type parsers stay as pg ships them: changing one changes every value of that type in the process.',
  },
];

// The import fence's own lists, hoisted so each scope below can compose the
// set it needs. A later flat config entry replaces a rule rather than adding
// to it, so a scope that needs a different set must restate the whole thing.
const RUNTIME_LOADER_PATHS = [
  { name: 'node:module', message: CREATE_REQUIRE_MESSAGE },
  { name: 'module', message: CREATE_REQUIRE_MESSAGE },
  { name: 'node:vm', message: RUNTIME_LOADERS_MESSAGE },
  { name: 'vm', message: RUNTIME_LOADERS_MESSAGE },
  { name: 'node:worker_threads', message: RUNTIME_LOADERS_MESSAGE },
  { name: 'worker_threads', message: RUNTIME_LOADERS_MESSAGE },
];

const MONEY_INTERNALS_PATTERNS = [
  {
    regex: MONEY_INTERNALS_PATH.source,
    importNames: ['build', 'buildToken', 'snapshot', 'snapshotFiat', 'snapshotToken', 'withAmount'],
    message:
      'build, buildToken, snapshot, snapshotFiat, snapshotToken and withAmount are internal to the money module. Use money(), moneyAt() or tokenAmount().',
  },
];

const FENCE_SYNTAX_SELECTORS = [
  {
    selector: `ImportExpression[source.value=/${MONEY_INTERNALS_SELECTOR}/i]`,
    message: 'A dynamic import of money.ts exposes build and snapshot. Import money() statically.',
  },
  {
    // A computed path cannot be checked against the fence at all.
    selector: 'ImportExpression[source.type!="Literal"]',
    message: 'Dynamic imports need a plain string path so the import fence can check them.',
  },
  {
    // The paths option only sees static imports.
    selector: `ImportExpression[source.value=/${RUNTIME_LOADERS_SELECTOR}/]`,
    message: RUNTIME_LOADERS_MESSAGE,
  },
];

const FENCE_PROPERTY_RESTRICTIONS = [
  { object: 'process', property: 'getBuiltinModule', message: CREATE_REQUIRE_MESSAGE },
  // Reaching process through the global object would skip the entry above.
  { object: 'globalThis', property: 'process', message: CREATE_REQUIRE_MESSAGE },
  { object: 'global', property: 'process', message: CREATE_REQUIRE_MESSAGE },
];

// Changing a type parser changes how every value of that Postgres type is
// read in the process. These selectors are shared by the blocks below,
// because a later flat config entry replaces a rule rather than adding to
// it, so any entry that sets no-restricted-syntax must carry them too.
const SET_TYPE_PARSER_SELECTORS = [
  {
    selector: "CallExpression[callee.property.name='setTypeParser']",
    message:
      'Type parsers stay as pg ships them: changing one changes every value of that type in the process.',
  },
  {
    selector: "CallExpression[callee.name='setTypeParser']",
    message:
      'Type parsers stay as pg ships them: changing one changes every value of that type in the process.',
  },
];

// Tenant context is transaction local. A session level SET of a tenant key
// reaches the next client on a pooled backend, which the spike measured.
const TENANT_SESSION_SELECTORS = [
  {
    selector: 'Literal[value=/(?:^|[^a-z_])(?:set|reset)\\s+(?:session\\s+)?ujira\\./i]',
    message:
      'Tenant context is transaction local: send it with set_config(key, value, true), never a session level SET.',
  },
  {
    selector:
      'TemplateElement[value.raw=/(?:^|[^a-z_])(?:set|reset)\\s+(?:session\\s+)?ujira\\./i]',
    message:
      'Tenant context is transaction local: send it with set_config(key, value, true), never a session level SET.',
  },
  {
    selector: "Literal[value=/set_config\\s*\\([^)]*,\\s*(?:false|'f')\\s*\\)/i]",
    message:
      'set_config with a false third argument is session level and reaches the next client on a pooled connection.',
  },
];

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
      // Next.js, Playwright and Lighthouse CI output, and the type file
      // next build writes.
      'apps/*/.next/**',
      'apps/*/next-env.d.ts',
      'apps/*/test-results/**',
      'apps/*/playwright-report/**',
      'apps/*/.lighthouseci/**',
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
          paths: [...RUNTIME_LOADER_PATHS, ...DB_DRIVER_PATHS],
          patterns: [...MONEY_INTERNALS_PATTERNS, ...DB_DRIVER_PATTERNS],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...FENCE_SYNTAX_SELECTORS,
        ...SET_TYPE_PARSER_SELECTORS,
        ...TENANT_SESSION_SELECTORS,
      ],
      'no-restricted-properties': [
        'error',
        ...FENCE_PROPERTY_RESTRICTIONS,
        ...SET_TYPE_PARSER_PROPERTIES,
      ],
    },
  },
  {
    // Inside packages/db the driver and the query builder are the point, so
    // only their ban is lifted. Every other fence rule is restated here,
    // because a flat config entry replaces a rule rather than adding to it,
    // and dropping one by omission is the kind of hole this file exists to
    // prevent. db-lint.test.ts checks both halves: the driver is allowed
    // here and refused elsewhere.
    files: ['packages/db/**/*.{ts,tsx,mts,cts}'],
    linterOptions: { noInlineConfig: true },
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: RUNTIME_LOADER_PATHS, patterns: MONEY_INTERNALS_PATTERNS },
      ],
      'no-restricted-syntax': [
        'error',
        ...FENCE_SYNTAX_SELECTORS,
        ...SET_TYPE_PARSER_SELECTORS,
        ...TENANT_SESSION_SELECTORS,
      ],
      'no-restricted-properties': [
        'error',
        ...FENCE_PROPERTY_RESTRICTIONS,
        ...SET_TYPE_PARSER_PROPERTIES,
      ],
    },
  },
  {
    // Tests write the statements the bans refuse in order to prove they are
    // refused, so the tenant context selectors are dropped for them. The
    // driver ban and the type parser ban still apply.
    files: ['packages/db/**/*.{test,spec}.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-syntax': ['error', ...FENCE_SYNTAX_SELECTORS, ...SET_TYPE_PARSER_SELECTORS],
    },
  },
  {
    // Only the chain adapter knows which chain it is on. Core, payouts, the
    // router and every app reach a chain through it.
    files: [
      'packages/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
      'apps/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
    ],
    ignores: ['packages/chain-adapter/**'],
    rules: {
      'ujira/no-chain-branching': 'error',
    },
  },
  {
    // Tests assert on displayed text and fixtures, so they may use a regex
    // or a property read that names a chain. Everything else still counts.
    // Matched by file name only: production code in a folder called spec
    // or __tests__ keeps every check.
    files: [
      'packages/**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
      'packages/**/*.test-d.ts',
      'apps/**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
      'apps/**/*.test-d.ts',
    ],
    ignores: ['packages/chain-adapter/**'],
    rules: {
      'ujira/no-chain-branching': ['error', { regex: false, memberNames: false }],
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
