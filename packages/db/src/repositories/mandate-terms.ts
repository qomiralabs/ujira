// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What was agreed when a mandate was created, and the signing requests handed out
// for it. Both are keyed by the request's Idempotency-Key, so a handler that runs
// twice, after a process died mid request, finds its own earlier work. As
// everywhere, no method takes a tenant id.

import type { Money } from '@ujira/core';
import { sql, type Kysely } from 'kysely';

import { amountParam, fiatFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.generated.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export interface MandateLimitsRecord {
  readonly totalBudget: Money;
  readonly perPaymentCap: Money;
  readonly perRecipientDailyCap: Money;
  readonly approvalThreshold: Money;
}

export interface NewMandateTerms {
  readonly mandateId: string;
  readonly creationKey: string;
  readonly recipientMode: 'allowlist' | 'attested' | 'both';
  readonly limits: MandateLimitsRecord;
  readonly countryPolicyHash: Buffer;
  readonly maxFeeBps: number;
  readonly agreedFeeBps: number;
  readonly payoutTtlSeconds: number;
  readonly expiresAt: Date;
}

export interface MandateTerms extends NewMandateTerms {
  readonly createdAt: Date;
}

export type MandateActionOp =
  'create' | 'lower_fee_cap' | 'revoke' | 'withdraw' | 'cancel_principal_proposal';

export interface NewMandateActionRequest {
  readonly mandateId: string;
  readonly mandateInstanceId: string;
  readonly op: MandateActionOp;
  readonly idempotencyKey: string;
  readonly signingRequest: unknown;
  // Set exactly on a create.
  readonly instancePlan: unknown;
}

export interface MandateActionRequest {
  readonly mandateId: string;
  readonly mandateInstanceId: string;
  readonly op: string;
  readonly signingRequest: unknown;
  readonly instancePlan: unknown;
}

const termsColumns = [
  'mandate_id',
  'creation_key',
  'recipient_mode',
  'total_budget',
  'per_payment_cap',
  'per_recipient_daily_cap',
  'approval_threshold',
  'currency',
  'scale',
  'country_policy_hash',
  'max_fee_bps',
  'agreed_fee_bps',
  'payout_ttl_seconds',
  'expires_at',
  'created_at',
] as const;

function toTerms(row: {
  mandate_id: string;
  creation_key: string;
  recipient_mode: string;
  total_budget: string;
  per_payment_cap: string;
  per_recipient_daily_cap: string;
  approval_threshold: string;
  currency: string;
  scale: number;
  country_policy_hash: Buffer;
  max_fee_bps: string;
  agreed_fee_bps: string;
  payout_ttl_seconds: string;
  expires_at: Date;
  created_at: Date;
}): MandateTerms {
  const fiat = (amount: string): Money =>
    fiatFromRow({ amount, currency: row.currency, scale: row.scale });
  return {
    mandateId: row.mandate_id,
    creationKey: row.creation_key,
    recipientMode: row.recipient_mode as MandateTerms['recipientMode'],
    limits: {
      totalBudget: fiat(row.total_budget),
      perPaymentCap: fiat(row.per_payment_cap),
      perRecipientDailyCap: fiat(row.per_recipient_daily_cap),
      approvalThreshold: fiat(row.approval_threshold),
    },
    countryPolicyHash: row.country_policy_hash,
    maxFeeBps: Number(row.max_fee_bps),
    agreedFeeBps: Number(row.agreed_fee_bps),
    payoutTtlSeconds: Number(row.payout_ttl_seconds),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export const mandateTerms = {
  // False when another run already holds this creation key, whose mandate stands.
  create: async (db: Tx, input: NewMandateTerms): Promise<boolean> => {
    const { limits } = input;
    const won = await db
      .insertInto('ujira.mandate_terms')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_id: input.mandateId,
        creation_key: input.creationKey,
        recipient_mode: input.recipientMode,
        total_budget: amountParam(limits.totalBudget),
        per_payment_cap: amountParam(limits.perPaymentCap),
        per_recipient_daily_cap: amountParam(limits.perRecipientDailyCap),
        approval_threshold: amountParam(limits.approvalThreshold),
        currency: limits.totalBudget.currency,
        scale: limits.totalBudget.scale,
        country_policy_hash: input.countryPolicyHash,
        max_fee_bps: input.maxFeeBps,
        agreed_fee_bps: input.agreedFeeBps,
        payout_ttl_seconds: input.payoutTtlSeconds,
        expires_at: input.expiresAt,
      })
      .onConflict((conflict) => conflict.constraint('mandate_terms_creation_once').doNothing())
      .returning('mandate_id')
      .executeTakeFirst();
    return won !== undefined;
  },

  get: async (db: Tx, mandateId: string): Promise<MandateTerms | undefined> => {
    const row = await db
      .selectFrom('ujira.mandate_terms')
      .select(termsColumns)
      .where('mandate_id', '=', mandateId)
      .executeTakeFirst();
    return row === undefined ? undefined : toTerms(row);
  },

  getByCreationKey: async (db: Tx, creationKey: string): Promise<MandateTerms | undefined> => {
    const row = await db
      .selectFrom('ujira.mandate_terms')
      .select(termsColumns)
      .where('creation_key', '=', creationKey)
      .executeTakeFirst();
    return row === undefined ? undefined : toTerms(row);
  },
};

const requestColumns = [
  'mandate_id',
  'mandate_instance_id',
  'op',
  'signing_request',
  'instance_plan',
] as const;

function toRequest(row: {
  mandate_id: string;
  mandate_instance_id: string;
  op: string;
  signing_request: unknown;
  instance_plan: unknown;
}): MandateActionRequest {
  return {
    mandateId: row.mandate_id,
    mandateInstanceId: row.mandate_instance_id,
    op: row.op,
    signingRequest: row.signing_request,
    instancePlan: row.instance_plan,
  };
}

export const mandateActionRequests = {
  // The request this key holds for the instance: this one, or the one an earlier
  // run of the same HTTP request already recorded, which is what gets signed.
  record: async (db: Tx, input: NewMandateActionRequest): Promise<MandateActionRequest> => {
    const won = await db
      .insertInto('ujira.mandate_action_requests')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_id: input.mandateId,
        mandate_instance_id: input.mandateInstanceId,
        op: input.op,
        idempotency_key: input.idempotencyKey,
        signing_request: JSON.stringify(input.signingRequest),
        instance_plan: input.instancePlan === null ? null : JSON.stringify(input.instancePlan),
      })
      .onConflict((conflict) => conflict.constraint('mandate_action_requests_once').doNothing())
      .returning(requestColumns)
      .executeTakeFirst();
    if (won !== undefined) return toRequest(won);
    const held = await db
      .selectFrom('ujira.mandate_action_requests')
      .select(requestColumns)
      .where('idempotency_key', '=', input.idempotencyKey)
      .where('mandate_instance_id', '=', input.mandateInstanceId)
      .executeTakeFirstOrThrow();
    return toRequest(held);
  },

  find: async (
    db: Tx,
    idempotencyKey: string,
    mandateInstanceId: string,
  ): Promise<MandateActionRequest | undefined> => {
    const row = await db
      .selectFrom('ujira.mandate_action_requests')
      .select(requestColumns)
      .where('idempotency_key', '=', idempotencyKey)
      .where('mandate_instance_id', '=', mandateInstanceId)
      .executeTakeFirst();
    return row === undefined ? undefined : toRequest(row);
  },

  // Each instance's create request, which also holds its plan.
  createsOf: async (db: Tx, mandateId: string): Promise<MandateActionRequest[]> => {
    const rows = await db
      .selectFrom('ujira.mandate_action_requests')
      .select(requestColumns)
      .where('mandate_id', '=', mandateId)
      .where('op', '=', 'create')
      .orderBy('created_at')
      .orderBy('mandate_instance_id')
      .execute();
    return rows.map(toRequest);
  },
};

// For the cross-tenant matrix, which requires a case for each method listed here.
export const mandateTermsRepositories = { mandateTerms, mandateActionRequests } as const;
