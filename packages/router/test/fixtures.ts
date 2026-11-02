// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A valid routing document for tests: one testnet network, two anchors and
// the recipient's own wallet, and three corridors. Every call returns a
// fresh copy, so a test can change it freely.

import { encodeAccountAddress } from '@ujira/chain-adapter/codecs';

export const TESTNET = 'stellar:testnet';

const FACTORY = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SAC = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
const ISSUER = 'GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC';

const account = (fill: number): string => encodeAccountAddress(new Uint8Array(32).fill(fill));

function key(keyId: string, fill: number): Record<string, unknown> {
  return { provider: 'aws_kms', keyId, address: account(fill) };
}

export function networkSection(): Record<string, unknown> {
  return {
    enabled: true,
    rpc: [{ url: 'secretRef:testnet_rpc_primary', weight: 1 }],
    maxEndpointLagSeconds: 15,
    trustedFactories: { '1': [FACTORY] },
    assets: { USDC: { sac: SAC, issuer: ISSUER } },
    deposits: { startLedger: 0, availableAt: 'included', pageEvents: 500 },
    executor: { txValiditySeconds: 60, keys: [key('alias/ujira-executor-0', 1)] },
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
      key: key('alias/ujira-fee-sponsor', 2),
    },
    sep10: [
      { anchorId: 'anchor-a.example', key: key('alias/ujira-sep10-a', 3) },
      { anchorId: 'anchor-b.example', key: key('alias/ujira-sep10-b', 4) },
    ],
    signingWindowSeconds: 300,
    explorer: { tx: 'https://stellar.expert/explorer/testnet/tx/{hash}' },
    health: {
      maxHeadLagSeconds: 30,
      degradedErrorBps: 500,
      downErrorBps: 5000,
      hysteresisChecks: 3,
    },
  };
}

export interface TestDocument {
  schemaVersion: number;
  networks: Record<string, Record<string, unknown>>;
  rails: Record<string, unknown>[];
  corridors: (Record<string, unknown> & { candidates: Record<string, unknown>[] })[];
}

export function routingDocument(): TestDocument {
  return {
    schemaVersion: 1,
    networks: { [TESTNET]: networkSection() },
    rails: [
      {
        id: 'anchor_a',
        network: TESTNET,
        rail: 'stellar.sep31',
        provider: 'anchor-a.example',
        enabled: true,
      },
      {
        id: 'anchor_b',
        network: TESTNET,
        rail: 'stellar.sep31',
        provider: 'anchor-b.example',
        enabled: true,
      },
      { id: 'wallet', network: TESTNET, rail: 'stellar.wallet', enabled: true },
    ],
    corridors: [
      {
        country: 'NG',
        method: 'bank',
        currency: 'NGN',
        enabled: true,
        strategy: 'cheapest',
        candidates: [
          { rail: 'anchor_a', priority: 1 },
          { rail: 'anchor_b', priority: 2 },
        ],
      },
      {
        country: 'NG',
        method: 'stellar_wallet',
        currency: 'USDC',
        enabled: true,
        strategy: 'priority',
        candidates: [{ rail: 'wallet', priority: 1 }],
      },
      {
        country: 'KE',
        method: 'mobile_money',
        currency: 'KES',
        enabled: true,
        strategy: 'priority',
        candidates: [
          { rail: 'anchor_b', priority: 1 },
          { rail: 'wallet', priority: 5 },
        ],
      },
    ],
  };
}

const COUNTRIES = ['NG', 'KE', 'GH', 'ZA', 'PH', 'IN', 'BR', 'CO', 'MX', 'US', 'GB', 'FR'];

/**
 * A document whose contents all carry one marker: version v has v
 * corridors, every candidate priority is v, and the wallet rail is enabled
 * only when v is even. A snapshot mixing two versions breaks one of these.
 */
export function markedDocument(v: number): TestDocument {
  const doc = routingDocument();
  doc.corridors = COUNTRIES.slice(0, v).map((country) => ({
    country,
    method: 'stellar_wallet',
    currency: 'USDC',
    enabled: true,
    strategy: 'priority',
    candidates: [
      { rail: 'wallet', priority: v },
      { rail: 'anchor_a', priority: v },
    ],
  }));
  doc.rails = doc.rails.map((rail) =>
    rail['id'] === 'wallet' ? { ...rail, enabled: v % 2 === 0 } : rail,
  );
  return doc;
}

export const MAX_MARKED_VERSION = COUNTRIES.length;
