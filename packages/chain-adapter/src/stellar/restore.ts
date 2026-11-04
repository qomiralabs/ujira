// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The restore step. When a call needs archived entries, UJIRA restores them
// from one of its own channel accounts before the member signs, so the
// member's transaction never fails on an archive and never pays for one.
// The restored entries are then extended by the policy in restore-policy.ts.

import { Address, SorobanDataBuilder, xdr } from '@stellar/stellar-sdk/base';
import type { Transaction } from '@stellar/stellar-sdk/base';
import { Api } from '@stellar/stellar-sdk/rpc';

import type { CallOptions, TenantScope } from '../types.js';
import { extendTtl, restoreArchived } from './contract-call.js';
import { sendFresh } from './executor.js';
import type { ExecutorContext, ExecutorSession } from './executor.js';
import { extensionPlan } from './restore-policy.js';
import type { RestoredEntry } from './restore-policy.js';
import { asAddress, asU64, asVariant, field, fieldsOf } from './scval.js';
import { footprintTx, simulate, simulatedData } from './tx.js';
import type { Simulated } from './tx.js';

/** The entries a simulation found archived, each once. */
export function archivedKeys(sim: Simulated): readonly xdr.LedgerKey[] {
  const keys: xdr.LedgerKey[] = [];
  if (Api.isSimulationRestore(sim))
    keys.push(...sim.restorePreamble.transactionData.getReadWrite());
  const data = sim.transactionData.build();
  if (data.ext.type === 'resourceExt') {
    const readWrite = data.resources.footprint.readWrite;
    for (const index of data.ext.resourceExt.archivedSorobanEntries) {
      const key = readWrite[index];
      if (key !== undefined) keys.push(key);
    }
  }
  const seen = new Set<string>();
  return keys.filter((key) => {
    const id = key.toXdr('base64');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export interface RestoreTarget {
  readonly mandate: string;
  readonly asset: string;
}

function isKey(value: xdr.ScVal, name: string): readonly xdr.ScVal[] | null {
  if (value.type !== 'scvVec') return null;
  try {
    const variant = asVariant(value);
    return variant.name === name ? variant.payload : null;
  } catch {
    return null;
  }
}

/** What kind of entry a restored key is, read from the key and its value. */
export function classify(
  key: xdr.LedgerKey,
  value: xdr.ScVal | undefined,
  target: RestoreTarget,
): RestoredEntry {
  const id = key.toXdr('base64');
  if (key.type === 'contractCode') return { kind: 'code', key: id };
  if (key.type !== 'contractData') return { kind: 'other', key: id };
  const contract = Address.fromScAddress(key.contractData.contract).toString();
  const k = key.contractData.key;
  if (contract === target.mandate && k.type === 'scvLedgerKeyContractInstance') {
    return { kind: 'instance', key: id };
  }
  const balance = contract === target.asset ? isKey(k, 'Balance') : null;
  if (balance?.length === 1 && balance[0] !== undefined) {
    return asAddress(balance[0]) === target.mandate
      ? { kind: 'asset_balance', key: id }
      : { kind: 'other', key: id };
  }
  if (contract === target.mandate && isKey(k, 'Payout') !== null && value !== undefined) {
    const entry = asVariant(value);
    const [payload] = entry.payload;
    if (entry.name === 'Record' && payload !== undefined) {
      return {
        kind: 'open_record',
        key: id,
        expiresAt: asU64(field(fieldsOf(payload), 'expires_at')),
      };
    }
    if (entry.name === 'Tombstone') return { kind: 'tombstone', key: id };
  }
  return { kind: 'other', key: id };
}

export interface RestoreRequest {
  readonly scope: TenantScope;
  readonly target: RestoreTarget;
  readonly keys: readonly xdr.LedgerKey[];
  readonly instanceTtlExtendLedgers: number;
  readonly correlationId: string;
}

/**
 * A restore or an extension for the session's next sequence, built from a
 * fresh simulation of the footprint in `data`. Called again for each try, so a
 * retry uses the next sequence and a footprint of its own.
 */
export async function preparedFootprintTx(
  ctx: ExecutorContext,
  session: ExecutorSession,
  mandate: string,
  call: Parameters<typeof footprintTx>[0],
  data: xdr.SorobanTransactionData,
  opts: CallOptions,
): Promise<Transaction> {
  const { network, rpc, ports } = ctx;
  const maxTime =
    ports.clock.nowSeconds() + BigInt(ports.config()[network]?.executor.txValiditySeconds ?? 60);
  const build = { network, source: session.address, sequence: session.sequence, maxTime };
  const tx = footprintTx(call, { ...build, sorobanData: data.toXdr('base64') });
  const sim = await simulate(rpc, network, tx, mandate, opts);
  return footprintTx(call, { ...build, sorobanData: simulatedData(sim) });
}

/** Restores `keys` from the session's account, then extends them by policy. */
export async function restoreAndExtend(
  ctx: ExecutorContext,
  session: ExecutorSession,
  req: RestoreRequest,
  opts: CallOptions,
): Promise<void> {
  const record = {
    scope: req.scope,
    mandate: req.target.mandate,
    correlationId: req.correlationId,
  };
  const prepare = (
    call: Parameters<typeof footprintTx>[0],
    data: xdr.SorobanTransactionData,
  ): Promise<Transaction> =>
    preparedFootprintTx(ctx, session, req.target.mandate, call, data, opts);
  await sendFresh(
    ctx,
    session,
    () =>
      prepare(
        restoreArchived() as Parameters<typeof footprintTx>[0],
        new SorobanDataBuilder().setReadWrite([...req.keys]).build(),
      ),
    { ...record, op: 'restore' },
    opts,
  );
  await extendRestored(ctx, session, req, opts);
}

/**
 * Extends restored entries by policy: the instance and the asset balance to the
 * configured horizon, an open record to its expiry plus the margin and no
 * further, and a tombstone not at all.
 */
export async function extendRestored(
  ctx: ExecutorContext,
  session: ExecutorSession,
  req: RestoreRequest,
  opts: CallOptions,
): Promise<void> {
  const { rpc, ports } = ctx;
  const record = {
    scope: req.scope,
    mandate: req.target.mandate,
    correlationId: req.correlationId,
  };
  const prepare = (
    call: Parameters<typeof footprintTx>[0],
    data: xdr.SorobanTransactionData,
  ): Promise<Transaction> =>
    preparedFootprintTx(ctx, session, req.target.mandate, call, data, opts);
  const ids = req.keys.map((key) => key.toXdr('base64'));
  const { entries } = await rpc.getLedgerEntries(ids, opts);
  const values = new Map<string, xdr.ScVal>();
  for (const entry of entries) {
    const data = xdr.LedgerEntryData.fromXdr(entry.xdr, 'base64');
    if (data.type === 'contractData') values.set(entry.key, data.contractData.val);
  }
  const plan = extensionPlan(
    req.keys.map((key) => classify(key, values.get(key.toXdr('base64')), req.target)),
    {
      nowSeconds: ports.clock.nowSeconds(),
      instanceTtlExtendLedgers: req.instanceTtlExtendLedgers,
    },
  );
  for (const group of plan) {
    await sendFresh(
      ctx,
      session,
      () =>
        prepare(
          extendTtl(group.extendTo) as Parameters<typeof footprintTx>[0],
          new SorobanDataBuilder()
            .setReadOnly(group.keys.map((id) => xdr.LedgerKey.fromXdr(id, 'base64')))
            .build(),
        ),
      { ...record, op: 'ttl_extend' },
      opts,
    );
  }
}
