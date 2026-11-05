// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The sweep worker's view of Stellar. Everything the worker decides on comes from
// here, so what cannot be read is an error rather than an answer. A landed
// transaction whose events are unreadable must not read as one that moved nothing,
// or the row would be failed and a second sweep could follow a first that worked.

import { xdr } from '@stellar/stellar-sdk/base';
import { tokenAmount } from '@ujira/core';

import { STRKEY_VERSION, encodeStrkey } from '../codecs/strkey.js';
import { ChainUnavailableError, SubmissionRejectedError } from '../errors.js';
import type { SweepChain, SweepChainResult, SweepTransferEvent } from '../funding-sweep.js';
import { chainOf } from '../networks.js';
import type { StellarNetworkId } from '../networks.js';
import type { AdapterPorts } from '../types.js';

import { describeSweepEnvelope } from './funding-sweep.js';
import type { StellarRpc } from './rpc.js';
import { asAddress, asI128, field, fieldsOf, sym } from './scval.js';
import { submitEnvelope } from './submit.js';

// BalanceError in the Stellar Asset Contract's error enum.
const SAC_BALANCE_ERROR = 10;

export interface StellarSweepChainOptions {
  readonly network: StellarNetworkId;
  readonly rpc: Pick<StellarRpc, 'sendTransaction' | 'getTransaction' | 'getLatestLedger'>;
  readonly ports: Pick<AdapterPorts, 'config'>;
  /** How long a send may take before its outcome counts as unknown. */
  readonly submitTimeoutMs: number;
}

interface MetaEvents {
  readonly contract: readonly xdr.ContractEvent[];
  readonly diagnostic: readonly xdr.DiagnosticEvent[];
}

function eventsOf(meta: xdr.TransactionMeta): MetaEvents | null {
  if ('v4' in meta) {
    return {
      contract: meta.v4.operations.flatMap((op) => op.events),
      diagnostic: meta.v4.diagnosticEvents,
    };
  }
  if ('v3' in meta) {
    return {
      contract: meta.v3.sorobanMeta?.events ?? [],
      diagnostic: meta.v3.sorobanMeta?.diagnosticEvents ?? [],
    };
  }
  return null;
}

function readMeta(resultMetaXdr: string | undefined): MetaEvents | null {
  if (resultMetaXdr === undefined) return null;
  try {
    return eventsOf(xdr.TransactionMeta.fromXdr(resultMetaXdr, 'base64'));
  } catch {
    return null;
  }
}

function sourceOf(event: xdr.ContractEvent): string | null {
  const id = event.contractId;
  return id === null ? null : encodeStrkey(STRKEY_VERSION.contract, id.toBytes());
}

function isSymbol(value: xdr.ScVal | undefined, name: string): boolean {
  return value?.toXdr('base64') === sym(name).toXdr('base64');
}

// A plain amount, or since CAP-67 a map holding it beside a muxed destination.
function amountOf(data: xdr.ScVal): bigint {
  return data.type === 'scvMap' ? asI128(field(fieldsOf(data), 'amount')) : asI128(data);
}

/**
 * The transfers the configured asset contract reported. The token is the contract
 * the ledger recorded as the event's source, so another contract emitting an event
 * shaped like a transfer is not one.
 */
function transfersOf(
  network: StellarNetworkId,
  usdc: string,
  events: readonly xdr.ContractEvent[],
): readonly SweepTransferEvent[] {
  const chain = chainOf(network);
  const transfers: SweepTransferEvent[] = [];
  events.forEach((event, eventIndex) => {
    if (sourceOf(event) !== usdc || event.type.name !== 'contract') return;
    const { topics, data } = event.body.v0;
    const [name, from, to] = topics;
    if (!isSymbol(name, 'transfer') || from === undefined || to === undefined) return;
    transfers.push({
      eventIndex,
      token: usdc,
      from: asAddress(from),
      to: asAddress(to),
      amount: tokenAmount(amountOf(data), 'USDC', chain),
    });
  });
  return transfers;
}

// The result code only says the call trapped. Which error it trapped with is in the
// diagnostic events, which a node may leave out. A failure this cannot name reads as
// rejected: the worst of that is asking the principal to sign again, where wrongly
// reading insufficient balance would strand the deposit.
function failureOf(
  usdc: string,
  diagnostics: readonly xdr.DiagnosticEvent[],
): 'insufficient_balance' | 'rejected' {
  const short = diagnostics.some(({ event }) => {
    if (sourceOf(event) !== usdc) return false;
    const [name, code] = event.body.v0.topics;
    return (
      isSymbol(name, 'error') &&
      code?.type === 'scvError' &&
      code.error.type === 'sceContract' &&
      code.error.contractCode === SAC_BALANCE_ERROR
    );
  });
  return short ? 'insufficient_balance' : 'rejected';
}

export function createStellarSweepChain(options: StellarSweepChainOptions): SweepChain {
  const { network, rpc, ports, submitTimeoutMs } = options;
  const correlationId = 'funding-sweep';
  const usdc = (): string => {
    const config = ports.config()[network];
    if (config === undefined) throw new ChainUnavailableError({ network });
    return config.assets.USDC.sac;
  };

  return {
    describe(signedPayload) {
      const facts = describeSweepEnvelope(signedPayload, network);
      return {
        txHash: facts.txHash,
        validUntil: new Date(Number(facts.validUntilSeconds) * 1000),
        authExpiresLedger: facts.authExpiresLedger,
      };
    },

    async send(signedPayload, signal) {
      const answer = await submitEnvelope(
        {
          send: (envelope, deadline) =>
            rpc.sendTransaction(envelope, {
              signal: AbortSignal.any([signal, deadline]),
              correlationId,
            }),
        },
        signedPayload,
        { network, timeoutMs: submitTimeoutMs },
      );
      if (answer.status === 'PENDING' || answer.status === 'DUPLICATE') return;
      // A busy node refused nothing. The step runs again, and looks the hash up first.
      if (answer.status === 'TRY_AGAIN_LATER') throw new ChainUnavailableError({ network });
      throw new SubmissionRejectedError({ network });
    },

    async result(txHash, signal): Promise<SweepChainResult> {
      const tx = await rpc.getTransaction(txHash, { signal, correlationId });
      if (tx.status === 'NOT_FOUND') {
        const since = tx.oldestLedgerCloseTime;
        return {
          kind: 'not_found',
          recordsSince: since === undefined ? null : new Date(Number(since) * 1000),
        };
      }
      if (tx.ledger === undefined) throw new ChainUnavailableError({ network });
      const events = readMeta(tx.resultMetaXdr);
      if (tx.status === 'FAILED') {
        return {
          kind: 'failed',
          ledger: tx.ledger,
          reason: failureOf(usdc(), events?.diagnostic ?? []),
        };
      }
      if (events === null) throw new ChainUnavailableError({ network });
      return {
        kind: 'landed',
        ledger: tx.ledger,
        transfers: transfersOf(network, usdc(), events.contract),
      };
    },

    async latestLedger(signal) {
      const latest = await rpc.getLatestLedger({ signal, correlationId });
      return latest.sequence;
    },
  };
}
