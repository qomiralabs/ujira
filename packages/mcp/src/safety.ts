// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The rules every tool keeps, whoever adds it. The server refuses to start with a tool
// that breaks one, so a rule here is not only a test someone could forget to run.
//
// UJIRA is non-custodial: this server holds an API key and nothing that can move a
// principal's money, so no tool may even have somewhere to put a wallet secret.

import { ROUTES } from '@ujira/api-schema';

import { inputSchemaOf } from './tools.js';
import type { ToolDefinition } from './tools.js';

/** The closed list in `packages/api/src/auth.ts`, which a test keeps this in step with. */
export const KNOWN_SCOPES: readonly string[] = Object.freeze([
  'payouts:read',
  'payouts:write',
  'approvals:write',
  'recipients:read',
  'recipients:write',
  'mandates:read',
  'mandates:write',
  'receipts:read',
  'webhooks:manage',
  'corridors:read',
]);

const SECRET_INPUT =
  /key|secret|seed|passw|mnemonic|signature|signed|private|phrase|token|credential/i;
const CHAIN_INPUT = /chain|network|rail/i;
const ASKS_FOR_A_SECRET =
  /private key|secret key|seed phrase|recovery phrase|mnemonic|wallet secret/i;
const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

// The JSON schema keywords that hold schemas by name, and those that hold them directly.
const NAMED = ['properties', 'patternProperties', '$defs', 'definitions'] as const;
const NESTED = ['items', 'additionalItems', 'contains', 'not', 'if', 'then', 'else'] as const;
const LISTED = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputProblem(tool: string, name: string): string | null {
  if (SECRET_INPUT.test(name)) return `${tool}: an input named ${name} could hold a secret`;
  if (CHAIN_INPUT.test(name)) return `${tool}: an input named ${name} lets a caller choose a chain`;
  return null;
}

/** Everything wrong with one input schema, at any depth. */
export function schemaProblems(tool: string, schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  const problems: string[] = [];
  for (const keyword of NAMED) {
    const entries = schema[keyword];
    if (!isRecord(entries)) continue;
    for (const [name, inner] of Object.entries(entries)) {
      if (keyword === 'properties' || keyword === 'patternProperties') {
        const problem = inputProblem(tool, name);
        if (problem !== null) problems.push(problem);
      }
      problems.push(...schemaProblems(tool, inner));
    }
  }
  for (const keyword of NESTED) problems.push(...schemaProblems(tool, schema[keyword]));
  for (const keyword of LISTED) {
    const list = schema[keyword];
    if (Array.isArray(list)) {
      for (const inner of list as readonly unknown[]) problems.push(...schemaProblems(tool, inner));
    }
  }
  // An object taking any name at all could hold anything, whatever the rules above say.
  const extra = schema['additionalProperties'];
  if (extra === true || (schema['type'] === 'object' && extra === undefined)) {
    problems.push(`${tool}: an object takes inputs nobody named`);
  }
  problems.push(...schemaProblems(tool, extra));
  return problems;
}

/** Everything wrong with these tools, for the server to refuse and a test to read. */
export function toolProblems(tools: readonly ToolDefinition[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) problems.push(`${tool.name}: not a snake case name`);
    if (names.has(tool.name)) problems.push(`${tool.name}: listed twice`);
    names.add(tool.name);
    if (ASKS_FOR_A_SECRET.test(tool.description)) {
      problems.push(`${tool.name}: its description asks for a secret`);
    }
    if (!KNOWN_SCOPES.includes(tool.scope)) {
      problems.push(`${tool.name}: ${tool.scope} is not a scope`);
    }
    if (tool.write !== true) {
      // Every route in the table is a read today. This holds when one is not.
      const method: string = ROUTES[tool.route].method;
      if (method !== 'GET') {
        problems.push(`${tool.name}: not marked as a write, and its route is not a read`);
      }
      if (!tool.scope.endsWith(':read')) {
        problems.push(`${tool.name}: not marked as a write, and it needs ${tool.scope}`);
      }
    }
    problems.push(...schemaProblems(tool.name, inputSchemaOf(tool)));
  }
  return problems;
}

export class UnsafeToolError extends Error {
  override readonly name = 'UnsafeToolError';

  constructor(problems: readonly string[]) {
    super(`These tools break the safety rules: ${problems.join('; ')}`);
  }
}
