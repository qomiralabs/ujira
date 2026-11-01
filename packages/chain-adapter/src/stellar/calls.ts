// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Each mandate action as the contract call it becomes: which contract, which
// function and which arguments. Calls that take a `caller` get the signing
// address there and nowhere else, so the account that authorizes the call is
// always the one the call names.

import type { xdr } from '@stellar/stellar-sdk/base';
import type { TokenAmount } from '@ujira/core';

import { InvalidInputError } from '../errors.js';
import type { LimitsInput, MandateAction, MandateConfigInput, RoleName } from '../types.js';
import {
  address,
  bytes,
  bytes32,
  destination,
  i128,
  option,
  struct,
  u32,
  u64,
  vec,
} from './scval.js';

export interface Invocation {
  readonly contract: string;
  readonly fn: string;
  readonly args: readonly xdr.ScVal[];
}

export interface CallContext {
  /** The mandate's C address; unused for create. */
  readonly mandate: string;
  /** The signing address, passed as `caller` where the call takes one. */
  readonly caller: string;
  /** The settlement asset's token contract. */
  readonly assetContract: string;
}

const ROLE_CODES: Readonly<Record<RoleName, number>> = {
  agent: 1,
  approver: 2,
  guardian: 3,
  executor: 4,
  recovery: 5,
};

const RECIPIENT_MODES = { allowlist: 1, attested: 2, both: 3 } as const;

function amount(field: string, value: TokenAmount): xdr.ScVal {
  // Typed as USDC on Stellar today, checked anyway: an amount in any other
  // asset must never be read as USDC units.
  const { asset, chain } = value as { readonly asset: unknown; readonly chain: unknown };
  if (asset !== 'USDC' || chain !== 'stellar') {
    throw new InvalidInputError({ issues: [`${field} (wrong_asset)`] });
  }
  return i128(field, value.amount);
}

function addresses(field: string, list: readonly { readonly value: string }[]): xdr.ScVal {
  return vec(list.map((a, i) => address(`${field}.${String(i)}`, a.value)));
}

export function limitsScVal(limits: LimitsInput): xdr.ScVal {
  return struct({
    total_budget: amount('limits.totalBudget', limits.totalBudget),
    per_payment_cap: amount('limits.perPaymentCap', limits.perPaymentCap),
    per_recipient_daily_cap: amount('limits.perRecipientDailyCap', limits.perRecipientDailyCap),
    approval_threshold: amount('limits.approvalThreshold', limits.approvalThreshold),
    payout_ttl_seconds: u64('limits.payoutTtlSeconds', BigInt(limits.payoutTtlSeconds)),
    expires_at: u64('limits.expiresAt', limits.expiresAt),
  });
}

export function configScVal(config: MandateConfigInput, assetContract: string): xdr.ScVal {
  if ((config.asset as unknown) !== 'USDC') {
    throw new InvalidInputError({ issues: ['config.asset (invalid)'] });
  }
  const mode: unknown = RECIPIENT_MODES[config.recipientMode];
  if (typeof mode !== 'number') {
    throw new InvalidInputError({ issues: ['config.recipientMode (invalid)'] });
  }
  return struct({
    principal: address('config.principal', config.principal.value),
    asset: address('config.asset', assetContract),
    recipient_mode: u32('config.recipientMode', mode),
    tenant_ref: bytes32('config.tenantRef', config.tenantRef),
    agents: addresses('config.agents', config.agents),
    approvers: addresses('config.approvers', config.approvers),
    approvals_required: u32('config.approvalsRequired', config.approvalsRequired),
    guardians: addresses('config.guardians', config.guardians),
    executors: addresses('config.executors', config.executors),
    recovery: addresses('config.recovery', config.recovery),
    recovery_threshold: u32('config.recoveryThreshold', config.recoveryThreshold),
    limits: limitsScVal(config.limits),
    attester: option(config.attester === null ? null : bytes('config.attester', config.attester)),
    country_policy_hash: bytes32('config.countryPolicyHash', config.countryPolicyHash),
    max_fee_bps: u32('config.maxFeeBps', config.maxFeeBps),
  });
}

function role(field: string, name: RoleName): xdr.ScVal {
  const code: unknown = ROLE_CODES[name];
  if (typeof code !== 'number') throw new InvalidInputError({ issues: [`${field} (invalid)`] });
  return u32(field, code);
}

/** The contract call for an action. */
export function invocationOf(action: MandateAction, ctx: CallContext): Invocation {
  const on = (fn: string, args: readonly xdr.ScVal[] = []): Invocation => ({
    contract: ctx.mandate,
    fn,
    args,
  });
  const caller = (): xdr.ScVal => address('caller', ctx.caller);
  switch (action.op) {
    case 'create':
      return {
        contract: action.factory.value,
        fn: 'create',
        args: [configScVal(action.config, ctx.assetContract), bytes32('salt', action.salt)],
      };
    case 'pause':
    case 'sweep':
    case 'recovery_revoke':
      return on(action.op, [caller()]);
    case 'approve':
    case 'reject':
    case 'cancel':
      return on(action.op, [caller(), bytes32('payoutId', action.payoutId)]);
    case 'cancel_batch':
      return on('cancel_batch', [
        caller(),
        vec(action.payoutIds.map((id, i) => bytes32(`payoutIds.${String(i)}`, id))),
      ]);
    case 'recovery_rotate_agent':
      return on('recovery_rotate_agent', [
        caller(),
        address('old', action.old.value),
        option(action.new === null ? null : address('new', action.new.value)),
      ]);
    case 'resume':
    case 'revoke':
    case 'cancel_principal_proposal':
    case 'accept_principal':
      return on(action.op);
    case 'withdraw':
      return on('withdraw', [amount('amount', action.amount)]);
    case 'recover_token':
      return on('recover_token', [
        address('token', action.token.value),
        i128('amount', action.amount),
      ]);
    case 'update_limits':
      return on('update_limits', [limitsScVal(action.limits)]);
    case 'add_role':
    case 'remove_role':
      return on(action.op, [role('role', action.role), address('account', action.account.value)]);
    case 'set_approvals_required':
    case 'set_recovery_threshold':
      return on(action.op, [u32('n', action.n)]);
    case 'lower_fee_cap':
      return on('lower_fee_cap', [u32('maxFeeBps', action.maxFeeBps)]);
    case 'allow_recipients':
    case 'disallow_recipients':
      return on(action.op, [
        vec(
          action.entries.map((entry, i) =>
            struct({
              recipient_ref: bytes32(`entries.${String(i)}.recipientRef`, entry.recipientRef),
              destination: destination(`entries.${String(i)}.destination`, entry.destination),
            }),
          ),
        ),
      ]);
    case 'set_attestation_policy':
      return on('set_attestation_policy', [
        bytes('attester', action.attester),
        bytes32('countryPolicyHash', action.countryPolicyHash),
      ]);
    case 'propose_principal':
      return on('propose_principal', [address('proposed', action.proposed.value)]);
    default:
      throw new InvalidInputError({ issues: ['action.op (unsupported)'] });
  }
}
