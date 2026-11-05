// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The tool table. A tool is a row naming a route in the contract and the scope it
// needs, and nothing more, so this server stays a thin adapter that cannot describe
// a route differently from the API. Inputs and results both come from the contract.

import { parseQuery, ROUTES } from '@ujira/api-schema';
import type { FieldError, RouteId } from '@ujira/api-schema';
import { z } from 'zod';

export interface ToolDefinition {
  /** What an agent calls it, in snake case. */
  readonly name: string;
  /** What an agent reads to decide whether to call it. */
  readonly description: string;
  readonly route: RouteId;
  /** The one scope the API key needs for this tool. */
  readonly scope: string;
  /** Inputs the route takes that this tool does not offer, and refuses. */
  readonly hiddenInputs?: readonly string[];
}

export const TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    name: 'list_payouts',
    description:
      'List payouts, newest first. Filter by status, corridor, method, mandate, amount or date. ' +
      'Pass nextCursor back as cursor for the next page.',
    route: 'listPayouts',
    scope: 'payouts:read',
    // The router decides the chain, so it is not something a caller picks or thinks in.
    hiddenInputs: ['network'],
  },
  {
    name: 'get_payout',
    description:
      "One payout's status, legs, timeline and charges, and the rule that allowed it. " +
      'Use this to check how a payout is going.',
    route: 'getPayout',
    scope: 'payouts:read',
  },
  {
    name: 'list_receipts',
    description:
      'List receipts, newest first, or the receipts of one payout. ' +
      'Pass nextCursor back as cursor for the next page.',
    route: 'listReceipts',
    scope: 'receipts:read',
  },
  {
    name: 'get_receipt',
    description: 'One receipt: what was paid, to whom, and where to check it.',
    route: 'getReceipt',
    scope: 'receipts:read',
  },
  {
    name: 'list_mandates',
    description:
      'List mandates, newest first, optionally by status. ' +
      'Pass nextCursor back as cursor for the next page.',
    route: 'listMandates',
    scope: 'mandates:read',
  },
  {
    name: 'get_mandate',
    description: "One mandate's limits, usage, roles and country policy.",
    route: 'getMandate',
    scope: 'mandates:read',
  },
] satisfies ToolDefinition[]);

export interface ToolInputSchema {
  readonly [key: string]: unknown;
  readonly type: 'object';
  readonly properties: Readonly<Record<string, object>>;
  readonly required?: string[];
  readonly additionalProperties: false;
}

const JsonObjectShape = z.object({
  properties: z.record(z.string(), z.looseObject({})).default({}),
  required: z.array(z.string()).default([]),
});

function jsonSchemaOf(schema: z.ZodType): z.output<typeof JsonObjectShape> {
  // The input side, because the contract's query schemas turn text into typed
  // values, and what a tool takes is the text.
  return JsonObjectShape.parse(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
}

/** The JSON schema a client is shown, from the route's own params and query. */
export function inputSchemaOf(tool: ToolDefinition): ToolInputSchema {
  const route = ROUTES[tool.route];
  const params = jsonSchemaOf(route.params);
  const query = jsonSchemaOf(route.query);
  const hidden = new Set(tool.hiddenInputs ?? []);
  const properties = Object.fromEntries(
    Object.entries({ ...params.properties, ...query.properties }).filter(
      ([name]) => !hidden.has(name),
    ),
  );
  const required = [...params.required, ...query.required].filter((name) => !hidden.has(name));
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

export type ParsedToolInput =
  | {
      readonly ok: true;
      readonly params: Readonly<Record<string, string>>;
      readonly query: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

const INVALID = 'invalid_value';
const UNKNOWN = 'unknown_field';

/**
 * Checks what an agent sent, with the contract's own rules, before any call. Values
 * stay text, as they would in a URL, so the API sees exactly what was sent.
 */
export function parseToolInput(tool: ToolDefinition, args: unknown): ParsedToolInput {
  const record = z.record(z.string(), z.unknown()).safeParse(args ?? {});
  if (!record.success) return { ok: false, errors: [{ field: '(root)', code: INVALID }] };
  const route = ROUTES[tool.route];
  const paramNames = new Set(Object.keys(route.params.shape));
  const hidden = new Set(tool.hiddenInputs ?? []);
  const params: Record<string, string> = {};
  const query: Record<string, string> = {};
  const errors: FieldError[] = [];
  for (const [name, value] of Object.entries(record.data)) {
    if (hidden.has(name)) errors.push({ field: name.slice(0, 200), code: UNKNOWN });
    else if (typeof value !== 'string') errors.push({ field: name.slice(0, 200), code: INVALID });
    else if (paramNames.has(name)) params[name] = value;
    else query[name] = value;
  }
  const checkedParams = route.params.safeParse(params);
  if (!checkedParams.success) {
    for (const issue of checkedParams.error.issues) {
      errors.push({ field: issue.path.join('.').slice(0, 200) || '(root)', code: INVALID });
    }
  }
  const checkedQuery = parseQuery(tool.route, query);
  if (!checkedQuery.success) errors.push(...checkedQuery.errors);
  return errors.length === 0 ? { ok: true, params, query } : { ok: false, errors };
}
