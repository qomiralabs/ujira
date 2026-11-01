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
  '/v1/stats/overview',
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

  // Someone implementing this API in another language reads the document,
  // not our source, so an obligation that lives only in a comment is
  // invisible to them.
  it('states in the document that the server signs cursors', () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { parameters: { name: string; schema: { description?: string } }[] }>
      >;
      components: { schemas: Record<string, unknown> };
    };
    const states = (text: unknown): boolean =>
      typeof text === 'string' && /signs?/i.test(text) && /(forg|another query|reused)/i.test(text);

    // Every cursor a client sends back.
    const cursorParams = Object.values(doc.paths)
      .flatMap((methods) => Object.values(methods))
      .flatMap((operation) => operation.parameters)
      .filter((p) => /cursor/i.test(p.name));
    expect(cursorParams.map((p) => p.name).sort()).toEqual([
      'cursor',
      'cursor',
      'cursor',
      'cursor',
      'depositsCursor',
    ]);
    for (const p of cursorParams) expect(states(p.schema.description), p.name).toBe(true);

    // And every cursor the server hands out. Walked to any depth, because a
    // page can be nested inside another response, as the deposits page is
    // inside the funding one, and a scan one level deep would pass while
    // saying nothing about it.
    const found: { path: string; description: unknown }[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => {
          walk(item, `${path}[${String(i)}]`);
        });
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'nextCursor') {
          found.push({
            path: `${path}.${key}`,
            description: (value as { description?: unknown }).description,
          });
        }
        walk(value, `${path}.${key}`);
      }
    };
    walk(doc.components.schemas, 'schemas');

    // Four page envelopes plus the deposits page nested in the funding response.
    expect(found).toHaveLength(5);
    expect(found.map((f) => f.path).sort()).toEqual([
      'schemas.ApprovalPage.properties.nextCursor',
      'schemas.FundingOverview.properties.deposits.properties.nextCursor',
      'schemas.MandatePage.properties.nextCursor',
      'schemas.PayoutPage.properties.nextCursor',
      'schemas.ReceiptPage.properties.nextCursor',
    ]);
    for (const f of found) expect(states(f.description), f.path).toBe(true);
  });

  // Available means two things depending on the instance state, so the
  // document must say which rule applies where the field is read.
  it('states the available rule next to the funding balance', () => {
    const doc = buildOpenApiDocument() as {
      components: {
        schemas: Record<string, { properties?: Record<string, { description?: string }> }>;
      };
    };
    const balance = doc.components.schemas['FundingAccount']?.properties?.['balance'];
    expect(balance?.description).toMatch(/revoked and expired/);
    expect(balance?.description).toMatch(/total minus pending minus committed/);
    expect(doc.components.schemas['FundingAccount']?.properties?.['status']).toBeDefined();
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
