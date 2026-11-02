// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandate's config() and state() answers as the adapter's chain neutral
// views. Amounts become core token amounts in the settlement asset, which is
// USDC on Stellar at scale 7, so nothing above the adapter sees an i128.

import { tokenAmount } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';
import type { xdr } from '@stellar/stellar-sdk/base';

import { InternalError } from '../errors.js';
import type { NetworkId } from '../networks.js';
import type {
  ChainAddress,
  LimitsInput,
  MandateConfigView,
  MandateState,
  UnixSeconds,
} from '../types.js';
import {
  asAddress,
  asBool,
  asBytes,
  asBytes32,
  asI128,
  asOption,
  asU32,
  asU64,
  asVec,
  field,
  fieldsOf,
} from './scval.js';

const MODES: ReadonlyMap<number, MandateConfigView['recipientMode']> = new Map([
  [1, 'allowlist'],
  [2, 'attested'],
  [3, 'both'],
]);

function usdc(value: xdr.ScVal): TokenAmount {
  return tokenAmount(asI128(value), 'USDC', 'stellar');
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new InternalError();
  return Number(value);
}

export function limitsOf(value: xdr.ScVal): LimitsInput {
  const f = fieldsOf(value);
  return {
    totalBudget: usdc(field(f, 'total_budget')),
    perPaymentCap: usdc(field(f, 'per_payment_cap')),
    perRecipientDailyCap: usdc(field(f, 'per_recipient_daily_cap')),
    approvalThreshold: usdc(field(f, 'approval_threshold')),
    payoutTtlSeconds: safeNumber(asU64(field(f, 'payout_ttl_seconds'))),
    expiresAt: asU64(field(f, 'expires_at')) as UnixSeconds,
  };
}

export interface ViewContext {
  readonly network: NetworkId;
  readonly factory: string;
  readonly policyEpoch: number;
}

export function configViewOf(value: xdr.ScVal, ctx: ViewContext): MandateConfigView {
  const f = fieldsOf(value);
  const at = (text: string): ChainAddress => ({ network: ctx.network, value: text });
  const list = (name: string): readonly ChainAddress[] =>
    asVec(field(f, name)).map((v) => at(asAddress(v)));
  const mode = MODES.get(asU32(field(f, 'recipient_mode')));
  if (mode === undefined) throw new InternalError({ network: ctx.network });
  const attester = asOption(field(f, 'attester'));
  const proposed = asOption(field(f, 'proposed_principal'));
  return {
    principal: at(asAddress(field(f, 'principal'))),
    asset: 'USDC',
    recipientMode: mode,
    tenantTag: asBytes32(field(f, 'tenant_tag')),
    agents: list('agents'),
    approvers: list('approvers'),
    approvalsRequired: asU32(field(f, 'approvals_required')),
    guardians: list('guardians'),
    executors: list('executors'),
    recovery: list('recovery'),
    recoveryThreshold: asU32(field(f, 'recovery_threshold')),
    limits: limitsOf(field(f, 'limits')),
    attester: attester === null ? null : asBytes(attester),
    countryPolicyHash: asBytes32(field(f, 'country_policy_hash')),
    maxFeeBps: asU32(field(f, 'max_fee_bps')),
    factory: at(ctx.factory),
    feeAddress: at(asAddress(field(f, 'fee_address'))),
    policyEpoch: ctx.policyEpoch,
    proposedPrincipal: proposed === null ? null : at(asAddress(proposed)),
  };
}

export function stateOf(value: xdr.ScVal): MandateState {
  const f = fieldsOf(value);
  return {
    spent: usdc(field(f, 'spent')),
    pending: usdc(field(f, 'pending')),
    committed: usdc(field(f, 'committed')),
    balance: usdc(field(f, 'balance')),
    free: usdc(field(f, 'free')),
    paused: asBool(field(f, 'paused')),
    revoked: asBool(field(f, 'revoked')),
    expired: asBool(field(f, 'expired')),
    policyEpoch: safeNumber(asU64(field(f, 'policy_epoch'))),
  };
}
