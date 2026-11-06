// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

import {
  ChainAddress,
  CountryCode,
  DisplayName,
  NetworkId,
  Sha256Hex,
  Timestamp,
  Uuid,
  tenantFields,
} from './common.js';
import { pageQueryFields, listParam } from './envelope.js';
import { MandateInstanceStatus, MandateRole, MandateStatus, RecipientMode } from './enums.js';
import { LowBalance } from './low-balance.js';
import { MinorUnits, Money, TokenAmount, TokenAssetCode, tokenSumEquals } from './money.js';

/**
 * Which countries a mandate pays into. The contract only ever sees the hash
 * of this list; the list itself stays off chain.
 */
export const CountryPolicy = z
  .strictObject({
    mode: z.enum(['allow', 'block']),
    countries: z.array(CountryCode).max(250),
  })
  .superRefine((value, ctx) => {
    const sorted = [...new Set(value.countries)].sort();
    if (sorted.join() !== value.countries.join()) {
      ctx.addIssue({
        code: 'custom',
        path: ['countries'],
        message: 'countries must be sorted and unique',
      });
    }
    if (value.mode === 'allow' && value.countries.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['countries'],
        message: 'an allow list cannot be empty',
      });
    }
  });
export type CountryPolicy = z.infer<typeof CountryPolicy>;

/** The four limits, in logical US dollars, shared by every instance. */
export const MandateLimits = z
  .strictObject({
    totalBudget: Money,
    perPaymentCap: Money,
    perRecipientDailyCap: Money,
    approvalThreshold: Money,
  })
  .superRefine((value, ctx) => {
    for (const [key, amount] of Object.entries(value)) {
      if (amount.currency !== 'USD') {
        ctx.addIssue({ code: 'custom', path: [key, 'currency'], message: 'limits are in USD' });
      }
    }
  });

/**
 * One instance's budget in its token. used is spent and never goes down;
 * pending is reserved by payouts waiting for approval and committed by
 * approved ones not yet executed; remaining is what a new payout may still
 * use. The four always add up to the total, which is what keeps a payout
 * from being requested beyond the budget.
 */
export const InstanceBudget = z
  .strictObject({
    total: TokenAmount,
    used: TokenAmount,
    pending: TokenAmount,
    committed: TokenAmount,
    remaining: TokenAmount,
  })
  .superRefine((value, ctx) => {
    if (
      !tokenSumEquals([value.used, value.pending, value.committed, value.remaining], value.total)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['total'],
        message: 'used, pending, committed and remaining must add up to total',
      });
    }
  });

const instanceSummaryFields = {
  id: Uuid,
  network: NetworkId,
  asset: TokenAssetCode,
  status: MandateInstanceStatus,
  budget: InstanceBudget,
} as const;

export const MandateInstanceSummary = z.strictObject(instanceSummaryFields);

/**
 * Whether UJIRA's pause-only operations guardian holds that role on an instance.
 * `outdated` is an address the guardian had before a rotation: UJIRA cannot change
 * a mandate's roles, so the principal adds the current one and removes the old.
 */
export const OperationsGuardianStatus = z.enum(['present', 'outdated', 'absent']);

/** Shown at any budget, so a single key principal knows the risk before the rule applies. */
export const PrincipalKeyWarning = z.enum(['single_key_principal', 'unverified_principal']);

/** What the principal should do next: a revoked mandate's balance stays frozen until it does. */
export const MandateNextAction = z.strictObject({
  action: z.literal('withdraw'),
  amount: TokenAmount,
});

export const MandateRoleMember = z.strictObject({
  role: MandateRole,
  address: ChainAddress,
  memberId: Uuid.nullable(),
});

export const MandateInstance = z
  .strictObject({
    ...instanceSummaryFields,
    specVersion: z.number().int().min(1),
    /** The contract address, which is also where deposits go. Null until deployed. */
    fundingAddress: ChainAddress.nullable(),
    roles: z.array(MandateRoleMember).max(100),
    approvalsRequired: z.number().int().min(0).max(10),
    maxFeeBps: z.number().int().min(0).max(100),
    payoutTtlSeconds: z.number().int().min(3600).max(2_592_000),
    policyEpoch: z.number().int().min(0),
    expiresAt: Timestamp,
    operationsGuardian: OperationsGuardianStatus,
    /** A principal change waiting to be accepted, or null. */
    proposedPrincipal: ChainAddress.nullable(),
    /** Set once expired: until then only the principal may sweep. */
    sweepGraceEndsAt: Timestamp.nullable(),
    nextAction: MandateNextAction.nullable(),
  })
  .superRefine((value, ctx) => {
    const deployed = !['deploying', 'deploy_failed'].includes(value.status);
    if (deployed && value.fundingAddress === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['fundingAddress'],
        message: 'a deployed instance has an address',
      });
    }
  });

const mandateFields = {
  ...tenantFields,
  id: Uuid,
  name: DisplayName,
  status: MandateStatus,
  recipientMode: RecipientMode,
  limits: MandateLimits,
  expiresAt: Timestamp,
  createdAt: Timestamp,
} as const;

export const MandateListItem = z.strictObject({
  ...mandateFields,
  instances: z.array(MandateInstanceSummary).max(16),
});
export type MandateListItem = z.infer<typeof MandateListItem>;

export const MandateDetail = z.strictObject({
  ...mandateFields,
  countryPolicy: CountryPolicy,
  countryPolicyHash: Sha256Hex,
  countryPolicyHashMatches: z.boolean(),
  lowBalance: LowBalance,
  instances: z.array(MandateInstance).max(16),
  updatedAt: Timestamp,
  warnings: z.array(PrincipalKeyWarning).max(2),
});
export type MandateDetail = z.infer<typeof MandateDetail>;

export const MandateListQuery = z.strictObject({
  ...pageQueryFields,
  status: listParam(MandateStatus).optional(),
});

export const MandateParams = z.strictObject({ id: Uuid });

const SigningSummary = z.strictObject({
  action: z.string().min(1).max(64),
  /** The mandate the request acts on, or the address a create will deploy at. */
  mandateAddress: ChainAddress.optional(),
  amount: TokenAmount.optional(),
  feePaidBy: z.enum(['ujira', 'signer']),
  estimatedFee: z
    .strictObject({
      amount: MinorUnits,
      asset: z.string().min(1).max(12),
      scale: z.number().int().min(0).max(18),
    })
    .optional(),
});

const signingRequestFields = {
  network: NetworkId,
  signer: ChainAddress,
  summary: SigningSummary,
  /** Named when the signed payload is submitted, so it can be checked against this one. */
  requestId: z.string().min(1).max(128),
} as const;

/** What a principal's own wallet must sign. */
export const SigningRequestWire = z.discriminatedUnion('kind', [
  z.strictObject({
    ...signingRequestFields,
    kind: z.literal('stellar_transaction'),
    xdr: z.string().min(1),
    validUntil: Timestamp,
    sponsored: z.boolean(),
  }),
  z.strictObject({
    ...signingRequestFields,
    kind: z.literal('stellar_auth_entry'),
    entryXdr: z.string().min(1),
    expirationLedger: z.number().int().min(0),
  }),
]);
export type SigningRequestWire = z.infer<typeof SigningRequestWire>;

const MandateChainRequest = z.strictObject({
  network: NetworkId,
  asset: TokenAssetCode,
  principal: ChainAddress,
  agents: z.array(ChainAddress).min(1).max(16),
  approvers: z.array(ChainAddress).max(16),
  approvalsRequired: z.number().int().min(0).max(10),
  /** The principal's own choices. The operations guardian is the guardian field's. */
  guardians: z.array(ChainAddress).max(16),
  recovery: z.array(ChainAddress).max(16),
  recoveryThreshold: z.number().int().min(0).max(16),
});

export const CreateMandateRequest = z
  .strictObject({
    name: DisplayName,
    recipientMode: RecipientMode,
    limits: MandateLimits,
    payoutTtlSeconds: z.number().int().min(3600).max(2_592_000),
    expiresAt: Timestamp,
    /** The most UJIRA may ever charge, at most 100 basis points. Shown with the agreed rate. */
    maxFeeBps: z.number().int().min(0).max(65_535),
    countryPolicy: CountryPolicy,
    chains: z.array(MandateChainRequest).min(1).max(16),
    /** Left out, the operations guardian is included. false leaves it out. */
    guardian: z.boolean().optional(),
    /** True when UJIRA holds the agent key, which rules out attested only mode. */
    managedAgent: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const networks = value.chains.map((chain) => chain.network);
    if (new Set(networks).size !== networks.length) {
      ctx.addIssue({ code: 'custom', path: ['chains'], message: 'each network at most once' });
    }
  });

export const MandateCreated = z.strictObject({
  ...tenantFields,
  id: Uuid,
  name: DisplayName,
  status: MandateStatus,
  recipientMode: RecipientMode,
  limits: MandateLimits,
  maxFeeBps: z.number().int().min(0).max(100),
  /** The rate agreed for this project, shown beside the cap before anything is signed. */
  agreedFeeBps: z.number().int().min(0).max(100),
  instances: z
    .array(
      z.strictObject({
        id: Uuid,
        network: NetworkId,
        asset: TokenAssetCode,
        /** Where the contract will deploy. Not a funding address until it has. */
        address: ChainAddress,
        operationsGuardian: OperationsGuardianStatus,
        warnings: z.array(PrincipalKeyWarning).max(2),
        signingRequest: SigningRequestWire,
      }),
    )
    .min(1)
    .max(16),
});
export type MandateCreated = z.infer<typeof MandateCreated>;

export const LowerFeeCapRequest = z.strictObject({
  maxFeeBps: z.number().int().min(0).max(65_535),
});

export const MandateActionPrepared = z.strictObject({
  ...tenantFields,
  mandateId: Uuid,
  op: z.enum(['lower_fee_cap', 'revoke', 'withdraw', 'cancel_principal_proposal']),
  instances: z
    .array(
      z.strictObject({
        instanceId: Uuid,
        network: NetworkId,
        signingRequest: SigningRequestWire,
        nextAction: MandateNextAction.nullable(),
      }),
    )
    .min(1)
    .max(16),
});
export type MandateActionPrepared = z.infer<typeof MandateActionPrepared>;

export const MandateFunding = z.strictObject({
  ...tenantFields,
  mandateId: Uuid,
  instances: z
    .array(
      z.strictObject({
        instanceId: Uuid,
        network: NetworkId,
        /** Null until the mandate is deployed, so nobody funds an address with no contract. */
        instructions: z
          .strictObject({
            address: ChainAddress,
            asset: TokenAssetCode,
            assetContract: ChainAddress,
            label: z.string().min(1).max(100),
            memoRequired: z.literal(false),
            warnings: z
              .array(
                z.enum([
                  'other_assets_not_credited',
                  'wrong_network_lost',
                  'exchange_contract_address_support',
                ]),
              )
              .max(3),
            availableAt: z.enum(['none', 'included', 'safe', 'final']),
          })
          .nullable(),
      }),
    )
    .max(16),
});
export type MandateFunding = z.infer<typeof MandateFunding>;
