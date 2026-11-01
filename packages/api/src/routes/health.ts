// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

import { definePublicRoute } from '../route.js';

export const Health = z.strictObject({ status: z.literal('ok') });

/**
 * Liveness only: the process is up and serving. It does not touch the
 * database or a network, so a dependency outage shows up as 503 on the
 * routes that need it rather than taking every instance out of rotation.
 */
export const healthRoute = definePublicRoute({
  id: 'getHealth',
  method: 'GET',
  path: '/v1/health',
  summary: 'Whether the API is up',
  reason: 'Load balancers and uptime checks call it without a key; it returns no tenant data.',
  response: { name: 'Health', schema: Health },
  handler: () => Promise.resolve({ status: 'ok' as const }),
});
