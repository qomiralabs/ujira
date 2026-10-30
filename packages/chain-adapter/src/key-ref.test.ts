// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the startup key check (key-ref.ts).
 *
 * pinnedKeys(network, section) lists every key a network pins, each with
 * the ref the signer serves it under: one executor ref per pool key (by key
 * ID), the fee sponsor, and one sep10 ref per anchor.
 *
 * verifyPinnedAddresses(signer, config, opts) asks the signer for the
 * address of every pinned key of every configured network, one at a time,
 * and throws SignerAddressMismatchError (SIGNER_ADDRESS_MISMATCH, not
 * retryable) at the first answer whose network or value differs from the
 * pin, before asking for any later key. The error names the network only,
 * never an address. Signer failures pass through unchanged.
 */

import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { encodeAccountAddress } from './codecs/index.js';
import {
  SignerAddressMismatchError,
  SignerDeniedError,
  SignerUnavailableError,
  parseNetworksConfig,
  pinnedKeys,
  verifyPinnedAddresses,
} from './index.js';
import type {
  CallOptions,
  ChainAddress,
  NetworkId,
  NetworksConfig,
  SignerProvider,
  SignerRef,
} from './index.js';

const FACTORY = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SAC = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
const ISSUER = 'GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC';
const OPTS: CallOptions = { correlationId: 'startup-check' };

const account = (fill: number): string => encodeAccountAddress(new Uint8Array(32).fill(fill));

function section(base: number): Record<string, unknown> {
  const key = (keyId: string, fill: number) => ({
    provider: 'local',
    keyId,
    address: account(base + fill),
  });
  return {
    enabled: base === 0,
    rpc: [{ url: 'secretRef:stellar_rpc', weight: 1 }],
    maxEndpointLagSeconds: 15,
    trustedFactories: { '1': [FACTORY] },
    assets: { USDC: { sac: SAC, issuer: ISSUER } },
    deposits: { startLedger: 0, availableAt: 'included', pageEvents: 500 },
    executor: { txValiditySeconds: 60, keys: [key('executor_0', 1), key('executor_1', 2)] },
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
      key: key('fee_sponsor', 3),
    },
    sep10: [{ anchorId: 'anchor.example', key: key('sep10_anchor', 4) }],
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

// Testnet is enabled and pubnet is not; both are checked.
const CONFIG: NetworksConfig = parseNetworksConfig({
  'stellar:testnet': section(0),
  'stellar:pubnet': section(10),
});

const pinned = (network: NetworkId) => {
  const networkSection = CONFIG[network];
  if (networkSection === undefined) throw new Error('fixture has both networks');
  return pinnedKeys(network, networkSection);
};

/** A signer that answers each ref with what `answer` gives, and records what it was asked. */
function signerAnswering(answer: (ref: SignerRef) => ChainAddress | Error) {
  const asked: SignerRef[] = [];
  const passed: CallOptions[] = [];
  const signer: SignerProvider = {
    sign: () => Promise.reject(new SignerDeniedError()),
    health: () => Promise.reject(new SignerUnavailableError()),
    address: (ref, opts) => {
      asked.push(ref);
      passed.push(opts);
      const result = answer(ref);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return { signer, asked, passed };
}

// The truthful answer: each ref's pinned address on its own network.
function truth(ref: SignerRef): ChainAddress {
  const entry = pinned(ref.network).find((p) => JSON.stringify(p.ref) === JSON.stringify(ref));
  if (entry === undefined) throw new Error('asked for a ref nobody pinned');
  return { network: ref.network, value: entry.key.address };
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('pinnedKeys', () => {
  it('lists every key with the ref the signer serves it under', () => {
    expect(pinned('stellar:testnet').map((p) => p.ref)).toEqual([
      { kind: 'executor', network: 'stellar:testnet', keyId: 'executor_0' },
      { kind: 'executor', network: 'stellar:testnet', keyId: 'executor_1' },
      { kind: 'fee_sponsor', network: 'stellar:testnet' },
      { kind: 'sep10', network: 'stellar:testnet', anchorId: 'anchor.example' },
    ]);
    expect(pinned('stellar:testnet').map((p) => p.key.address)).toEqual([
      account(1),
      account(2),
      account(3),
      account(4),
    ]);
    expect(Object.isFrozen(pinned('stellar:pubnet'))).toBe(true);
  });
});

describe('verifyPinnedAddresses', () => {
  it('passes when every key controls its pinned account', async () => {
    const { signer, asked, passed } = signerAnswering(truth);
    await expect(verifyPinnedAddresses(signer, CONFIG, OPTS)).resolves.toBeUndefined();
    // Every key of both networks, enabled or not, in a stable order.
    expect(asked).toEqual([
      ...pinned('stellar:pubnet').map((p) => p.ref),
      ...pinned('stellar:testnet').map((p) => p.ref),
    ]);
    expect(passed.every((opts) => opts === OPTS)).toBe(true);
  });

  it('mismatched address raises SIGNER_ADDRESS_MISMATCH', async () => {
    const swapped = account(99);
    const { signer, asked } = signerAnswering((ref) =>
      ref.kind === 'fee_sponsor' && ref.network === 'stellar:testnet'
        ? { network: ref.network, value: swapped }
        : truth(ref),
    );
    const err = await rejection(() => verifyPinnedAddresses(signer, CONFIG, OPTS));
    expect(err).toBeInstanceOf(SignerAddressMismatchError);
    const mismatch = err as SignerAddressMismatchError;
    expect(mismatch.code).toBe('SIGNER_ADDRESS_MISMATCH');
    expect(mismatch.retryable).toBe(false);
    expect(mismatch.network).toBe('stellar:testnet');
    // The check stops at the bad key: the SEP-10 key after it is never asked.
    expect(asked.at(-1)).toEqual({ kind: 'fee_sponsor', network: 'stellar:testnet' });
    expect(asked.some((ref) => ref.kind === 'sep10' && ref.network === 'stellar:testnet')).toBe(
      false,
    );
    // Neither address is in anything that could be logged.
    for (const text of [inspect(err, { depth: Infinity }), JSON.stringify(err), String(err)]) {
      expect(text).not.toContain(swapped);
      expect(text).not.toContain(account(3));
    }
  });

  it('treats the right account on another network as a mismatch', async () => {
    const { signer } = signerAnswering((ref) => ({
      network: 'stellar:pubnet',
      value: truth(ref).value,
    }));
    const err = await rejection(() => verifyPinnedAddresses(signer, CONFIG, OPTS));
    expect(err).toBeInstanceOf(SignerAddressMismatchError);
  });

  it('lets a signer failure through as it is', async () => {
    const outage = new SignerUnavailableError({ network: 'stellar:pubnet' });
    const { signer, asked } = signerAnswering(() => outage);
    expect(await rejection(() => verifyPinnedAddresses(signer, CONFIG, OPTS))).toBe(outage);
    expect(asked).toHaveLength(1);
  });

  it('checks only the networks the snapshot holds', async () => {
    const { signer, asked } = signerAnswering(truth);
    const testnetOnly = parseNetworksConfig({ 'stellar:testnet': section(0) });
    await verifyPinnedAddresses(signer, testnetOnly, OPTS);
    expect(asked.every((ref) => ref.network === 'stellar:testnet')).toBe(true);
    expect(asked).toHaveLength(4);
    const none = signerAnswering(truth);
    await verifyPinnedAddresses(none.signer, parseNetworksConfig({}), OPTS);
    expect(none.asked).toEqual([]);
  });
});
