// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the mandate endpoints do, over the chain adapter, the mandate rules and the
// stored records. Every write prepares something for the principal's own wallet
// to sign, so nothing here moves money directly, but a signed request can, so each
// one is written under the request's Idempotency-Key with a unique constraint.
// That is what makes a second run after a process died hand back the same requests
// rather than making new ones: the salt is derived from the key as well, so a
// retried create can only ever target the same contract address.
//
// A mandate created here is not a mandate to the rest of the system until its
// factory's mandate_created event has been read. Until then its instance reads as
// deploying, and nothing about it is taken from the chain.

import { createHash, randomUUID } from 'node:crypto';

import {
  DEFAULT_LOW_BALANCE,
  OperationsGuardianStatus as WireGuardianStatus,
  fromWireMoney,
  toWireMoney,
  toWireToken,
} from '@ujira/api-schema';
import type {
  CreateMandateRequest,
  MandateDetail,
  MandateFunding,
  MandateNextAction,
  MandateStatus,
  NetworkId as WireNetworkId,
  SigningRequestWire,
} from '@ujira/api-schema';
import {
  InvalidInputError,
  MandateRuleError,
  MandateUntrustedError,
  chainOf,
  operationsGuardianOf,
} from '@ujira/chain-adapter';
import type {
  Bytes32,
  ChainAdapter,
  ChainAddress,
  CountryCode,
  MandateAction,
  MandateConfigInput,
  MandateConfigView,
  MandateRef,
  MandateSnapshot,
  NetworkId,
  RoleName,
  SigningRequest,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { tokenAmount, usdToToken } from '@ujira/core';
import type { Money, TokenAmount, TokenAsset } from '@ujira/core';
import { countryPolicyHash } from '@ujira/identity';
import { planMandateCreation, principalKeyWarning } from '@ujira/mandates';
import type {
  CreationDeps,
  MandateCreationPlan,
  OperationsGuardianStatus,
  PrincipalKeyWarning,
} from '@ujira/mandates';
import { z } from 'zod';

import type { Tenant } from './auth.js';
import { ApiError } from './errors.js';
import type { MandateEndpoints } from './routes/mandates.js';
import type { TenantRequestContext } from './route.js';

export const MAX_FEE_CAP_BPS = 100;

/** How long after expiry only the principal may sweep, in the mandate spec's constants. */
export const SWEEP_GRACE_SECONDS = 2_592_000;

export type MandateActionOp = 'lower_fee_cap' | 'revoke' | 'withdraw' | 'cancel_principal_proposal';

/** What a create asked for on one chain, read back while the instance is deploying. */
export const InstancePlan = z.strictObject({
  network: z.enum(['stellar:pubnet', 'stellar:testnet']),
  asset: z.string(),
  roles: z.array(
    z.strictObject({
      role: z.enum(['agent', 'approver', 'guardian', 'executor', 'recovery']),
      address: z.string(),
    }),
  ),
  principal: z.string(),
  approvalsRequired: z.number().int(),
  operationsGuardian: WireGuardianStatus,
  warnings: z.array(z.enum(['single_key_principal', 'unverified_principal'])),
});
export type InstancePlan = z.infer<typeof InstancePlan>;

export interface StoredInstance {
  readonly id: string;
  readonly address: string;
  readonly plan: InstancePlan;
  readonly signingRequest: SigningRequestWire;
}

export interface StoredMandate {
  readonly id: string;
  readonly name: string;
  readonly recipientMode: MandateConfigInput['recipientMode'];
  readonly limits: {
    readonly totalBudget: Money;
    readonly perPaymentCap: Money;
    readonly perRecipientDailyCap: Money;
    readonly approvalThreshold: Money;
  };
  readonly countryPolicy: z.output<typeof CreateMandateRequest>['countryPolicy'];
  /** 32 bytes. */
  readonly countryPolicyHash: Buffer;
  readonly maxFeeBps: number;
  readonly agreedFeeBps: number;
  readonly payoutTtlSeconds: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly instances: readonly StoredInstance[];
}

export type NewStoredInstance = Omit<StoredInstance, 'id'>;

export interface NewStoredMandate extends Omit<StoredMandate, 'createdAt' | 'instances'> {
  readonly creationKey: string;
  readonly instances: readonly NewStoredInstance[];
}

/** The mandate rows. Every method takes the tenant, and sees nothing outside it. */
export interface MandateRecords {
  readonly find: (tenant: Tenant, id: string) => Promise<StoredMandate | undefined>;
  readonly findByCreationKey: (tenant: Tenant, key: string) => Promise<StoredMandate | undefined>;
  /** The mandate this key created: this one, or the one an earlier run already wrote. */
  readonly createOnce: (tenant: Tenant, mandate: NewStoredMandate) => Promise<StoredMandate>;
  readonly findAction: (
    tenant: Tenant,
    key: string,
    instanceId: string,
  ) => Promise<SigningRequestWire | undefined>;
  /** The request this key holds for the instance: this one, or an earlier run's. */
  readonly recordAction: (
    tenant: Tenant,
    action: {
      readonly mandateId: string;
      readonly instanceId: string;
      readonly op: MandateActionOp;
      readonly key: string;
      readonly signingRequest: SigningRequestWire;
    },
  ) => Promise<SigningRequestWire>;
}

/** What UJIRA itself supplies to every mandate on a network. */
export interface ChainDefaults {
  readonly factory: ChainAddress;
  readonly executors: readonly ChainAddress[];
  /** Its 32 byte public key, needed unless the mandate is allowlist only. */
  readonly attester: Uint8Array;
}

export type TransferFix = 'principal_trustline_missing' | 'principal_unreceivable';

export interface MandateServiceDeps {
  readonly adapterFor: (network: NetworkId) => ChainAdapter;
  readonly records: MandateRecords;
  readonly creation: CreationDeps;
  readonly chainDefaults: (network: NetworkId) => ChainDefaults;
  /** The rate agreed for the project, which the fee cap must leave room for. */
  readonly agreedFeeBps: (tenant: Tenant) => Promise<number>;
  /** Why the principal cannot receive, once a transfer to it has been refused. */
  readonly diagnoseTransfer: (principal: ChainAddress) => Promise<TransferFix>;
}

function scopeOf(tenant: Tenant): TenantScope {
  return { principalId: tenant.principalId as Uuid, projectId: tenant.projectId as Uuid };
}

function chainAddress(network: NetworkId, value: string): ChainAddress {
  return { network, value };
}

function refOf(instance: StoredInstance): MandateRef {
  const { network } = instance.plan;
  return { network, address: chainAddress(network, instance.address), specVersion: 1 };
}

function seconds(time: Date | string): UnixSeconds {
  const at = time instanceof Date ? time.getTime() : Date.parse(time);
  return BigInt(Math.floor(at / 1_000)) as UnixSeconds;
}

function isoOf(time: bigint): string {
  return new Date(Number(time) * 1_000).toISOString();
}

// Derived from the key, so a retried create targets the same contract. The tenant
// is in the hash, so one tenant's key can never name another's address.
function saltOf(tenant: Tenant, key: string, network: NetworkId): Bytes32 {
  const digest = createHash('sha256')
    .update(JSON.stringify([tenant.principalId, tenant.projectId, key, network]))
    .digest('hex');
  return `0x${digest}` as Bytes32;
}

function feeCapChecked(maxFeeBps: number): void {
  if (maxFeeBps > MAX_FEE_CAP_BPS) {
    throw new ApiError('FEE_CAP_INVALID', {
      errors: [{ field: 'maxFeeBps', code: 'invalid_value' }],
    });
  }
}

function policyHashOf(body: z.output<typeof CreateMandateRequest>): Bytes32 {
  return countryPolicyHash(
    body.countryPolicy.countries as readonly string[] as readonly CountryCode[],
  );
}

function keyOf(context: TenantRequestContext): string {
  // The pipeline requires one on every tenant write, so this is a bug if it fires.
  if (context.idempotencyKey === null) throw new ApiError('INTERNAL');
  return context.idempotencyKey;
}

export function signingRequestWire(request: SigningRequest): SigningRequestWire {
  const { summary } = request;
  const wireSummary = {
    action: summary.action,
    ...(summary.mandate === undefined ? {} : { mandateAddress: summary.mandate.address.value }),
    ...(summary.amount === undefined
      ? {}
      : { amount: toWireToken(summary.amount, request.network) }),
    feePaidBy: summary.feePaidBy,
    ...(summary.estimatedFee === undefined
      ? {}
      : {
          estimatedFee: {
            amount: summary.estimatedFee.amount.toString(),
            asset: summary.estimatedFee.asset,
            scale: summary.estimatedFee.scale,
          },
        }),
  };
  const common = {
    network: request.network,
    signer: request.signer.value,
    summary: wireSummary,
    requestId: request.requestId,
  };
  return request.kind === 'stellar_transaction'
    ? {
        ...common,
        kind: request.kind,
        xdr: request.xdr,
        validUntil: isoOf(request.validUntil),
        sponsored: request.sponsored,
      }
    : {
        ...common,
        kind: request.kind,
        entryXdr: request.entryXdr,
        expirationLedger: request.expirationLedger,
      };
}

function rolesOf(config: MandateConfigInput): { role: RoleName; address: string }[] {
  const of = (role: RoleName, members: readonly ChainAddress[]) =>
    members.map((member) => ({ role, address: member.value }));
  return [
    ...of('agent', config.agents),
    ...of('approver', config.approvers),
    ...of('guardian', config.guardians),
    ...of('executor', config.executors),
    ...of('recovery', config.recovery),
  ];
}

// A contract is not a mandate until its factory's event has been read. A reader
// that finds nothing at the address yet says the same thing another way.
function notDeployedYet(error: unknown): boolean {
  if (error instanceof MandateUntrustedError) return true;
  return (
    error instanceof InvalidInputError &&
    error.issues.some((issue) => issue.includes('address (not_found)'))
  );
}

function statusOf(state: MandateSnapshot['state']): 'active' | 'paused' | 'revoked' | 'expired' {
  if (state.revoked) return 'revoked';
  if (state.expired) return 'expired';
  return state.paused ? 'paused' : 'active';
}

function overallStatus(statuses: readonly string[]): MandateStatus {
  for (const status of ['active', 'paused', 'revoked', 'expired'] as const) {
    if (statuses.includes(status)) return status;
  }
  return 'draft';
}

function nextActionOf(
  network: NetworkId,
  snapshot: MandateSnapshot,
): z.input<typeof MandateNextAction> | null {
  const { balance, revoked } = snapshot.state;
  if (!revoked || balance.amount === 0n) return null;
  return { action: 'withdraw', amount: toWireToken(balance, network) };
}

export function createMandateEndpoints(deps: MandateServiceDeps): MandateEndpoints {
  const { records } = deps;

  const found = async (id: string, tenant: Tenant): Promise<StoredMandate> => {
    const stored = await records.find(tenant, id);
    // Another tenant's id reads exactly like one that never existed.
    if (stored === undefined) throw new ApiError('NOT_FOUND');
    return stored;
  };

  const read = async (
    instance: StoredInstance,
    context: TenantRequestContext,
  ): Promise<MandateSnapshot | null> => {
    const adapter = deps.adapterFor(instance.plan.network);
    try {
      const snapshot = await adapter.readMandate(
        { scope: scopeOf(context.tenant), mandate: refOf(instance) },
        context.call,
      );
      return snapshot.trustedFactory ? snapshot : null;
    } catch (error) {
      if (notDeployedYet(error)) return null;
      throw error;
    }
  };

  const configFor = (
    chain: z.output<typeof CreateMandateRequest>['chains'][number],
    body: z.output<typeof CreateMandateRequest>,
  ): MandateConfigInput => {
    const { network } = chain;
    const defaults = deps.chainDefaults(network);
    const asset = chain.asset;
    const token = (usd: z.output<typeof CreateMandateRequest>['limits']['totalBudget']) =>
      usdToToken(fromWireMoney(usd), asset, chainOf(network));
    const addresses = (values: readonly string[]) => values.map((v) => chainAddress(network, v));
    return {
      principal: chainAddress(network, chain.principal),
      asset,
      recipientMode: body.recipientMode,
      agents: addresses(chain.agents),
      approvers: addresses(chain.approvers),
      approvalsRequired: chain.approvalsRequired,
      guardians: addresses(chain.guardians),
      executors: defaults.executors,
      recovery: addresses(chain.recovery),
      recoveryThreshold: chain.recoveryThreshold,
      limits: {
        totalBudget: token(body.limits.totalBudget),
        perPaymentCap: token(body.limits.perPaymentCap),
        perRecipientDailyCap: token(body.limits.perRecipientDailyCap),
        approvalThreshold: token(body.limits.approvalThreshold),
        payoutTtlSeconds: body.payoutTtlSeconds,
        expiresAt: seconds(body.expiresAt),
      },
      attester: body.recipientMode === 'allowlist' ? null : defaults.attester,
      countryPolicyHash: policyHashOf(body),
      maxFeeBps: body.maxFeeBps,
    };
  };

  const createdWire = (stored: StoredMandate, tenant: Tenant) => ({
    principalId: tenant.principalId,
    projectId: tenant.projectId,
    id: stored.id,
    name: stored.name,
    status: 'draft' as const,
    recipientMode: stored.recipientMode,
    limits: {
      totalBudget: toWireMoney(stored.limits.totalBudget),
      perPaymentCap: toWireMoney(stored.limits.perPaymentCap),
      perRecipientDailyCap: toWireMoney(stored.limits.perRecipientDailyCap),
      approvalThreshold: toWireMoney(stored.limits.approvalThreshold),
    },
    maxFeeBps: stored.maxFeeBps,
    agreedFeeBps: stored.agreedFeeBps,
    instances: stored.instances.map((instance) => ({
      id: instance.id,
      network: instance.plan.network,
      asset: instance.plan.asset as 'USDC',
      address: instance.address,
      operationsGuardian: instance.plan.operationsGuardian,
      warnings: instance.plan.warnings,
      signingRequest: instance.signingRequest,
    })),
  });

  const create: MandateEndpoints['create'] = async (body, context) => {
    feeCapChecked(body.maxFeeBps);
    const { tenant } = context;
    const key = keyOf(context);
    const earlier = await records.findByCreationKey(tenant, key);
    if (earlier !== undefined) return createdWire(earlier, tenant);

    const mandateId = randomUUID();
    const scope = scopeOf(tenant);
    const instances: NewStoredInstance[] = [];
    for (const chain of body.chains) {
      const { network } = chain;
      const plan: MandateCreationPlan = await planMandateCreation(
        {
          key: { ...scope, mandateId: mandateId as Uuid },
          network,
          config: configFor(chain, body),
          ...(body.guardian === undefined ? {} : { guardian: body.guardian }),
          ...(body.managedAgent === undefined ? {} : { managedAgent: body.managedAgent }),
        },
        deps.creation,
      );
      const action: MandateAction = {
        op: 'create',
        factory: deps.chainDefaults(network).factory,
        config: plan.config,
        salt: saltOf(tenant, key, network),
      };
      const request = await deps.adapterFor(network).prepareMandateAction(
        {
          scope,
          mandate: null,
          action,
          signer: {
            kind: 'external',
            network,
            role: 'principal',
            address: plan.config.principal,
          },
        },
        context.call,
      );
      const address = request.summary.mandate?.address.value;
      // The instance row has to exist before the event can be matched to a tenant.
      if (address === undefined) throw new ApiError('INTERNAL');
      instances.push({
        address,
        plan: {
          network,
          asset: chain.asset,
          roles: rolesOf(plan.config),
          principal: chain.principal,
          approvalsRequired: chain.approvalsRequired,
          operationsGuardian: plan.operationsGuardian,
          warnings: [...plan.warnings],
        },
        signingRequest: signingRequestWire(request),
      });
    }
    const stored = await records.createOnce(tenant, {
      id: mandateId,
      creationKey: key,
      name: body.name,
      recipientMode: body.recipientMode,
      limits: {
        totalBudget: fromWireMoney(body.limits.totalBudget),
        perPaymentCap: fromWireMoney(body.limits.perPaymentCap),
        perRecipientDailyCap: fromWireMoney(body.limits.perRecipientDailyCap),
        approvalThreshold: fromWireMoney(body.limits.approvalThreshold),
      },
      countryPolicy: body.countryPolicy,
      countryPolicyHash: Buffer.from(policyHashOf(body).slice(2), 'hex'),
      maxFeeBps: body.maxFeeBps,
      agreedFeeBps: await deps.agreedFeeBps(tenant),
      payoutTtlSeconds: body.payoutTtlSeconds,
      expiresAt: new Date(body.expiresAt),
      instances,
    });
    return createdWire(stored, tenant);
  };

  const guardianOn = (config: MandateConfigView, network: NetworkId): OperationsGuardianStatus => {
    const guardian = operationsGuardianOf(deps.creation.networks(), network);
    return guardian !== null && config.guardians.some((g) => g.value === guardian.value)
      ? 'present'
      : 'absent';
  };

  const get: MandateEndpoints['get'] = async (id, context) => {
    const { tenant } = context;
    const stored = await found(id, tenant);
    const expiresAt = stored.expiresAt.toISOString();
    const warnings = new Set<PrincipalKeyWarning>();
    let hashMatches = true;
    const instances = await Promise.all(
      stored.instances.map(async (instance): Promise<MandateDetail['instances'][number]> => {
        const { network } = instance.plan;
        const wireNetwork = network;
        const snapshot = await read(instance, context);
        const asset = instance.plan.asset as TokenAsset;
        if (snapshot === null) {
          for (const warning of instance.plan.warnings) warnings.add(warning);
          const zero = toWireToken(tokenAmount(0n, asset, chainOf(network)), wireNetwork);
          const total = toWireToken(
            usdToToken(stored.limits.totalBudget, asset, chainOf(network)),
            wireNetwork,
          );
          return {
            id: instance.id,
            network: wireNetwork,
            asset: asset,
            status: 'deploying',
            budget: { total, used: zero, pending: zero, committed: zero, remaining: total },
            specVersion: 1,
            fundingAddress: null,
            roles: instance.plan.roles.map((role) => ({ ...role, memberId: null })),
            approvalsRequired: instance.plan.approvalsRequired,
            maxFeeBps: stored.maxFeeBps,
            payoutTtlSeconds: stored.payoutTtlSeconds,
            policyEpoch: 0,
            expiresAt,
            operationsGuardian: instance.plan.operationsGuardian,
            proposedPrincipal: null,
            sweepGraceEndsAt: null,
            nextAction: null,
          };
        }
        const { config, state } = snapshot;
        const warning = await principalKeyWarning(
          tenant.principalId as Uuid,
          config.principal,
          deps.creation.principalKeys,
        );
        if (warning !== null) warnings.add(warning);
        if (config.countryPolicyHash.slice(2) !== stored.countryPolicyHash.toString('hex')) {
          hashMatches = false;
        }
        const total = config.limits.totalBudget;
        const remaining = tokenAmount(
          total.amount - state.spent.amount - state.pending.amount - state.committed.amount,
          total.asset,
          total.chain,
        );
        const wire = (value: TokenAmount) => toWireToken(value, wireNetwork);
        return {
          id: instance.id,
          network: wireNetwork,
          asset: asset,
          status: statusOf(state),
          budget: {
            total: wire(total),
            used: wire(state.spent),
            pending: wire(state.pending),
            committed: wire(state.committed),
            remaining: wire(remaining),
          },
          specVersion: 1,
          fundingAddress: instance.address,
          roles: rolesOf(config).map((role) => ({ ...role, memberId: null })),
          approvalsRequired: config.approvalsRequired,
          maxFeeBps: config.maxFeeBps,
          payoutTtlSeconds: config.limits.payoutTtlSeconds,
          policyEpoch: state.policyEpoch,
          expiresAt: isoOf(config.limits.expiresAt),
          operationsGuardian: guardianOn(config, network),
          proposedPrincipal: config.proposedPrincipal?.value ?? null,
          sweepGraceEndsAt: state.expired
            ? isoOf(config.limits.expiresAt + BigInt(SWEEP_GRACE_SECONDS))
            : null,
          nextAction: nextActionOf(network, snapshot),
        };
      }),
    );
    return {
      principalId: tenant.principalId,
      projectId: tenant.projectId,
      id: stored.id,
      name: stored.name,
      status: overallStatus(instances.map((instance) => instance.status)),
      recipientMode: stored.recipientMode,
      limits: {
        totalBudget: toWireMoney(stored.limits.totalBudget),
        perPaymentCap: toWireMoney(stored.limits.perPaymentCap),
        perRecipientDailyCap: toWireMoney(stored.limits.perRecipientDailyCap),
        approvalThreshold: toWireMoney(stored.limits.approvalThreshold),
      },
      expiresAt,
      createdAt: stored.createdAt.toISOString(),
      updatedAt: stored.createdAt.toISOString(),
      countryPolicy: stored.countryPolicy,
      countryPolicyHash: stored.countryPolicyHash.toString('hex'),
      countryPolicyHashMatches: hashMatches,
      lowBalance: { ...DEFAULT_LOW_BALANCE },
      instances,
      warnings: [...warnings],
    };
  };

  const funding: MandateEndpoints['funding'] = async (id, context) => {
    const { tenant } = context;
    const stored = await found(id, tenant);
    const instances = await Promise.all(
      stored.instances.map(async (instance) => {
        const { network } = instance.plan;
        const base = { instanceId: instance.id, network: network };
        // Nothing to fund until the factory's event says this contract is a mandate.
        if ((await read(instance, context)) === null) return { ...base, instructions: null };
        const instructions = await deps
          .adapterFor(network)
          .fundingInstructions({ scope: scopeOf(tenant), mandate: refOf(instance) }, context.call);
        return {
          ...base,
          instructions: {
            address: instructions.address.value,
            asset: instructions.asset,
            assetContract: instructions.assetContract,
            label: instructions.label,
            memoRequired: instructions.memoRequired,
            warnings: [...instructions.warnings],
            availableAt: instructions.availableAt,
          },
        };
      }),
    );
    const response: z.input<typeof MandateFunding> = {
      principalId: tenant.principalId,
      projectId: tenant.projectId,
      mandateId: stored.id,
      instances,
    };
    return response;
  };

  // Prepares one action per deployed instance, or hands back what an earlier run
  // of this request prepared, so a retry never makes a second thing to sign.
  const prepare = async (
    id: string,
    op: MandateActionOp,
    context: TenantRequestContext,
    build: (snapshot: MandateSnapshot) => MandateAction | null,
  ) => {
    const { tenant } = context;
    const key = keyOf(context);
    const stored = await found(id, tenant);
    const prepared = [];
    let deployed = 0;
    for (const instance of stored.instances) {
      const snapshot = await read(instance, context);
      if (snapshot === null) continue;
      deployed += 1;
      const action = build(snapshot);
      if (action === null) continue;
      const { network } = instance.plan;
      const earlier = await records.findAction(tenant, key, instance.id);
      const signingRequest =
        earlier ??
        (await records.recordAction(tenant, {
          mandateId: stored.id,
          instanceId: instance.id,
          op,
          key,
          signingRequest: signingRequestWire(
            await deps.adapterFor(network).prepareMandateAction(
              {
                scope: scopeOf(tenant),
                mandate: refOf(instance),
                action,
                signer: {
                  kind: 'external',
                  network,
                  role: 'principal',
                  address: snapshot.config.principal,
                },
              },
              context.call,
            ),
          ),
        }));
      prepared.push({
        instanceId: instance.id,
        network: network,
        signingRequest,
        snapshot,
      });
    }
    if (deployed === 0) {
      throw new ApiError('MANDATE_REFUSED', { detail: 'The mandate is still being deployed' });
    }
    if (prepared.length === 0) {
      throw new ApiError('MANDATE_REFUSED', { detail: 'There is nothing to do on this mandate' });
    }
    return prepared;
  };

  const preparedWire = (
    id: string,
    op: MandateActionOp,
    tenant: Tenant,
    prepared: readonly {
      readonly instanceId: string;
      readonly network: WireNetworkId;
      readonly signingRequest: SigningRequestWire;
    }[],
    nextAction: (instanceId: string) => z.input<typeof MandateNextAction> | null = () => null,
  ) => ({
    principalId: tenant.principalId,
    projectId: tenant.projectId,
    mandateId: id,
    op,
    instances: prepared.map(({ instanceId, network, signingRequest }) => ({
      instanceId,
      network,
      signingRequest,
      nextAction: nextAction(instanceId),
    })),
  });

  const transferFailed = async (error: unknown, principal: ChainAddress | null): Promise<never> => {
    if (
      principal !== null &&
      error instanceof MandateRuleError &&
      error.specName === 'TRANSFER_FAILED'
    ) {
      const fix = await deps.diagnoseTransfer(principal);
      throw new ApiError('TRANSFER_FAILED', {
        detail:
          fix === 'principal_trustline_missing'
            ? "Add the asset's trustline to the principal's account, or move the mandate to a principal that can receive it, then prepare this again"
            : 'The principal cannot receive this asset. Move the mandate to a principal that can, then prepare this again',
        fixes: [fix],
      });
    }
    throw error;
  };

  return {
    create,
    get,
    funding,

    lowerFeeCap: async (id, body, context) => {
      feeCapChecked(body.maxFeeBps);
      const prepared = await prepare(id, 'lower_fee_cap', context, () => ({
        op: 'lower_fee_cap',
        maxFeeBps: body.maxFeeBps,
      }));
      return preparedWire(id, 'lower_fee_cap', context.tenant, prepared);
    },

    revoke: async (id, context) => {
      const prepared = await prepare(id, 'revoke', context, () => ({ op: 'revoke' }));
      // What will be frozen, as of now: the principal withdraws it after signing.
      const frozen = new Map(
        prepared.map(({ instanceId, network, snapshot }) => {
          const { balance } = snapshot.state;
          const amount = balance.amount === 0n ? null : toWireToken(balance, network);
          return [
            instanceId,
            amount === null ? null : ({ action: 'withdraw', amount } as const),
          ] as const;
        }),
      );
      return preparedWire(
        id,
        'revoke',
        context.tenant,
        prepared,
        (instanceId) => frozen.get(instanceId) ?? null,
      );
    },

    withdraw: async (id, context) => {
      let principal: ChainAddress | null = null;
      const prepared = await prepare(id, 'withdraw', context, (snapshot) => {
        const { balance } = snapshot.state;
        if (balance.amount === 0n) return null;
        principal = snapshot.config.principal;
        return { op: 'withdraw', amount: balance };
      }).catch((error: unknown) => transferFailed(error, principal));
      return preparedWire(id, 'withdraw', context.tenant, prepared);
    },

    cancelPrincipalProposal: async (id, context) => {
      const prepared = await prepare(id, 'cancel_principal_proposal', context, () => ({
        op: 'cancel_principal_proposal',
      }));
      return preparedWire(id, 'cancel_principal_proposal', context.tenant, prepared);
    },
  };
}
