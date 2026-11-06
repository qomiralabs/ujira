// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the widget does when UJIRA refuses an answer: which step the person
// lands on and the words they read there. Pure, so every refusal the API can
// give is tested without a browser.

import { ApiProblem } from './api/client.js';
import {
  isReceivabilityReason,
  UNSUPPORTED_MEMO_DETAIL,
  type ReceivabilityReason,
} from './api/contract.js';
import type { MessageKey } from './i18n/catalogue.js';

/** The embed token is no longer good, so nothing more can be saved. */
export interface Expired {
  kind: 'expired';
}

export interface Shown {
  kind: 'message';
  key: MessageKey;
}

const EXPIRED: Expired = { kind: 'expired' };

function codeOf(error: unknown): string | undefined {
  return error instanceof ApiProblem ? error.problem.code : undefined;
}

function isExpiry(error: unknown): boolean {
  return error instanceof ApiProblem && error.problem.status === 401;
}

/** Where a refused save sends the person back to. */
export type SaveOutcome = Expired | (Shown & { step: 'destination' | 'review' });

export function afterSaveFailed(error: unknown): SaveOutcome {
  if (isExpiry(error)) return EXPIRED;
  if (codeOf(error) === 'DESTINATION_INVALID') {
    const detail = error instanceof ApiProblem ? error.problem.detail : undefined;
    const key =
      detail === UNSUPPORTED_MEMO_DETAIL ? 'destination.memo.unsupported' : 'destination.refused';
    return { kind: 'message', step: 'destination', key };
  }
  return { kind: 'message', step: 'review', key: 'widget.saveFailed' };
}

const NOT_RECEIVABLE: Readonly<Record<ReceivabilityReason, MessageKey>> = {
  ACCOUNT_NOT_FOUND: 'receive.accountNotFound',
  DESTINATION_IS_ISSUER: 'destination.wallet.unpayable',
  NO_TRUSTLINE: 'receive.noTrustline',
  TRUSTLINE_NOT_AUTHORIZED: 'receive.notAuthorized',
  TRUSTLINE_LIMIT: 'receive.limit',
};

/** The two a sponsored activation fixes: no account, or no USDC line yet. */
const ACTIVATABLE: readonly ReceivabilityReason[] = ['ACCOUNT_NOT_FOUND', 'NO_TRUSTLINE'];

export function receivabilityMessage(reason: ReceivabilityReason): MessageKey {
  return NOT_RECEIVABLE[reason];
}

/** Where a refused wallet proof sends the person. */
export type ProofOutcome = Expired | Shown | { kind: 'activate'; reason: ReceivabilityReason };

/**
 * `canActivate` is true when the session offers free activation and the
 * page's wallet can sign a transaction. Activation is offered first for the
 * two reasons it fixes, and the plain words otherwise.
 */
export function afterProofFailed(error: unknown, canActivate: boolean): ProofOutcome {
  if (isExpiry(error)) return EXPIRED;
  const code = codeOf(error);
  if (code === 'DESTINATION_NOT_RECEIVABLE') {
    const detail = error instanceof ApiProblem ? error.problem.detail : undefined;
    if (!isReceivabilityReason(detail)) return { kind: 'message', key: 'destination.refused' };
    if (canActivate && ACTIVATABLE.includes(detail)) return { kind: 'activate', reason: detail };
    return { kind: 'message', key: NOT_RECEIVABLE[detail] };
  }
  if (code === 'WALLET_SIGNER_NOT_AUTHORIZED') {
    return { kind: 'message', key: 'receive.signerNotAuthorized' };
  }
  if (code === 'WALLET_PROOF_INVALID') return { kind: 'message', key: 'prove.invalid' };
  if (code === 'WALLET_PROOF_EXPIRED') return { kind: 'message', key: 'prove.expired' };
  return { kind: 'message', key: 'widget.saveFailed' };
}
