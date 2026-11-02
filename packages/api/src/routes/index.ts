// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every v1 route the server answers. Add a route by declaring it in its own
// file under routes/ and listing it here; the OpenAPI document, the
// registry checks and the route tests all read this list.

import type { Route } from '../route.js';
import { healthRoute } from './health.js';
import { SELF_WEBHOOK_NOT_CONFIGURED, selfWebhookRoute } from './self-webhook.js';
import type { SelfWebhookHandler } from './self-webhook.js';

/** What the routes are given; each is a port, so no route knows what is behind it. */
export interface RouteDependencies {
  readonly selfWebhook: SelfWebhookHandler;
}

export function v1Routes(deps: RouteDependencies): readonly Route[] {
  return Object.freeze([healthRoute, selfWebhookRoute(deps.selfWebhook)]);
}

// The served table until Self has its secrets and durable stores: the webhook
// is listed and documented, and answers 503 rather than guessing.
export const V1_ROUTES: readonly Route[] = v1Routes({
  selfWebhook: SELF_WEBHOOK_NOT_CONFIGURED,
});
