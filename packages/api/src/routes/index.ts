// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every v1 route the server answers. Add a route by declaring it in its own
// file under routes/ and listing it here; the OpenAPI document, the
// registry checks and the route tests all read this list.

import type { WalletProofFlow } from '@ujira/identity';

import type { ApiKeyEndpoints } from '../api-key-service.js';
import type { Route } from '../route.js';
import { API_KEYS_NOT_CONFIGURED, apiKeyRoutes } from './api-keys.js';
import { healthRoute } from './health.js';
import { SELF_WEBHOOK_NOT_CONFIGURED, selfWebhookRoute } from './self-webhook.js';
import type { SelfWebhookHandler } from './self-webhook.js';
import {
  WALLET_PROOF_NOT_CONFIGURED,
  walletChallengeRoute,
  walletProofRoute,
} from './wallet-proofs.js';

/** What the routes are given; each is a port, so no route knows what is behind it. */
export interface RouteDependencies {
  readonly selfWebhook: SelfWebhookHandler;
  readonly walletProof: WalletProofFlow;
  readonly apiKeys: ApiKeyEndpoints;
}

export function v1Routes(deps: RouteDependencies): readonly Route[] {
  return Object.freeze([
    healthRoute,
    selfWebhookRoute(deps.selfWebhook),
    walletChallengeRoute(deps.walletProof),
    walletProofRoute(deps.walletProof),
    ...apiKeyRoutes(deps.apiKeys),
  ]);
}

// The served table until Self has its secrets and durable stores: the webhook
// is listed and documented, and answers 503 rather than guessing.
export const V1_ROUTES: readonly Route[] = v1Routes({
  selfWebhook: SELF_WEBHOOK_NOT_CONFIGURED,
  walletProof: WALLET_PROOF_NOT_CONFIGURED,
  apiKeys: API_KEYS_NOT_CONFIGURED,
});
