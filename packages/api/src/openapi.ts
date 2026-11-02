// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Builds the API's OpenAPI document from the route table, so the document
// describes exactly what the server answers. Components come from
// @ujira/api-schema under the same names, plus the response of any route
// declared here. The document is committed in openapi/openapi.json and a
// test fails when it drifts.

import {
  OPENAPI_COMPONENTS,
  PROBLEM_CODES,
  PROBLEM_TITLES,
  openApiParameters,
} from '@ujira/api-schema';
import type { ProblemCode } from '@ujira/api-schema';
import { z } from 'zod';

import { RouteRegistryError } from './errors.js';
import { definePublicRoute, requiresIdempotencyKey } from './route.js';
import type { Route } from './route.js';

type JsonObject = Record<string, unknown>;

const REF = '#/components/schemas/';
export const OPENAPI_PATH = '/v1/openapi.json';

function withoutMeta(schema: unknown): JsonObject {
  const copy: JsonObject = { ...(schema as JsonObject) };
  delete copy['$schema'];
  delete copy['$id'];
  return copy;
}

const CODES = Object.keys(PROBLEM_CODES) as ProblemCode[];

// Each error status lists the codes it can carry, so a client author can see
// what to branch on without reading our source.
function statusDescription(status: number): string {
  const codes = CODES.filter((code) => PROBLEM_CODES[code] === status);
  return codes.map((code) => `${code}: ${PROBLEM_TITLES[code]}`).join('. ');
}

function components(routes: readonly Route[]): (readonly [string, z.ZodType])[] {
  const list: (readonly [string, z.ZodType])[] = [...OPENAPI_COMPONENTS];
  for (const route of routes) {
    const { name, schema } = route.response;
    const same = list.find(([id]) => id === name);
    if (same === undefined) list.push([name, schema]);
    else if (same[1] !== schema) {
      throw new RouteRegistryError(`component name ${name} is used for two different schemas`);
    }
  }
  return list;
}

const headerSchema = { schema: { type: 'string' } };

const RATE_LIMIT_HEADERS = {
  'RateLimit-Limit': headerSchema,
  'RateLimit-Remaining': headerSchema,
  'RateLimit-Reset': headerSchema,
};

function operation(route: Route): JsonObject {
  const limits = route.access.kind === 'tenant' ? RATE_LIMIT_HEADERS : {};
  const responses: JsonObject = {
    [String(route.response.status)]: {
      description: 'OK',
      headers: { 'Request-Id': headerSchema, ...limits },
      content: { 'application/json': { schema: { $ref: `${REF}${route.response.name}` } } },
    },
  };
  for (const status of route.errorStatuses) {
    responses[String(status)] = {
      description: statusDescription(status),
      headers: {
        'Request-Id': headerSchema,
        ...(status === 409 || status === 429 || status === 503
          ? { 'Retry-After': headerSchema }
          : {}),
        ...(status === 429 ? limits : {}),
      },
      content: { 'application/problem+json': { schema: { $ref: `${REF}Problem` } } },
    };
  }
  const tenant = route.access.kind === 'tenant';
  return {
    operationId: route.id,
    summary: route.summary,
    security: tenant ? [{ bearer: [] }] : [],
    ...(route.access.kind === 'tenant' ? { 'x-ujira-scope': route.access.scope } : {}),
    parameters: [
      ...openApiParameters('path', route.params),
      ...openApiParameters('query', route.query),
      ...(route.rawBody?.headers ?? []).map((name) => ({
        name,
        in: 'header',
        required: true,
        schema: { type: 'string' },
      })),
      ...(requiresIdempotencyKey(route)
        ? [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              description:
                'Unique per write. A retry with the same key and the same request gets the ' +
                'first answer for 7 days; the same key on a different request is refused.',
              schema: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,255}$' },
            },
          ]
        : []),
    ],
    // A webhook body is verified as bytes, so the document does not promise
    // a shape UJIRA checks before the signature.
    ...(route.rawBody === null
      ? {}
      : {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        }),
    ...(route.body === null
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: withoutMeta(z.toJSONSchema(route.body, { io: 'input' })),
              },
            },
          },
        }),
    responses,
  };
}

const REF_PATTERN = /"#\/components\/schemas\/([A-Za-z0-9_]+)"/g;

// Only the components some route reaches, directly or through another
// component, so the document lists no shape the server never sends.
function reachable(paths: JsonObject, schemas: Record<string, JsonObject>): JsonObject {
  const keep = new Set<string>();
  const queue = [JSON.stringify(paths)];
  for (let text = queue.pop(); text !== undefined; text = queue.pop()) {
    for (const match of text.matchAll(REF_PATTERN)) {
      const name = match[1] ?? '';
      if (keep.has(name) || schemas[name] === undefined) continue;
      keep.add(name);
      queue.push(JSON.stringify(schemas[name]));
    }
  }
  return Object.fromEntries(Object.entries(schemas).filter(([name]) => keep.has(name)));
}

/** The OpenAPI 3.1 document for the given routes. */
export function buildOpenApiDocument(routes: readonly Route[]): JsonObject {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of components(routes)) registry.add(schema, { id });
  const generated = z.toJSONSchema(registry, { uri: (id) => `${REF}${id}`, io: 'output' });
  const schemas = Object.fromEntries(
    Object.entries(generated.schemas).map(([id, schema]) => [id, withoutMeta(schema)]),
  );
  const paths: Record<string, JsonObject> = {};
  for (const route of routes) {
    paths[route.path] = { ...paths[route.path], [route.method.toLowerCase()]: operation(route) };
  }
  return {
    openapi: '3.1.1',
    info: { title: 'UJIRA API', version: 'v1' },
    paths,
    components: {
      schemas: reachable(paths, schemas),
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
  };
}

// The served document is read as JSON by tooling, so only its outline is
// checked here; the drift test pins the whole of it.
const OpenApiDocument = z.looseObject({
  openapi: z.literal('3.1.1'),
  info: z.looseObject({ title: z.string(), version: z.string() }),
  paths: z.record(z.string(), z.unknown()),
  components: z.record(z.string(), z.unknown()),
});

/** The routes plus GET /v1/openapi.json, which serves the document of all of them. */
export function withOpenApiRoute(routes: readonly Route[]): {
  readonly routes: readonly Route[];
  readonly document: JsonObject;
} {
  let document: JsonObject = {};
  const openApiRoute = definePublicRoute({
    id: 'getOpenApi',
    method: 'GET',
    path: OPENAPI_PATH,
    summary: 'This document',
    reason: 'The API description is public, and it holds no tenant data.',
    response: { name: 'OpenApiDocument', schema: OpenApiDocument },
    handler: () => Promise.resolve(document as z.input<typeof OpenApiDocument>),
  });
  const all = [...routes, openApiRoute];
  document = buildOpenApiDocument(all);
  return { routes: all, document };
}
