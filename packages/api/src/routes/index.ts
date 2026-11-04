// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every v1 route the server answers. Add a route by declaring it in its own
// file under routes/ and listing it here; the OpenAPI document, the
// registry checks and the route tests all read this list.

import type { WalletProofFlow } from '@ujira/identity';

import type { Route } from '../route.js';
import { healthRoute } from './health.js';
import { MANDATES_NOT_CONFIGURED, mandateRoutes } from './mandates.js';
import type { MandateEndpoints } from './mandates.js';
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
  readonly mandates: MandateEndpoints;
}

export function v1Routes(deps: RouteDependencies): readonly Route[] {
  return Object.freeze([
    healthRoute,
    selfWebhookRoute(deps.selfWebhook),
    walletChallengeRoute(deps.walletProof),
    walletProofRoute(deps.walletProof),
    ...mandateRoutes(deps.mandates),
  ]);
}

// The served table until Self has its secrets and durable stores: the webhook
// is listed and documented, and answers 503 rather than guessing.
export const V1_ROUTES: readonly Route[] = v1Routes({
  selfWebhook: SELF_WEBHOOK_NOT_CONFIGURED,
  walletProof: WALLET_PROOF_NOT_CONFIGURED,
  mandates: MANDATES_NOT_CONFIGURED,
});
