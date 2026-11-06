// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { ApiProblem, ApiUnreachable } from './api/client.js';
import { RECEIVABILITY_REASONS, UNSUPPORTED_MEMO_DETAIL } from './api/contract.js';
import { en } from './i18n/en.js';
import { afterProofFailed, afterSaveFailed, receivabilityMessage } from './outcomes.js';

function refused(status: number, code: string, detail?: string): ApiProblem {
  return new ApiProblem({ status, code, ...(detail === undefined ? {} : { detail }) });
}

describe('after a save is refused', () => {
  it('sends a text memo back to the destination with the unsupported message', () => {
    expect(afterSaveFailed(refused(422, 'DESTINATION_INVALID', UNSUPPORTED_MEMO_DETAIL))).toEqual({
      kind: 'message',
      step: 'destination',
      key: 'destination.memo.unsupported',
    });
  });

  it('sends any other refused destination back with plain words', () => {
    expect(afterSaveFailed(refused(422, 'DESTINATION_INVALID'))).toEqual({
      kind: 'message',
      step: 'destination',
      key: 'destination.refused',
    });
  });

  it('keeps the person on the review when the save itself failed', () => {
    for (const error of [refused(503, 'DB_UNAVAILABLE'), new ApiUnreachable('offline')]) {
      expect(afterSaveFailed(error)).toEqual({
        kind: 'message',
        step: 'review',
        key: 'widget.saveFailed',
      });
    }
  });

  it('stops when the embed token is no longer good', () => {
    expect(afterSaveFailed(refused(401, 'EMBED_TOKEN_INVALID'))).toEqual({ kind: 'expired' });
  });
});

describe('after a wallet proof is refused', () => {
  it('offers free activation first for a missing account or USDC line, when it can', () => {
    for (const reason of ['ACCOUNT_NOT_FOUND', 'NO_TRUSTLINE']) {
      expect(afterProofFailed(refused(422, 'DESTINATION_NOT_RECEIVABLE', reason), true)).toEqual({
        kind: 'activate',
        reason,
      });
    }
  });

  it('says what to do in the wallet when activation is not on offer', () => {
    expect(
      afterProofFailed(refused(422, 'DESTINATION_NOT_RECEIVABLE', 'ACCOUNT_NOT_FOUND'), false),
    ).toEqual({ kind: 'message', key: 'receive.accountNotFound' });
    expect(
      afterProofFailed(refused(422, 'DESTINATION_NOT_RECEIVABLE', 'NO_TRUSTLINE'), false),
    ).toEqual({ kind: 'message', key: 'receive.noTrustline' });
  });

  it('never offers activation for what activation cannot fix', () => {
    const cases = {
      TRUSTLINE_NOT_AUTHORIZED: 'receive.notAuthorized',
      TRUSTLINE_LIMIT: 'receive.limit',
      DESTINATION_IS_ISSUER: 'destination.wallet.unpayable',
    } as const;
    for (const [reason, key] of Object.entries(cases)) {
      expect(afterProofFailed(refused(422, 'DESTINATION_NOT_RECEIVABLE', reason), true)).toEqual({
        kind: 'message',
        key,
      });
    }
  });

  it('has words for every reason the API can give', () => {
    for (const reason of RECEIVABILITY_REASONS) {
      expect(en[receivabilityMessage(reason)]).toBeTypeOf('string');
    }
  });

  it('does not trust a reason it does not know', () => {
    expect(afterProofFailed(refused(422, 'DESTINATION_NOT_RECEIVABLE', '<script>'), true)).toEqual({
      kind: 'message',
      key: 'destination.refused',
    });
  });

  it('explains a key that is no longer a signer of the account', () => {
    expect(afterProofFailed(refused(422, 'WALLET_SIGNER_NOT_AUTHORIZED'), true)).toEqual({
      kind: 'message',
      key: 'receive.signerNotAuthorized',
    });
  });

  it('asks for a new signature when the old one did not match or ran out of time', () => {
    expect(afterProofFailed(refused(422, 'WALLET_PROOF_INVALID'), true)).toEqual({
      kind: 'message',
      key: 'prove.invalid',
    });
    expect(afterProofFailed(refused(422, 'WALLET_PROOF_EXPIRED'), true)).toEqual({
      kind: 'message',
      key: 'prove.expired',
    });
  });

  it('stops when the token expired, and says so plainly for anything else', () => {
    expect(afterProofFailed(refused(401, 'EMBED_TOKEN_INVALID'), true)).toEqual({
      kind: 'expired',
    });
    expect(afterProofFailed(new Error('boom'), true)).toEqual({
      kind: 'message',
      key: 'widget.saveFailed',
    });
  });
});
