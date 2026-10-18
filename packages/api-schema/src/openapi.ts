// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Builds the OpenAPI document for the read routes from the route table.
// Refinements such as "legs add up to the settlement amount" cannot be said
// in JSON Schema, so the document describes shapes and the zod schemas stay
// the authority on values.

import { z } from 'zod';

import { ApprovalItem } from './approvals.js';
import { Problem } from './envelope.js';
import { SchemaRegistryError } from './errors.js';
import { Deposit, FundingAccount, FundingOverview } from './funding.js';
import { LowBalance, LowBalanceState } from './low-balance.js';
import { CountryPolicy, MandateDetail, MandateInstance, MandateListItem } from './mandates.js';
import { Money, Rate, TokenAmount } from './money.js';
import { PayoutDetail, PayoutLeg, PayoutListItem } from './payouts.js';
import {
  PrincipalReceipt,
  ReceiptListItem,
  ReceiptSettings,
  ReceiptView,
  RecipientReceipt,
} from './receipts.js';
import { ApprovalPage, MandatePage, PayoutPage, ROUTES, ROUTE_IDS, ReceiptPage } from './routes.js';

const COMPONENTS: readonly (readonly [string, z.ZodType])[] = [
  ['Money', Money],
  ['TokenAmount', TokenAmount],
  ['Rate', Rate],
  ['Problem', Problem],
  ['CountryPolicy', CountryPolicy],
  ['LowBalance', LowBalance],
  ['LowBalanceState', LowBalanceState],
  ['ReceiptSettings', ReceiptSettings],
  ['MandateInstance', MandateInstance],
  ['MandateListItem', MandateListItem],
  ['MandateDetail', MandateDetail],
  ['MandatePage', MandatePage],
  ['PayoutLeg', PayoutLeg],
  ['PayoutListItem', PayoutListItem],
  ['PayoutDetail', PayoutDetail],
  ['PayoutPage', PayoutPage],
  ['PrincipalReceipt', PrincipalReceipt],
  ['RecipientReceipt', RecipientReceipt],
  ['ReceiptView', ReceiptView],
  ['ReceiptListItem', ReceiptListItem],
  ['ReceiptPage', ReceiptPage],
  ['FundingAccount', FundingAccount],
  ['Deposit', Deposit],
  ['FundingOverview', FundingOverview],
  ['ApprovalItem', ApprovalItem],
  ['ApprovalPage', ApprovalPage],
];

const REF = '#/components/schemas/';

type JsonObject = Record<string, unknown>;

function withoutMeta(schema: unknown): JsonObject {
  const copy: JsonObject = { ...(schema as JsonObject) };
  delete copy['$schema'];
  delete copy['$id'];
  return copy;
}

function parameterSchema(field: z.ZodType): { schema: JsonObject; required: boolean } {
  const required = !field.safeParse(undefined).success;
  const inner = field instanceof z.ZodOptional ? (field.unwrap() as z.ZodType) : field;
  return { schema: withoutMeta(z.toJSONSchema(inner, { io: 'input' })), required };
}

function parameters(where: 'path' | 'query', object: z.ZodType): JsonObject[] {
  if (!(object instanceof z.ZodObject)) return [];
  return Object.entries(object.shape as Record<string, z.ZodType>).map(([name, field]) => {
    const { schema, required } = parameterSchema(field);
    return { name, in: where, required: where === 'path' || required, schema };
  });
}

function componentName(schema: z.ZodType): string {
  const found = COMPONENTS.find(([, candidate]) => candidate === schema);
  if (found === undefined)
    throw new SchemaRegistryError('every route response must be a named component');
  return found[0];
}

const STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({
  400: 'The query is not valid',
  401: 'Not authenticated',
  403: 'Not allowed',
  404: 'Not found, including any id that belongs to another tenant',
  429: 'Rate limited',
});

/** The OpenAPI 3.1 document for every read route in v1. */
export function buildOpenApiDocument(): JsonObject {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of COMPONENTS) registry.add(schema, { id });
  const generated = z.toJSONSchema(registry, { uri: (id) => `${REF}${id}`, io: 'output' });
  const schemas = Object.fromEntries(
    Object.entries(generated.schemas).map(([id, schema]) => [id, withoutMeta(schema)]),
  );
  const paths: Record<string, JsonObject> = {};
  for (const id of ROUTE_IDS) {
    const route = ROUTES[id];
    const responses: JsonObject = {
      200: {
        description: 'OK',
        headers: { 'Request-Id': { schema: { type: 'string' } } },
        content: {
          'application/json': { schema: { $ref: `${REF}${componentName(route.response)}` } },
        },
      },
    };
    for (const status of route.errors) {
      responses[String(status)] = {
        description: STATUS_TEXT[status] ?? 'Error',
        headers: { 'Request-Id': { schema: { type: 'string' } } },
        content: { 'application/problem+json': { schema: { $ref: `${REF}Problem` } } },
      };
    }
    paths[route.path] = {
      [route.method.toLowerCase()]: {
        operationId: id,
        summary: route.summary,
        security: [{ bearer: [] }],
        parameters: [...parameters('path', route.params), ...parameters('query', route.query)],
        responses,
      },
    };
  }
  return {
    openapi: '3.1.1',
    info: { title: 'UJIRA API', version: 'v1' },
    paths,
    components: {
      schemas,
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
  };
}
