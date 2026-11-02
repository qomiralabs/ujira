// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { SelfWebhookAck } from '@ujira/api-schema';
import { SELF_SIGNATURE_HEADER } from '@ujira/identity';
import type { SelfVerification } from '@ujira/identity';

import { ApiError } from '../errors.js';
import { defineWebhookRoute } from '../route.js';
import type { Route } from '../route.js';

export const SELF_WEBHOOK_PATH = '/v1/identity/self-webhook';

/** The one thing the route needs of the identity service. */
export type SelfWebhookHandler = Pick<SelfVerification, 'handleWebhook'>;

/**
 * Stands in until Self has its webhook secret and durable stores. It fails
 * closed: with no secret nothing can be verified, and a provider retries a
 * 503 later rather than losing the delivery to a state a restart would forget.
 */
export const SELF_WEBHOOK_NOT_CONFIGURED: SelfWebhookHandler = Object.freeze({
  handleWebhook: () => Promise.reject(new ApiError('WEBHOOK_UNAVAILABLE')),
});

export function selfWebhookRoute(verification: SelfWebhookHandler): Route {
  return defineWebhookRoute({
    id: 'receiveSelfWebhook',
    path: SELF_WEBHOOK_PATH,
    summary: 'Receive a verification result from Self',
    reason: 'Self signs every delivery over its exact bytes, and that signature replaces a key.',
    headers: [SELF_SIGNATURE_HEADER],
    response: { name: 'SelfWebhookAck', schema: SelfWebhookAck },
    errors: [
      'WEBHOOK_SIGNATURE_INVALID',
      'WEBHOOK_PAYLOAD_INVALID',
      'WEBHOOK_REJECTED',
      'WEBHOOK_UNAVAILABLE',
    ],
    handler: async ({ rawBody, headers }, { requestId }) => {
      const answer = await verification.handleWebhook({
        rawBody,
        headers,
        correlationId: requestId,
      });
      if (answer.status === 400) throw new ApiError(answer.body.code);
      return answer.body;
    },
  });
}
