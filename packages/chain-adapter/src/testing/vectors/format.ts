// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The vector format, ujira-mandate-vectors/1, as far as the runner reads it.
// Vector files are outside data, so every part the runner acts on is
// checked here before it is used; expectations stay raw JSON because the
// comparator reads them the way the contracts' comparator does.

import { z } from 'zod';

import { U32_MAX } from '../spec.js';

import type { Json } from './json.js';

const NAME = /^[a-z][a-z0-9_]*$/;

export const actor = z.string().regex(NAME);
export const bytes32 = z.string().regex(/^(0x[0-9a-f]{64}|#[a-z][a-z0-9_]*)$/);
export const amount = z.string().regex(/^(0|-?[1-9][0-9]{0,38})$/);
export const u64 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((s) => BigInt(s) < 1n << 64n, 'above u64');
export const u32 = z.number().int().min(0).max(U32_MAX);
const json = z.json() as z.ZodType<Json>;

export const tag = z.union([
  z.null(),
  u64,
  z.object({ has_tag: z.literal(false), tag: u64 }).strict(),
]);
export const destination = z.object({ address: actor, tag }).strict();
export const leg = z.object({ destination, amount }).strict();
export const limits = z
  .object({
    total_budget: amount,
    per_payment_cap: amount,
    per_recipient_daily_cap: amount,
    approval_threshold: amount,
    payout_ttl_seconds: u64,
    expires_at: u64,
  })
  .strict();
export const attesterKey = z.union([
  z.string().regex(/^(#[a-z][a-z0-9_]*|0x([0-9a-f]{2}){0,64})$/),
  z.object({ account_key: actor }).strict(),
]);
export const config = z
  .object({
    principal: actor,
    asset: z.enum(['asset', 'other_token']),
    recipient_mode: z.enum(['ALLOWLIST', 'ATTESTED', 'BOTH']),
    tenant_ref: bytes32,
    agents: z.array(actor),
    approvers: z.array(actor),
    approvals_required: u32,
    guardians: z.array(actor),
    executors: z.array(actor),
    recovery: z.array(actor),
    recovery_threshold: u32,
    limits,
    attester: z.union([z.null(), attesterKey]),
    country_policy_hash: bytes32,
    max_fee_bps: u32,
  })
  .strict();
export const allowEntry = z.object({ recipient_ref: bytes32, destination }).strict();
export const request = z
  .object({
    payout_id: bytes32,
    recipient_ref: bytes32,
    total: amount,
    fee: amount.default('0'),
    legs: z.array(leg),
    deadline: u64,
    task_ref: bytes32,
    attestations: z.array(z.string().regex(NAME)),
  })
  .strict();

const token = z.enum(['asset', 'other_token']);
const tokenSpec = z
  .object({
    kind: z.enum(['standard', 'reentrant', 'moves_settlement', 'returns_value', 'returns_no_data']),
    reenters: z.enum(['sweep', 'cancel', 'execute']).optional(),
    variant: z.enum(['propagate', 'catch']).optional(),
    payout_id: bytes32.optional(),
  })
  .strict();
const positive = z.string().regex(/^[1-9][0-9]{0,38}$/);

export const setup = z
  .object({
    now: u64,
    actors: z
      .record(actor, z.object({ kind: z.enum(['account', 'contract']) }).strict())
      .optional(),
    tokens: z
      .object({ asset: tokenSpec.optional(), other_token: tokenSpec.optional() })
      .strict()
      .optional(),
    mandate: config.optional(),
    salt: bytes32.optional(),
    allowlist: z.array(allowEntry).optional(),
    mints: z.array(z.object({ token, to: actor, amount: positive }).strict()).optional(),
    transfers: z
      .array(z.object({ token, from: actor, to: actor, amount: positive }).strict())
      .optional(),
  })
  .strict();

export const callStep = z
  .object({
    step: z.literal('call'),
    fn: z.string(),
    caller: actor,
    signed_by: actor.optional(),
    args: z.record(z.string(), json).optional(),
    precedence: z.array(z.string()).optional(),
    expect: json,
  })
  .strict();

export const step = z.discriminatedUnion('step', [
  callStep,
  z.object({ step: z.literal('advance_time'), seconds: u64 }).strict(),
  z.object({ step: z.literal('set_time'), now: u64 }).strict(),
  z
    .object({
      step: z.literal('transfer'),
      token,
      from: actor,
      to: actor,
      amount: positive,
      events: z.array(json).max(0).optional(),
    })
    .strict(),
  z.object({ step: z.literal('mint'), token, to: actor, amount: positive }).strict(),
  z
    .object({
      step: z.literal('attest'),
      name: z.string().regex(NAME),
      signer: z.string().regex(/^#[a-z][a-z0-9_]*$/),
      recipient_ref: bytes32,
      destination,
      valid_until: u64,
      policy_epoch: u64.optional(),
      tamper: z.string().optional(),
    })
    .strict(),
  z
    .object({
      step: z.literal('set_receiving'),
      token: z.literal('asset'),
      account: actor,
      state: z.enum(['receivable', 'no_trustline', 'deauthorized']),
    })
    .strict(),
  z
    .object({
      step: z.literal('clawback'),
      token: z.literal('asset'),
      from: actor,
      amount: positive,
    })
    .strict(),
]);

export const vector = z
  .object({
    id: z.string().regex(NAME),
    rules: z.array(z.string()).min(1),
    description: z.string(),
    applies_to: z
      .array(z.enum(['stellar', 'celo']))
      .min(1)
      .optional(),
    skip_reason: z.literal('unrepresentable_input').optional(),
    setup,
    steps: z.array(step).min(1),
  })
  .strict();

export const vectorFile = z
  .object({
    format: z.literal('ujira-mandate-vectors/1'),
    description: z.string().optional(),
    vectors: z.array(z.json()).min(1),
  })
  .strict();

export type Setup = z.infer<typeof setup>;
export type Step = z.infer<typeof step>;
export type CallStep = z.infer<typeof callStep>;
export type Destination = z.infer<typeof destination>;
export type Config = z.infer<typeof config>;
export type TokenSpec = z.infer<typeof tokenSpec>;

/** A vector as parsed, with the raw JSON the comparator reads beside it. */
export interface LoadedVector {
  readonly file: string;
  readonly parsed: z.infer<typeof vector>;
  readonly raw: Record<string, Json>;
}

/** Whether a vector runs on `chain`: every chain unless applies_to lists fewer. */
export function appliesTo(v: LoadedVector, chain: 'stellar' | 'celo'): boolean {
  return v.parsed.applies_to === undefined || v.parsed.applies_to.includes(chain);
}
