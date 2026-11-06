// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The widget reads the API with its own small schemas. These tests hold them
// to the API's: whatever the API's schema accepts, the widget's must read the
// same way, and the constants the widget matches on must be the API's own.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PAYOUT_METHODS as API_PAYOUT_METHODS,
  Problem as ApiProblemSchema,
  PROBLEM_CODES,
  WalletChallenge as ApiWalletChallenge,
  WalletProofAccepted as ApiWalletProofAccepted,
} from '@ujira/api-schema';
import { describe, expect, it } from 'vitest';

import {
  API_METHODS,
  Problem,
  RECEIVABILITY_REASONS,
  UNSUPPORTED_MEMO_DETAIL,
  WalletChallenge,
  WalletProofAccepted,
} from './contract.js';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');

function source(path: string): string {
  return readFileSync(join(REPO, path), 'utf8');
}

describe('the widget contract', () => {
  it('knows the payout methods by the API names', () => {
    expect([...API_METHODS]).toEqual([...API_PAYOUT_METHODS]);
  });

  it('reads a wallet challenge the API would send', () => {
    const sent = ApiWalletChallenge.parse({
      challengeId: '0b9f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4',
      message: 'example.com asks you to confirm your payout address.',
      nonce: 'n0nce',
      expiresAt: '2026-11-05T12:05:00.000Z',
    });
    expect(WalletChallenge.parse(sent)).toEqual(sent);
  });

  it('reads an accepted proof the API would send', () => {
    const sent = ApiWalletProofAccepted.parse({
      verificationId: '0b9f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4',
      level: 'wallet_signature',
      signerKey: `G${'A'.repeat(55)}`,
    });
    const read = WalletProofAccepted.parse(sent);
    expect(read.verificationId).toBe(sent.verificationId);
  });

  it('reads every problem code the API can send', () => {
    for (const [code, status] of Object.entries(PROBLEM_CODES)) {
      const sent = ApiProblemSchema.parse({
        type: `https://docs.ujira.co/errors/${code}`,
        title: 'Refused',
        status,
        code,
        requestId: 'req_12345678',
      });
      expect(Problem.parse(sent)).toMatchObject({ code, status });
    }
  });

  it('branches only on problem codes the API has', () => {
    for (const code of [
      'DESTINATION_INVALID',
      'DESTINATION_NOT_RECEIVABLE',
      'WALLET_PROOF_INVALID',
      'WALLET_PROOF_EXPIRED',
      'WALLET_SIGNER_NOT_AUTHORIZED',
    ]) {
      expect(Object.keys(PROBLEM_CODES)).toContain(code);
    }
  });

  it('matches the API text for a destination that needs a text memo', () => {
    const errors = source('packages/chain-adapter/src/errors.ts');
    const constant = /UNSUPPORTED_MEMO_DESTINATION_MESSAGE =\s*'([^']+)'/.exec(errors)?.[1];
    expect(constant).toBe(UNSUPPORTED_MEMO_DETAIL);
  });

  it('knows every reason a destination cannot receive', () => {
    const types = source('packages/chain-adapter/src/types.ts');
    const union = /export type ReceivabilityReason =([^;]+);/.exec(types)?.[1] ?? '';
    const reasons = [...union.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(reasons).toEqual([...RECEIVABILITY_REASONS]);
  });
});
