// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The safety rules over the real table, with no list of its own to forget to update,
// and each rule shown to fail when it is broken.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KNOWN_SCOPES, UnsafeToolError, schemaProblems, toolProblems } from './safety.js';
import { createMcpServer } from './server.js';
import { TOOLS, inputSchemaOf } from './tools.js';
import type { ToolDefinition } from './tools.js';

const PACKAGES = join(import.meta.dirname, '..', '..');
const SOURCE = import.meta.dirname;

const READ_TOOL: ToolDefinition = {
  name: 'a_tool',
  description: 'A tool',
  route: 'getPayout',
  scope: 'payouts:read',
};

const objectWith = (properties: Record<string, object>) => ({
  type: 'object',
  properties,
  additionalProperties: false,
});

describe('the real table', () => {
  it('every tool in the table keeps the rules', () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    expect(toolProblems(TOOLS)).toEqual([]);
  });

  it('walks a real schema, so this is not passing on nothing', () => {
    for (const tool of TOOLS) {
      expect(Object.keys(inputSchemaOf(tool).properties).length, tool.name).toBeGreaterThan(0);
    }
  });

  it('the server starts with it', () => {
    const client = { read: () => Promise.reject(new Error('no call')) };
    expect(() => createMcpServer({ client })).not.toThrow();
  });
});

describe('an input that could hold a secret', () => {
  it.each([
    'apiKey',
    'privateKey',
    'secret',
    'clientSecret',
    'seed',
    'seedPhrase',
    'password',
    'passphrase',
    'mnemonic',
    'signature',
    'signedXdr',
    'token',
    'credentials',
  ])('%s is refused', (name) => {
    const problems = schemaProblems('t', objectWith({ [name]: { type: 'string' } }));
    expect(problems.join()).toContain(`named ${name}`);
  });

  it.each([
    ['in an object', objectWith({ wrap: objectWith({ seed: {} }) })],
    ['in an array', objectWith({ wrap: { type: 'array', items: objectWith({ seed: {} }) } })],
    ['in a tuple', objectWith({ wrap: { prefixItems: [objectWith({ seed: {} })] } })],
    ['in a union', objectWith({ wrap: { anyOf: [{ type: 'string' }, objectWith({ seed: {} })] } })],
    ['in one of many', objectWith({ wrap: { oneOf: [objectWith({ seed: {} })] } })],
    ['in a combination', objectWith({ wrap: { allOf: [objectWith({ seed: {} })] } })],
    ['in a definition', { ...objectWith({}), $defs: { hidden: objectWith({ seed: {} }) } }],
    ['behind a condition', objectWith({ wrap: { if: objectWith({ seed: {} }) } })],
    [
      'as a pattern',
      { type: 'object', patternProperties: { seed: {} }, additionalProperties: false },
    ],
    [
      'under extra properties',
      objectWith({ wrap: { additionalProperties: objectWith({ seed: {} }) } }),
    ],
  ])('is found at any depth: %s', (_name, schema) => {
    expect(schemaProblems('t', schema).join()).toContain('named seed');
  });

  it('a harmless name passes', () => {
    expect(
      schemaProblems('t', objectWith({ id: {}, limit: {}, cursor: {}, mandateId: {} })),
    ).toEqual([]);
  });
});

describe('an input that chooses a chain', () => {
  it.each(['chain', 'chainId', 'network', 'networkId', 'rail'])('%s is refused', (name) => {
    expect(schemaProblems('t', objectWith({ [name]: {} })).join()).toContain('choose a chain');
  });

  it('a route that takes one must hide it', () => {
    const list = TOOLS.find((tool) => tool.name === 'list_payouts');
    if (list === undefined) throw new Error('no such tool');
    expect(toolProblems([{ ...list, hiddenInputs: [] }]).join()).toContain('named network');
  });
});

describe('an object that takes any name', () => {
  it.each([
    [
      'extra properties allowed',
      objectWith({ wrap: { type: 'object', additionalProperties: true } }),
    ],
    ['nothing said about them', objectWith({ wrap: { type: 'object' } })],
  ])('is refused: %s', (_name, schema) => {
    expect(schemaProblems('t', schema).join()).toContain('inputs nobody named');
  });
});

describe('the rest of a tool', () => {
  it.each([
    ['a read with a write scope', { ...READ_TOOL, scope: 'payouts:write' }, 'needs payouts:write'],
    ['a scope off the list', { ...READ_TOOL, scope: 'keys:manage' }, 'not a scope'],
    ['a name that is not snake case', { ...READ_TOOL, name: 'GetPayout' }, 'snake case'],
    [
      'a description asking for a seed',
      { ...READ_TOOL, description: 'Send your seed phrase' },
      'asks',
    ],
    ['one asking for a private key', { ...READ_TOOL, description: 'Your private key' }, 'asks'],
  ])('refuses %s', (_name, tool, expected) => {
    expect(toolProblems([tool]).join()).toContain(expected);
  });

  it('refuses the same name twice', () => {
    expect(toolProblems([READ_TOOL, READ_TOOL]).join()).toContain('listed twice');
  });

  it('takes a write scope only on a tool marked as a write', () => {
    expect(toolProblems([{ ...READ_TOOL, scope: 'payouts:write', write: true }])).toEqual([]);
  });

  it('the server refuses to start with a tool that breaks a rule', () => {
    const client = { read: () => Promise.reject(new Error('no call')) };
    expect(() =>
      createMcpServer({ client, tools: [{ ...READ_TOOL, scope: 'payouts:write' }] }),
    ).toThrow(UnsafeToolError);
  });
});

describe('what the package can reach', () => {
  const FORBIDDEN = [
    /^@ujira\/(chain-adapter|signer|db|router|payouts|funding|identity|mandates|api)$/,
    /^@stellar\//,
    /stellar-sdk|soroban|ethers|viem|web3|ed25519|^@noble\/|^tweetnacl$|^pg$|^kysely$/,
  ];

  function manifestOf(name: string): {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly peerDependencies?: Readonly<Record<string, string>>;
  } {
    const folder = name === '@ujira/mcp' ? 'mcp' : name.replace('@ujira/', '');
    return JSON.parse(readFileSync(join(PACKAGES, folder, 'package.json'), 'utf8')) as never;
  }

  // What ships: dependencies, through every workspace package they name. Test tools do
  // not ship, so they are not walked.
  function reachable(name: string, seen = new Set<string>()): Set<string> {
    const manifest = manifestOf(name);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      if (dependency.startsWith('@ujira/')) reachable(dependency, seen);
    }
    return seen;
  }

  it('depends on nothing that can sign or reach a chain or a database', () => {
    const names = [...reachable('@ujira/mcp')];
    expect(names).toContain('@ujira/api-schema');
    for (const name of names) {
      for (const pattern of FORBIDDEN) expect(name, name).not.toMatch(pattern);
    }
  });

  function sourceFiles(): string[] {
    return readdirSync(SOURCE).filter(
      (file) => file.endsWith('.ts') && !file.includes('.test') && !file.endsWith('.d.ts'),
    );
  }

  it('imports only what a thin adapter needs', () => {
    const allowed =
      /^(\.\/|zod$|@ujira\/api-schema$|@modelcontextprotocol\/sdk\/(server\/(mcp|stdio)|shared\/transport|types)\.js$)/;
    const imports = sourceFiles().flatMap((file) =>
      [...readFileSync(join(SOURCE, file), 'utf8').matchAll(/from '([^']+)'/g)].map((match) => ({
        file,
        from: match[1] ?? '',
      })),
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const { file, from } of imports) expect(from, file).toMatch(allowed);
  });

  it('reads the environment in one place only, so a key has one way in', () => {
    const readers = sourceFiles().filter((file) =>
      readFileSync(join(SOURCE, file), 'utf8').includes('process.env'),
    );
    expect(readers).toEqual(['main.ts']);
  });

  it('holds no way to sign', () => {
    for (const file of sourceFiles()) {
      const code = readFileSync(join(SOURCE, file), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
        .join('\n');
      expect(code, file).not.toMatch(/\bsign\w*\(|\.sign\b|createSign|Keypair/);
    }
  });
});

describe('what is copied from the API, and must stay in step', () => {
  const read = (file: string): string => readFileSync(join(PACKAGES, 'api', 'src', file), 'utf8');

  it('the closed list of scopes', () => {
    const block = /API_SCOPES = Object\.freeze\(\[([^\]]+)\]/.exec(read('auth.ts'))?.[1] ?? '';
    const scopes = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes).toEqual(KNOWN_SCOPES);
  });

  it('the form of an API key', () => {
    expect(read('token.ts')).toContain(
      'const TOKEN = /^(ujk_(live|test)_[a-z2-7]{16})_([a-z2-7]{52})([a-z2-7]{7})$/;',
    );
    expect(readFileSync(join(SOURCE, 'config.ts'), 'utf8')).toContain(
      'const API_KEY = /^ujk_(live|test)_[a-z2-7]{16}_[a-z2-7]{59}$/;',
    );
  });
});
