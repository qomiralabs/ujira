// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generates the OpenAPI document from the schemas and checks it against the
// committed copy in openapi/openapi.json, which is what reviewers and the
// API read. To refresh the copy after a schema change, run the package's
// "openapi" script, then review the diff.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';

import { ROUTES, ROUTE_IDS, buildOpenApiDocument } from './index.js';

const FILE = join(import.meta.dirname, '..', 'openapi', 'openapi.json');

async function formatted(): Promise<string> {
  const config = (await resolveConfig(FILE)) ?? {};
  return format(JSON.stringify(buildOpenApiDocument()), {
    ...config,
    parser: 'json',
    filepath: FILE,
  });
}

// Every route the issue puts in scope, written out rather than read from the
// route table, so dropping a route from the table fails here.
const IN_SCOPE = [
  '/v1/mandates',
  '/v1/mandates/{id}',
  '/v1/payouts',
  '/v1/payouts/{id}',
  '/v1/receipts',
  '/v1/receipts/{id}',
  '/v1/funding',
  '/v1/approvals',
];

describe('OpenAPI document', () => {
  it('matches the committed openapi/openapi.json', async () => {
    const text = await formatted();
    if (process.env['UJIRA_WRITE_OPENAPI'] === '1') writeFileSync(FILE, text);
    expect(readFileSync(FILE, 'utf8')).toBe(text);
  });

  it('includes every route in scope with its responses', () => {
    const doc = buildOpenApiDocument() as {
      openapi: string;
      paths: Record<
        string,
        Record<string, { operationId: string; responses: Record<string, unknown> }>
      >;
    };
    expect(doc.openapi).toBe('3.1.1');
    expect(Object.keys(doc.paths).sort()).toEqual([...IN_SCOPE].sort());
    for (const id of ROUTE_IDS) {
      const route = ROUTES[id];
      const operation = doc.paths[route.path]?.['get'];
      expect(operation?.operationId).toBe(id);
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(
        ['200', ...route.errors.map(String)].sort(),
      );
    }
  });

  it('resolves every reference and keeps money a string', () => {
    const doc = buildOpenApiDocument() as {
      components: { schemas: Record<string, { properties?: Record<string, { type?: string }> }> };
    };
    const text = JSON.stringify(doc);
    const refs = [...text.matchAll(/"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(doc.components.schemas[ref], ref).toBeDefined();
    expect(doc.components.schemas['Money']?.properties?.['amount']?.type).toBe('string');
    expect(doc.components.schemas['TokenAmount']?.properties?.['amount']?.type).toBe('string');
    expect(text).not.toContain('"$schema"');
  });

  it('describes query parameters as the text clients send', () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<
        string,
        Record<
          string,
          {
            parameters: {
              name: string;
              in: string;
              required: boolean;
              schema: { type?: string };
            }[];
          }
        >
      >;
    };
    const params = doc.paths['/v1/payouts']?.['get']?.parameters ?? [];
    const limit = params.find((p) => p.name === 'limit');
    expect(limit).toMatchObject({ in: 'query', required: false, schema: { type: 'string' } });
    expect(params.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        'status',
        'corridor',
        'method',
        'mandateId',
        'amountMin',
        'amountMax',
        'createdFrom',
        'createdTo',
        'network',
      ]),
    );
    const id = doc.paths['/v1/payouts/{id}']?.['get']?.parameters.find((p) => p.name === 'id');
    expect(id).toMatchObject({ in: 'path', required: true });
  });
});
