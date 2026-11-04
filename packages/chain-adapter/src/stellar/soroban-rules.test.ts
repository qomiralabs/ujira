// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { SorobanDataBuilder, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import type { Transaction } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import type { NetworksConfig } from '../config.js';

import { StellarMandateAdapter } from './mandate-adapter.js';
import { createMemorySigningRequestStore } from './requests.js';
import { decodeFeeWrite1KB, feeWriteSettingKey } from './rent-settings.js';
import {
  MIN_WRITE_BYTES_PADDING,
  PADDED_CALLS,
  checkPaddingValidated,
  createMemoryStepLog,
  padWriteBytes,
  resourceFailureOf,
  restoredKeysOf,
  ttlExtensionKey,
} from './soroban-rules.js';
import { NETWORK, OPTS, setup } from './test-adapter.js';
import { failedFeeBumpResult, failedResult, restoredMeta } from './test-results.js';
import recorded from './testnet-rent-settings.json' with { type: 'json' };
import { PASSPHRASES } from './tx.js';

const [, , , FEE_WRITE_ENTRY = ''] = recorded.entries;

describe('resourceFailureOf', () => {
  it('names the two failures that get re-simulated, plain or inside a fee bump', () => {
    expect(resourceFailureOf(failedResult('resource_limit'))).toBe('resource_limit');
    expect(resourceFailureOf(failedResult('entry_archived'))).toBe('entry_archived');
    expect(resourceFailureOf(failedFeeBumpResult('resource_limit'))).toBe('resource_limit');
    expect(resourceFailureOf(failedFeeBumpResult('entry_archived'))).toBe('entry_archived');
  });

  it('reads anything else as no resource failure', () => {
    expect(resourceFailureOf(failedResult('trapped'))).toBeNull();
    expect(resourceFailureOf(failedFeeBumpResult('trapped'))).toBeNull();
    expect(resourceFailureOf(undefined)).toBeNull();
    expect(resourceFailureOf('not xdr')).toBeNull();
  });
});

describe('write padding', () => {
  const simulated = new SorobanDataBuilder()
    .setResources(1_000, 200, 300)
    .setResourceFee(50_000n)
    .build()
    .toXdr('base64');

  it('adds the bytes and the fee they cost, and keeps the rest as simulated', () => {
    const { sorobanData, addedFee } = padWriteBytes(simulated, {
      network: NETWORK,
      paddingBytes: 512,
      feeWrite1KB: 437n,
    });
    // 512 bytes at 437 per 1 KB is 218.5, rounded up.
    expect(addedFee).toBe(219n);
    const data = xdr.SorobanTransactionData.fromXdr(sorobanData, 'base64');
    expect(data.resources).toMatchObject({
      instructions: 1_000,
      diskReadBytes: 200,
      writeBytes: 812,
    });
    expect(data.resourceFee).toBe(50_219n);
  });

  it('refuses less than the minimum', () => {
    expect(MIN_WRITE_BYTES_PADDING).toBe(512);
    for (const paddingBytes of [511, 0, 1.5]) {
      expect(() =>
        padWriteBytes(simulated, { network: NETWORK, paddingBytes, feeWrite1KB: 437n }),
      ).toThrow(InvalidInputError);
    }
  });

  it('applies to no current call, and is applied before a principal signs when one needs it', async () => {
    expect([...PADDED_CALLS]).toEqual([]);
    const t = setup();
    const key = feeWriteSettingKey();
    t.rpc.entries.set(key, { key, xdr: FEE_WRITE_ENTRY, lastModifiedLedgerSeq: 1 });
    const req = {
      scope: t.scope,
      mandate: t.mandate,
      action: { op: 'revoke' },
      signer: {
        kind: 'external',
        network: NETWORK,
        role: 'principal',
        address: { network: NETWORK, value: t.principal.publicKey() },
      },
    } as const;
    const writeBytes = (xdrText: string): number => {
      const tx = TransactionBuilder.fromXdr(xdrText, PASSPHRASES[NETWORK]) as Transaction;
      const env = tx.toEnvelope();
      if (env.type !== 'envelopeTypeTx' || env.v1.tx.ext.type !== 'sorobanData') return -1;
      return env.v1.tx.ext.sorobanData.resources.writeBytes;
    };

    // Revoke moves no funds, so it goes out as simulated.
    const plain = await t.adapter.prepareMandateAction(req, OPTS);
    if (plain.kind !== 'stellar_transaction') throw new Error('expected a transaction');
    expect(writeBytes(plain.xdr)).toBe(0);

    const padded = new StellarMandateAdapter({
      network: NETWORK,
      rpc: t.rpc,
      ports: t.ports,
      requests: createMemorySigningRequestStore(),
      paddedCalls: new Set(['revoke']),
      newRequestId: () => 'padded',
    });
    const request = await padded.prepareMandateAction(req, OPTS);
    if (request.kind !== 'stellar_transaction') throw new Error('expected a transaction');
    expect(writeBytes(request.xdr)).toBe(512);
    // 50,000 simulated, 219 of padding, and two inclusion fees of 100.
    expect(request.summary.estimatedFee?.amount).toBe(50_419n);
  });

  it('fails plainly when the write price cannot be read', async () => {
    const t = setup();
    const padded = new StellarMandateAdapter({
      network: NETWORK,
      rpc: t.rpc,
      ports: t.ports,
      requests: createMemorySigningRequestStore(),
      paddedCalls: new Set(['revoke']),
    });
    await expect(
      padded.prepareMandateAction(
        {
          scope: t.scope,
          mandate: t.mandate,
          action: { op: 'revoke' },
          signer: {
            kind: 'external',
            network: NETWORK,
            role: 'principal',
            address: { network: NETWORK, value: t.principal.publicKey() },
          },
        },
        OPTS,
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('reads the write price from the recorded network setting, and no other', () => {
    expect(decodeFeeWrite1KB(FEE_WRITE_ENTRY)).toBe(437n);
    const [other = ''] = recorded.entries;
    expect(() => decodeFeeWrite1KB(other)).toThrow(InvalidInputError);
  });
});

describe('restoredKeysOf', () => {
  const code = xdr.LedgerEntryData.contractCode(
    new xdr.ContractCodeEntry({
      ext: xdr.ContractCodeEntryExt.v0(),
      hash: new Uint8Array(32).fill(3),
      code: new Uint8Array(1),
    }),
  );

  it('lists each restored entry once, as a ledger key', () => {
    const expected = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: new Uint8Array(32).fill(3) }),
    ).toXdr('base64');
    expect(restoredKeysOf(restoredMeta([code, code]))).toEqual([expected]);
  });

  it('finds nothing in metadata it cannot read, or that lists nothing', () => {
    expect(restoredKeysOf(undefined)).toEqual([]);
    expect(restoredKeysOf('not xdr')).toEqual([]);
    expect(restoredKeysOf(restoredMeta([]))).toEqual([]);
  });
});

describe('the step after a restore', () => {
  it('is keyed by network, mandate, ttl_extend and ledger', () => {
    expect(ttlExtensionKey(NETWORK, 'CABC', 77)).toBe('stellar:testnet:CABC:ttl_extend:77');
  });

  it('remembers a step it was told is done', async () => {
    const log = createMemoryStepLog();
    expect(await log.isDone('a')).toBe(false);
    await log.markDone('a');
    expect(await log.isDone('a')).toBe(true);
    expect(await log.isDone('b')).toBe(false);
  });
});

describe('the padding version check', () => {
  const run = (rpcVersion: string, lastPassingVersion: string | null) => {
    const alerts: unknown[] = [];
    const ok = checkPaddingValidated({
      network: NETWORK,
      rpcVersion,
      lastPassingVersion,
      alert: (e) => alerts.push(e),
    });
    return { ok, alerts };
  };

  it('passes on the version the check last passed on', () => {
    expect(run('25.0.0', '25.0.0')).toEqual({ ok: true, alerts: [] });
  });

  it('alerts on a version change without a run, and on no run at all', () => {
    const changed = run('25.1.0', '25.0.0');
    expect(changed.ok).toBe(false);
    expect(changed.alerts).toEqual([
      { network: NETWORK, rpcVersion: '25.1.0', lastPassingVersion: '25.0.0' },
    ]);
    expect(run('25.1.0', null).ok).toBe(false);
  });
});

describe('the configuration', () => {
  it('defaults to the agreed values', () => {
    const t = setup();
    const config: NetworksConfig = t.ports.config();
    expect(config[NETWORK]?.soroban).toEqual({
      writeBytesPadding: 512,
      resimulateRetries: 2,
      instanceTtlExtendLedgers: 535_680,
    });
  });
});
