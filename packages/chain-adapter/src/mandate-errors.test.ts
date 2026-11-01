// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The generator for mandate-errors.generated.ts and its drift check. The
// mandate error names and codes are rendered from the vendored
// spec/errors.json rather than typed by hand, so a renumbered or new code in
// the spec cannot drift from what the adapter reports.
//
// `pnpm --filter @ujira/chain-adapter errors:generate` rewrites the file;
// `pnpm --filter @ujira/chain-adapter errors:check` (run in CI) fails when
// the committed file differs from what the vendored table renders.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MANDATE_ERRORS, MANDATE_ERROR_NAMES_BY_CODE } from './mandate-errors.generated.js';
import type { MandateErrorName } from './mandate-errors.generated.js';
import { MANDATE_ERROR_NAMES, isMandateErrorName, mandateErrorName } from './mandate-errors.js';

const SPEC_FILE = path.resolve(import.meta.dirname, '../spec/errors.json');
const GENERATED_FILE = path.resolve(import.meta.dirname, 'mandate-errors.generated.ts');

const ErrorTable = z
  .array(
    z.strictObject({
      name: z.string().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/),
      code: z.number().int().min(1).max(4_294_967_295),
      summary: z.string().min(1).max(500),
    }),
  )
  .min(1)
  .refine((rows) => new Set(rows.map((r) => r.name)).size === rows.length, 'names are unique')
  .refine((rows) => new Set(rows.map((r) => r.code)).size === rows.length, 'codes are unique');

type ErrorRow = z.infer<typeof ErrorTable>[number];

function readTable(text: string = readFileSync(SPEC_FILE, 'utf8')): ErrorRow[] {
  return ErrorTable.parse(JSON.parse(text));
}

// A summary goes into a doc comment, so it must not be able to close one.
function commentText(summary: string): string {
  return summary.replaceAll('*/', '* /');
}

/**
 * The TypeScript source the vendored table renders to, laid out as the
 * repository formatter leaves it, so format:check holds the committed file
 * to the same text.
 */
function renderMandateErrors(rows: readonly ErrorRow[]): string {
  const entries = rows
    .map((row) => `  /** ${commentText(row.summary)} */\n  ${row.name}: ${String(row.code)},`)
    .join('\n');
  const byCode = rows.map((row) => `    ${String(row.code)}: '${row.name}',`).join('\n');
  return `// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generated from spec/errors.json by src/mandate-errors.test.ts. Do not edit
// by hand: update the vendored file, then run
// \`pnpm --filter @ujira/chain-adapter errors:generate\`.

/** Every mandate error by its spec name, with its code. Codes are never reused. */
export const MANDATE_ERRORS = Object.freeze({
${entries}
} as const);

export type MandateErrorName = keyof typeof MANDATE_ERRORS;

/** The spec name of every code. */
export const MANDATE_ERROR_NAMES_BY_CODE: Readonly<Record<number, MandateErrorName>> =
  Object.freeze({
${byCode}
  });
`;
}

describe('mandate error names', () => {
  it('the generated file is current with the vendored errors.json', () => {
    const text = renderMandateErrors(readTable());
    if (process.env['UJIRA_WRITE_GENERATED'] === '1') writeFileSync(GENERATED_FILE, text);
    expect(readFileSync(GENERATED_FILE, 'utf8')).toBe(text);
  });

  it('MandateErrorName equals the names in the vendored errors.json, including 26, 27 and 65', () => {
    const rows = readTable();
    expect(Object.fromEntries(rows.map((r) => [r.name, r.code]))).toEqual(MANDATE_ERRORS);
    expect([...MANDATE_ERROR_NAMES]).toEqual(rows.map((r) => r.name));
    expect(MANDATE_ERROR_NAMES_BY_CODE).toEqual(
      Object.fromEntries(rows.map((r) => [String(r.code), r.name])),
    );
    const named: Record<number, MandateErrorName> = {
      26: 'PRINCIPAL_CHANGE_PENDING',
      27: 'SWEEP_GRACE_PERIOD',
      65: 'AGENT_REMOVED',
    };
    for (const [code, name] of Object.entries(named)) {
      expect(mandateErrorName(Number(code))).toBe(name);
      expect(MANDATE_ERRORS[name]).toBe(Number(code));
    }
  });

  it('answers undefined for a code or name the table does not hold', () => {
    expect(mandateErrorName(1)).toBeUndefined();
    expect(mandateErrorName(1.5)).toBeUndefined();
    expect(isMandateErrorName('INSUFFICIENT_FUNDS')).toBe(true);
    expect(isMandateErrorName('NOT_A_SPEC_ERROR')).toBe(false);
    expect(isMandateErrorName('toString')).toBe(false);
    expect(isMandateErrorName(42)).toBe(false);
  });

  it('renders a renumbered or added code differently, so the drift check catches it', () => {
    const rows = readTable();
    const current = renderMandateErrors(rows);
    const renumbered = rows.map((r) => (r.name === 'AGENT_REMOVED' ? { ...r, code: 66 } : r));
    expect(renderMandateErrors(renumbered)).not.toBe(current);
    const added = [...rows, { name: 'NEW_RULE', code: 99, summary: 'A new rule' }];
    expect(renderMandateErrors(added)).toContain('NEW_RULE: 99');
  });

  it('refuses a table with a repeated code or a malformed name', () => {
    const rows = readTable();
    const first = rows[0];
    if (first === undefined) throw new Error('empty table');
    expect(() => readTable(JSON.stringify([...rows, { ...first, name: 'OTHER' }]))).toThrow();
    expect(() => readTable(JSON.stringify([{ ...first, name: 'lower' }]))).toThrow();
  });

  it('keeps a summary from closing its doc comment', () => {
    expect(renderMandateErrors([{ name: 'X', code: 1, summary: 'ends */ here' }])).toContain(
      '/** ends * / here */',
    );
  });
});
