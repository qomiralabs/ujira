// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The keep-alive job's chain ports over the Stellar adapter's RPC client and
// its leased channel accounts. UJIRA's own channel account is the source and
// pays, so the principal never pays to keep a mandate alive.

import { SorobanDataBuilder, xdr } from '@stellar/stellar-sdk/base';

import type { SubmissionOp } from '../types.js';

import { extendTtl, restoreArchived } from './contract-call.js';
import { ExecutorSession } from './executor.js';
import type { ExecutorContext } from './executor.js';
import { preparedFootprintTx } from './restore.js';
import type { StellarRpc } from './rpc.js';
import type { EntryTtl, TtlReader, TtlSubmission, TtlSubmitter } from './ttl-job.js';

/**
 * Reads entries over RPC. An entry whose liveUntilLedgerSeq has passed is
 * archived. One with none does not expire, so it never counts as lapsing, and
 * one the node does not return is left out for the job to report as missing.
 */
export function ttlReaderFromRpc(rpc: StellarRpc, correlationId: string): TtlReader {
  return {
    async readTtl(_network, keys, signal) {
      const { latestLedger, entries } = await rpc.getLedgerEntries(keys, { signal, correlationId });
      return {
        latestLedger,
        entries: entries.map((entry): EntryTtl => {
          const liveUntil = entry.liveUntilLedgerSeq ?? Number.MAX_SAFE_INTEGER;
          return liveUntil < latestLedger
            ? { key: entry.key, state: 'archived' }
            : { key: entry.key, state: 'live', liveUntilLedgerSeq: liveUntil };
        }),
      };
    },
  };
}

function ledgerKeys(req: TtlSubmission): xdr.LedgerKey[] {
  return req.keys.map((key) => xdr.LedgerKey.fromXdr(key, 'base64'));
}

/**
 * Sends restores and extensions from a leased channel account, each built
 * from a fresh simulation and resolved once it landed. The submission is
 * recorded before it is sent, as every other one is.
 */
export function ttlSubmitterFromExecutor(
  ctx: ExecutorContext,
  correlationId: string,
): TtlSubmitter {
  const send = (
    req: TtlSubmission,
    op: SubmissionOp,
    call: Parameters<typeof preparedFootprintTx>[3],
    data: xdr.SorobanTransactionData,
    signal: AbortSignal,
  ): Promise<{ readonly txHash: string }> => {
    const opts = { signal, correlationId };
    return ExecutorSession.run(ctx, opts, async (session) => {
      const tx = await preparedFootprintTx(ctx, session, req.mandate, call, data, opts);
      const { hash } = await session.send(
        tx,
        { scope: req.scope, op, mandate: req.mandate, correlationId },
        opts,
        true,
      );
      return { txHash: hash };
    });
  };
  return {
    restore: (req, signal) =>
      send(
        req,
        'restore',
        restoreArchived() as Parameters<typeof preparedFootprintTx>[3],
        new SorobanDataBuilder().setReadWrite(ledgerKeys(req)).build(),
        signal,
      ),
    extend: (req, signal) =>
      send(
        req,
        'ttl_extend',
        extendTtl(req.extendToLedgers) as Parameters<typeof preparedFootprintTx>[3],
        new SorobanDataBuilder().setReadOnly(ledgerKeys(req)).build(),
        signal,
      ),
  };
}
