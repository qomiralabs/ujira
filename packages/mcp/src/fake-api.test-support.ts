// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A fake API from the contract's own mock handlers, so tests here read the same rules
// the dashboard's do. It answers as if no key was sent unless the right one was, so a
// test passing here shows the client really sent it.

import { generateFixtures } from '@ujira/api-schema/fixtures';
import { createHandlers } from '@ujira/api-schema/msw';
import { getResponse } from 'msw';

export const API_URL = 'https://api.test.invalid';

// Made here from parts, and of the right form only. No server holds it.
export const API_KEY = `ujk_test_${'a'.repeat(16)}_${'b'.repeat(59)}`;

export const fixtures = generateFixtures({ seed: 7, payouts: 40, edge: false });
const [first] = fixtures.tenants;
if (first === undefined) throw new Error('the fixtures hold no tenant');
export const HOME = first;

export interface FakeApi {
  readonly fetch: typeof fetch;
  /** Every request that reached the fake, in order. */
  readonly requests: Request[];
}

export function fakeApi(): FakeApi {
  const handlers = createHandlers({
    fixtures,
    baseUrl: API_URL,
    scope: (request) =>
      request.headers.get('authorization') === `Bearer ${API_KEY}` ? HOME : null,
  });
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return (await getResponse(handlers, request)) ?? new Response(null, { status: 404 });
    },
  };
}
