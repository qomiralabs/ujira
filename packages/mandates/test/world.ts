// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The fake chain and the configuration the mandate rules are tested
// against: the in-memory ledger, a USDC token and the mandate factory, with
// helpers that turn the adapter's request types into the engine's own.

import { parseNetworksConfig } from '@ujira/chain-adapter';
import type {
  Bytes32,
  ChainAddress,
  MandateConfigInput,
  NetworkId,
  NetworksConfig,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import {
  FakeLedger,
  FakeToken,
  MandateFactory,
  accountFromSeed,
  contractAddress,
  hexOf,
  sha256,
} from '@ujira/chain-adapter/testing';
import type { EngineConfig, MandateEngine } from '@ujira/chain-adapter/testing';
import { tokenAmount } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';

import type { LogicalMandateKey, OnChainGuardians } from '../src/index.js';

export const NETWORK: NetworkId = 'stellar:testnet';
export const NOW = 1_767_225_600n;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
export const account = (name: string): string => accountFromSeed(sha256(bytes(`mandates:${name}`)));
const contract = (name: string): string => contractAddress(sha256(bytes(`contract:${name}`)));
export const ref = (name: string): Bytes32 => hexOf(sha256(bytes(name))) as Bytes32;
export const at = (value: string): ChainAddress => ({ network: NETWORK, value });

export const PRINCIPAL = account('principal');
export const AGENT = account('agent');
export const OPS_GUARDIAN = account('ops-guardian');
export const NEXT_OPS_GUARDIAN = account('ops-guardian-next');
export const OWN_GUARDIAN = account('principal-guardian');

/** Whole US dollars as USDC on the network, at the token's seven decimals. */
export function usdc(dollars: bigint): TokenAmount {
  return tokenAmount((dollars * 10_000_000n).toString(), 'USDC', 'stellar');
}

const keyRef = (name: string): Record<string, unknown> => ({
  provider: 'aws_kms',
  keyId: `alias/${name}`,
  address: account(name),
});

/** A valid networks section with the given operations guardian, or none. */
export function networks(guardian: string | null = OPS_GUARDIAN): NetworksConfig {
  return parseNetworksConfig({
    [NETWORK]: {
      enabled: true,
      rpc: [{ url: 'secretRef:testnet_rpc', weight: 1 }],
      maxEndpointLagSeconds: 15,
      trustedFactories: { '1': [contract('factory')] },
      assets: { USDC: { sac: contract('usdc'), issuer: account('issuer') } },
      deposits: { startLedger: 0, availableAt: 'included', pageEvents: 500 },
      executor: { txValiditySeconds: 60, keys: [keyRef('executor')] },
      feeSponsor: {
        perPrincipalFundingAccounts: 1,
        reserveSponsorshipDailyStroops: '500000000',
        maxFeePerTxStroops: '1000000',
        perPrincipalPerMinute: 10,
        perPrincipalDailyCount: 200,
        perPrincipalDailyFeeStroops: '50000000',
        globalDailyFeeStroops: '5000000000',
        lowBalanceStroops: '1000000000',
        minBalanceStroops: '100000000',
        key: keyRef('sponsor'),
      },
      sep10: [],
      signingWindowSeconds: 300,
      explorer: { tx: 'https://stellar.expert/explorer/testnet/tx/{hash}' },
      health: {
        maxHeadLagSeconds: 30,
        degradedErrorBps: 500,
        downErrorBps: 5000,
        hysteresisChecks: 3,
      },
      ...(guardian === null ? {} : { operationsGuardian: guardian }),
    },
  });
}

/** What a principal asks for, before UJIRA's rules: one agent, no guardians. */
export function principalConfig(overrides: Partial<MandateConfigInput> = {}): MandateConfigInput {
  return {
    principal: at(PRINCIPAL),
    asset: 'USDC',
    recipientMode: 'allowlist',
    tenantRef: ref('tenant'),
    agents: [at(AGENT)],
    approvers: [],
    approvalsRequired: 0,
    guardians: [],
    executors: [],
    recovery: [],
    recoveryThreshold: 0,
    limits: {
      totalBudget: usdc(10_000n),
      perPaymentCap: usdc(1_000n),
      perRecipientDailyCap: usdc(1_000n),
      approvalThreshold: usdc(1_001n),
      payoutTtlSeconds: 86_400,
      expiresAt: (NOW + 86_400n * 30n) as UnixSeconds,
    },
    attester: null,
    countryPolicyHash: ref('countries'),
    maxFeeBps: 0,
    ...overrides,
  };
}

export function key(principal = 'principal-1', mandate = 'mandate-1'): LogicalMandateKey {
  return {
    principalId: principal as Uuid,
    projectId: 'project-1' as Uuid,
    mandateId: mandate as Uuid,
  };
}

export interface World {
  readonly ledger: FakeLedger;
  readonly token: FakeToken;
  readonly factory: MandateFactory;
}

export function world(): World {
  const ledger = new FakeLedger({ now: NOW });
  const token = new FakeToken(ledger, { address: contract('usdc') });
  const factory = new MandateFactory(ledger, {
    address: contract('factory'),
    feeAddress: account('fee'),
    assets: [token.address],
  });
  return { ledger, token, factory };
}

const MODES = { allowlist: 'ALLOWLIST', attested: 'ATTESTED', both: 'BOTH' } as const;

/** The adapter's create input in the engine's own terms. */
export function toEngineConfig(config: MandateConfigInput, asset: string): EngineConfig {
  const values = (list: readonly ChainAddress[]): string[] => list.map((a) => a.value);
  return {
    principal: config.principal.value,
    asset,
    recipientMode: MODES[config.recipientMode],
    tenantRef: config.tenantRef,
    agents: values(config.agents),
    approvers: values(config.approvers),
    approvalsRequired: config.approvalsRequired,
    guardians: values(config.guardians),
    executors: values(config.executors),
    recovery: values(config.recovery),
    recoveryThreshold: config.recoveryThreshold,
    limits: {
      totalBudget: config.limits.totalBudget.amount,
      perPaymentCap: config.limits.perPaymentCap.amount,
      perRecipientDailyCap: config.limits.perRecipientDailyCap.amount,
      approvalThreshold: config.limits.approvalThreshold.amount,
      payoutTtlSeconds: BigInt(config.limits.payoutTtlSeconds),
      expiresAt: config.limits.expiresAt,
    },
    attester: config.attester,
    countryPolicyHash: config.countryPolicyHash,
    maxFeeBps: config.maxFeeBps,
  };
}

export function createOnChain(w: World, config: MandateConfigInput, salt = 'salt'): MandateEngine {
  return w.factory.create(
    { caller: config.principal.value },
    toEngineConfig(config, w.token.address),
    ref(salt),
  );
}

export function onChainGuardians(mandate: MandateEngine): OnChainGuardians {
  return { network: NETWORK, guardians: mandate.config().guardians.map(at) };
}
