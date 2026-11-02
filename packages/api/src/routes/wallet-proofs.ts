// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { WalletChallenge, WalletProofAccepted, WalletProofRequest } from '@ujira/api-schema';
import type { Uuid } from '@ujira/chain-adapter';
import { ProviderUnavailableError, WalletMethodNotFoundError } from '@ujira/identity';
import type { WalletProofFlow } from '@ujira/identity';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { defineTenantRoute } from '../route.js';
import type { Route, TenantRequestContext } from '../route.js';

export const WALLET_CHALLENGES_PATH = '/v1/recipients/{id}/methods/{methodId}/wallet-challenges';
export const WALLET_PROOFS_PATH = '/v1/recipients/{id}/methods/{methodId}/wallet-proofs';

/**
 * Stands in until the wallet proof flow has its database tables and the
 * adapter has its wallet proof methods. Nothing can be proven, and a client
 * can try again later.
 */
export const WALLET_PROOF_NOT_CONFIGURED: WalletProofFlow = Object.freeze({
  createWalletChallenge: () => Promise.reject(new ApiError('CHAIN_UNAVAILABLE')),
  submitWalletProof: () => Promise.reject(new ApiError('CHAIN_UNAVAILABLE')),
});

const MethodParams = z.strictObject({ id: z.uuid(), methodId: z.uuid() });

function identityContext(context: TenantRequestContext) {
  return {
    scope: {
      principalId: context.tenant.principalId as Uuid,
      projectId: context.tenant.projectId as Uuid,
    },
    correlationId: context.requestId,
    signal: context.signal,
  };
}

// The flow's faults, as the API says them. Anything else escapes to toApiError.
function mapped(error: unknown): unknown {
  if (error instanceof WalletMethodNotFoundError) return new ApiError('NOT_FOUND');
  if (error instanceof ProviderUnavailableError) return new ApiError('CHAIN_UNAVAILABLE');
  return error;
}

export function walletChallengeRoute(flow: WalletProofFlow): Route {
  return defineTenantRoute({
    id: 'createWalletChallenge',
    method: 'POST',
    path: WALLET_CHALLENGES_PATH,
    summary: 'Issue a challenge for a recipient to prove they control a payout destination',
    scope: 'recipients:write',
    params: MethodParams,
    response: { status: 201, name: 'WalletChallenge', schema: WalletChallenge },
    errors: ['NOT_FOUND', 'CHAIN_UNAVAILABLE'],
    handler: async ({ params }, context) => {
      const issued = await flow
        .createWalletChallenge(identityContext(context), {
          recipientId: params.id as Uuid,
          methodId: params.methodId as Uuid,
        })
        .catch((error: unknown) => {
          throw mapped(error);
        });
      return {
        challengeId: issued.challengeId,
        message: issued.message,
        nonce: issued.nonce,
        expiresAt: new Date(Number(issued.expiresAt) * 1_000).toISOString(),
      };
    },
  });
}

export function walletProofRoute(flow: WalletProofFlow): Route {
  return defineTenantRoute({
    id: 'submitWalletProof',
    method: 'POST',
    path: WALLET_PROOFS_PATH,
    summary: 'Record a signed wallet proof, once the destination can receive',
    scope: 'recipients:write',
    params: MethodParams,
    body: WalletProofRequest,
    response: { status: 201, name: 'WalletProofAccepted', schema: WalletProofAccepted },
    errors: [
      'WALLET_PROOF_INVALID',
      'WALLET_PROOF_EXPIRED',
      'WALLET_SIGNER_NOT_AUTHORIZED',
      'DESTINATION_NOT_RECEIVABLE',
      'CHAIN_UNAVAILABLE',
    ],
    handler: async ({ params, body }, context) => {
      const result = await flow
        .submitWalletProof(identityContext(context), {
          recipientId: params.id as Uuid,
          methodId: params.methodId as Uuid,
          challengeId: body.challengeId as Uuid,
          message: body.message,
          nonce: body.nonce,
          signature: body.signature,
          signer: body.signer,
        })
        .catch((error: unknown) => {
          throw mapped(error);
        });
      if (!result.accepted) {
        // A reason comes from a closed list of codes, never from the request.
        throw new ApiError(result.code, result.reason === null ? {} : { detail: result.reason });
      }
      return {
        verificationId: result.verificationId,
        level: 'wallet_signature' as const,
        signerKey: result.signerKey,
      };
    },
  });
}
