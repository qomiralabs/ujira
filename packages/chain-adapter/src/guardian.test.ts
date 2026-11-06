// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the operations guardian setting (config.ts and guardian.ts).
 *
 * - operationsGuardian is an optional checked Stellar account in a network
 *   section. It may not be the address of any key UJIRA signs with.
 * - operationsGuardianOf returns it as a ChainAddress on that network, or
 *   null when the network has none or is not configured at all.
 */

import { describe, expect, it } from 'vitest';

import { encodeAccountAddress } from './codecs/index.js';
import {
  InvalidInputError,
  operationsGuardianOf,
  operationsGuardiansOf,
  parseNetworksConfig,
} from './index.js';

const account = (fill: number): string => encodeAccountAddress(new Uint8Array(32).fill(fill));
const GUARDIAN = account(9);
const EXECUTOR = account(1);

function key(keyId: string, address: string): Record<string, unknown> {
  return { provider: 'aws_kms', keyId, address };
}

function section(guardian?: string): Record<string, unknown> {
  return {
    enabled: true,
    rpc: [{ url: 'secretRef:testnet_rpc', weight: 1 }],
    maxEndpointLagSeconds: 15,
    trustedFactories: { '1': ['CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'] },
    assets: {
      USDC: {
        sac: 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ',
        issuer: 'GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC',
      },
    },
    deposits: { startLedger: 0, availableAt: 'included', pageEvents: 500 },
    executor: { txValiditySeconds: 60, keys: [key('alias/executor', EXECUTOR)] },
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
      key: key('alias/sponsor', account(2)),
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
    ...(guardian === undefined ? {} : { operationsGuardian: guardian }),
  };
}

function issuesOf(input: unknown): readonly string[] {
  try {
    parseNetworksConfig(input);
  } catch (err) {
    if (err instanceof InvalidInputError) return err.issues;
    throw err;
  }
  return [];
}

describe('operations guardian', () => {
  it('reads the configured guardian as an address on that network', () => {
    const config = parseNetworksConfig({ 'stellar:testnet': section(GUARDIAN) });
    expect(operationsGuardianOf(config, 'stellar:testnet')).toEqual({
      network: 'stellar:testnet',
      value: GUARDIAN,
    });
  });

  it('is null when the network has none or is not configured', () => {
    const config = parseNetworksConfig({ 'stellar:testnet': section() });
    expect(operationsGuardianOf(config, 'stellar:testnet')).toBeNull();
    expect(operationsGuardianOf(config, 'stellar:pubnet')).toBeNull();
  });

  it('refuses a guardian that is not a checked account', () => {
    expect(issuesOf({ 'stellar:testnet': section(`${GUARDIAN.slice(0, -1)}A`) })).toEqual([
      'networks.stellar:testnet.operationsGuardian (custom)',
    ]);
  });

  it('refuses a guardian that is also a signing key', () => {
    expect(issuesOf({ 'stellar:testnet': section(EXECUTOR) })).toEqual([
      'networks.stellar:testnet.operationsGuardian (custom)',
    ]);
  });
});

describe('the addresses an operations guardian replaced', () => {
  const PAST = account(8);
  const OLDER = account(7);
  const retiring = (guardian: string | undefined, retired: readonly string[]) => ({
    'stellar:testnet': { ...section(guardian), retiredOperationsGuardians: [...retired] },
  });

  it('reads every address the network has used, the current one first', () => {
    const config = parseNetworksConfig(retiring(GUARDIAN, [PAST, OLDER]));
    expect(operationsGuardiansOf(config, 'stellar:testnet')).toEqual([
      { network: 'stellar:testnet', value: GUARDIAN },
      { network: 'stellar:testnet', value: PAST },
      { network: 'stellar:testnet', value: OLDER },
    ]);
    expect(operationsGuardianOf(config, 'stellar:testnet')).toEqual({
      network: 'stellar:testnet',
      value: GUARDIAN,
    });
  });

  it('reads the past addresses of a network that has no current one', () => {
    const config = parseNetworksConfig(retiring(undefined, [PAST]));
    expect(operationsGuardiansOf(config, 'stellar:testnet')).toEqual([
      { network: 'stellar:testnet', value: PAST },
    ]);
    expect(operationsGuardianOf(config, 'stellar:testnet')).toBeNull();
  });

  it('reads none for a network with none, or one not configured', () => {
    const config = parseNetworksConfig({ 'stellar:testnet': section() });
    expect(operationsGuardiansOf(config, 'stellar:testnet')).toEqual([]);
    expect(operationsGuardiansOf(config, 'stellar:pubnet')).toEqual([]);
  });

  it('refuses the current address listed as a past one too', () => {
    expect(issuesOf(retiring(GUARDIAN, [GUARDIAN])).join('\n')).toContain(
      'retiredOperationsGuardians',
    );
  });

  it('refuses a past address listed twice', () => {
    expect(issuesOf(retiring(GUARDIAN, [PAST, PAST])).join('\n')).toContain(
      'retiredOperationsGuardians',
    );
  });

  it('refuses a past address that is a key UJIRA signs with', () => {
    expect(issuesOf(retiring(GUARDIAN, [EXECUTOR])).join('\n')).toContain(
      'retiredOperationsGuardians',
    );
  });

  it('refuses a past address that is not a Stellar account', () => {
    expect(issuesOf(retiring(GUARDIAN, ['not-an-account']))).not.toEqual([]);
  });
});
