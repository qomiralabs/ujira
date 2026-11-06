// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A tenant write's answer is stored in clear for 7 days so a retry can get it back,
// and personal data has one home, encrypted. So a write route cannot be declared
// with personal data in its response at all: the server refuses to start.

import { personalData } from '@ujira/api-schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import { refuseAllCredentials } from './auth.js';
import { RouteRegistryError } from './errors.js';
import { memoryIdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { withOpenApiRoute } from './openapi.js';
import { allowEveryRequest } from './rate-limit.js';
import { defineTenantRoute, storedResponseProblems } from './route.js';
import { V1_ROUTES } from './routes/index.js';

function route(method: 'POST' | 'GET', schema: z.ZodType) {
  return defineTenantRoute({
    id: 'thing',
    method,
    path: '/v1/things',
    summary: 'A thing',
    scope: 'recipients:write',
    response: { name: 'Thing', schema },
    handler: () => Promise.resolve({} as never),
  });
}

describe('what a write route may store', () => {
  it.each(['email', 'phone', 'fullName', 'firstName', 'dateOfBirth', 'nationalId', 'homeAddress'])(
    'refuses a field named %s',
    (field) => {
      const schema = z.strictObject({ id: z.string(), [field]: z.string() });
      expect(storedResponseProblems([route('POST', schema)])).toEqual([
        `route thing stores its answer for replay, and ${field} is personal data`,
      ]);
    },
  );

  it('refuses a field marked as personal data, whatever it is called', () => {
    const schema = z.strictObject({ label: personalData(z.string()) });
    expect(storedResponseProblems([route('POST', schema)])).toEqual([
      'route thing stores its answer for replay, and label is personal data',
    ]);
  });

  it('finds it nested in objects, arrays and unions', () => {
    const schema = z.strictObject({
      recipients: z.array(z.strictObject({ contact: z.strictObject({ email: z.string() }) })),
      either: z.union([z.strictObject({ phone: z.string() }), z.string()]).nullable(),
    });
    const problems = storedResponseProblems([route('POST', schema)]);
    expect(problems).toHaveLength(2);
    expect(problems.join()).toContain('recipients.contact.email');
    expect(problems.join()).toContain('phone');
  });

  it('leaves alone the words that mean something else here', () => {
    const schema = z.strictObject({
      name: z.string(),
      address: z.string(),
      fundingAddress: z.string(),
      country: z.string(),
    });
    expect(storedResponseProblems([route('POST', schema)])).toEqual([]);
  });

  it('allows it on a read, which is not stored', () => {
    const schema = z.strictObject({ email: personalData(z.string()), phone: z.string() });
    expect(storedResponseProblems([route('GET', schema)])).toEqual([]);
  });

  it('stops the server starting with such a route', () => {
    const schema = z.strictObject({ email: z.string() });
    expect(() =>
      createApp({
        routes: [route('POST', schema)],
        authenticate: refuseAllCredentials,
        rateLimit: allowEveryRequest,
        idempotency: memoryIdempotencyStore(),
        logger: memoryLogger(),
      }),
    ).toThrow(RouteRegistryError);
  });

  it('holds for every route the server serves', () => {
    expect(storedResponseProblems(withOpenApiRoute(V1_ROUTES).routes)).toEqual([]);
  });
});
