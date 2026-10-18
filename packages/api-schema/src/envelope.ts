// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

export const PAGE_LIMIT_MIN = 1;
export const PAGE_LIMIT_MAX = 200;
export const PAGE_LIMIT_DEFAULT = 50;

/**
 * The opaque keyset cursor. The server signs it and binds it to the query,
 * so a client can only hand back what it was given.
 */
export const Cursor = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/, 'an opaque base64url cursor');

export function Page<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item), nextCursor: Cursor.nullable() });
}

// Query values arrive as text. Each parser below keeps the exact text rules
// the API documents, then hands the handler a typed value.

export const LimitParam = z
  .string()
  .regex(/^[1-9][0-9]{0,3}$/, 'a whole number')
  .transform((text) => Number.parseInt(text, 10))
  .pipe(z.number().int().min(PAGE_LIMIT_MIN).max(PAGE_LIMIT_MAX));

export const pageQueryFields = {
  limit: LimitParam.optional(),
  cursor: Cursor.optional(),
} as const;

/** A comma separated list of values from one closed set, each at most once. */
export function listParam<T extends z.ZodType<string, string>>(item: T, max = 50) {
  return z
    .string()
    .min(1)
    .max(4096)
    .transform((text) => text.split(','))
    .pipe(
      z
        .array(item)
        .min(1)
        .max(max)
        .refine((values) => new Set(values).size === values.length, 'each value at most once'),
    );
}

export const PROBLEM_CODES = Object.freeze({
  INVALID_FILTER: 400,
  INVALID_CURSOR: 400,
  LIMIT_OUT_OF_RANGE: 400,
  INVALID_AMOUNT: 400,
  TOKEN_MALFORMED: 401,
  TOKEN_INVALID: 401,
  TOKEN_ENVIRONMENT_MISMATCH: 401,
  EMBED_TOKEN_INVALID: 401,
  INSUFFICIENT_SCOPE: 403,
  ORIGIN_NOT_ALLOWED: 403,
  EMBED_SCOPE_VIOLATION: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
} as const);
export type ProblemCode = keyof typeof PROBLEM_CODES;
const CODES = Object.keys(PROBLEM_CODES) as [ProblemCode, ...ProblemCode[]];

export const PROBLEM_TYPE_BASE = 'https://docs.ujira.co/errors/';

export const FieldErrorCode = z.enum([
  'unknown_field',
  'invalid_value',
  'unsupported_operator',
  'range_inverted',
]);

/**
 * RFC 9457 problem details. `code` is what clients branch on; `requestId`
 * is the reference a person quotes to support, and also the Request-Id
 * header of the same response.
 */
export const Problem = z
  .strictObject({
    type: z.url(),
    title: z.string().min(1).max(200),
    status: z.number().int().min(400).max(599),
    detail: z.string().max(1000).optional(),
    code: z.enum(CODES),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'an opaque request id'),
    errors: z
      .array(z.strictObject({ field: z.string().min(1).max(200), code: FieldErrorCode }))
      .min(1)
      .max(50)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type !== `${PROBLEM_TYPE_BASE}${value.code}`) {
      ctx.addIssue({ code: 'custom', path: ['type'], message: 'type must name the code' });
    }
    if (value.status !== PROBLEM_CODES[value.code]) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'status does not match the code' });
    }
  });
export type Problem = z.infer<typeof Problem>;
