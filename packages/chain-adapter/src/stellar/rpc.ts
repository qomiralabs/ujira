// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The slice of Stellar RPC the mandate calls need, over plain JSON-RPC. The
// adapter takes this port rather than an SDK server, so unit tests answer it
// from recorded responses and a failover client can wrap it later. Endpoint
// URLs carry provider API keys, so no error built here holds the URL, a
// response body or a cause beyond its class name.

import type { Api } from '@stellar/stellar-sdk/rpc';

import {
  ChainUnavailableError,
  RpcRateLimitedError,
  RpcTimeoutError,
  SubmissionUnknownError,
} from '../errors.js';
import type { Landed } from '../errors.js';
import type { NetworkId } from '../networks.js';
import type { CallOptions } from '../types.js';

export interface RpcLedgerEntry {
  /** Base64 LedgerKey. */
  readonly key: string;
  /** Base64 LedgerEntryData. */
  readonly xdr: string;
  readonly lastModifiedLedgerSeq: number;
  /** Absent for entries that do not expire, such as accounts. */
  readonly liveUntilLedgerSeq?: number;
}

export interface RpcLatestLedger {
  readonly sequence: number;
  /** Close time of that ledger in unix seconds, as the RPC reports it. */
  readonly closeTime: bigint;
}

export type RpcSendStatus = 'PENDING' | 'DUPLICATE' | 'TRY_AGAIN_LATER' | 'ERROR';

export interface RpcSendResult {
  readonly status: RpcSendStatus;
  readonly hash: string;
  /** Base64 TransactionResult, set with status ERROR. */
  readonly errorResultXdr?: string;
}

export interface RpcTransaction {
  readonly status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
  readonly ledger?: number;
  /** Base64 TransactionResult once included. */
  readonly resultXdr?: string;
  /** Base64 TransactionMeta once included, which lists any restored entries. */
  readonly resultMetaXdr?: string;
}

export type RawSimulation = Api.RawSimulateTransactionResponse;

export interface StellarRpc {
  getLatestLedger(opts: CallOptions): Promise<RpcLatestLedger>;
  getLedgerEntries(
    keys: readonly string[],
    opts: CallOptions,
  ): Promise<{ readonly latestLedger: number; readonly entries: readonly RpcLedgerEntry[] }>;
  simulateTransaction(txXdr: string, opts: CallOptions): Promise<RawSimulation>;
  sendTransaction(txXdr: string, opts: CallOptions): Promise<RpcSendResult>;
  getTransaction(hash: string, opts: CallOptions): Promise<RpcTransaction>;
}

export interface JsonRpcOptions {
  readonly network: NetworkId;
  /** Resolved from the secret manager by the caller. Never logged. */
  readonly url: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const HTTP_TOO_MANY_REQUESTS = 429;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(body: Json, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw new TypeError('malformed RPC result');
  return value;
}

function int(body: Json, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('malformed RPC result');
  }
  return value;
}

function optionalInt(body: Json, field: string): number | undefined {
  return body[field] === undefined ? undefined : int(body, field);
}

const SEND_STATUSES: ReadonlySet<unknown> = new Set([
  'PENDING',
  'DUPLICATE',
  'TRY_AGAIN_LATER',
  'ERROR',
]);
const TX_STATUSES: ReadonlySet<unknown> = new Set(['SUCCESS', 'FAILED', 'NOT_FOUND']);

/** A JSON-RPC client for one endpoint. */
export function createStellarRpc(options: JsonRpcOptions): StellarRpc {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { network } = options;

  async function call(
    method: string,
    params: Json,
    opts: CallOptions,
    landed: Landed,
  ): Promise<Json> {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (opts.signal !== undefined) signals.push(opts.signal);
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw new RpcTimeoutError({ network, landed, cause: error });
      }
      // A send whose connection dropped may still have reached the node.
      if (landed === 'unknown') throw new SubmissionUnknownError({ network, cause: error });
      throw new ChainUnavailableError({ network, cause: error });
    }
    if (response.status === HTTP_TOO_MANY_REQUESTS) throw new RpcRateLimitedError({ network });
    // Past this point the endpoint took the request, so a send may have gone
    // through whatever came back. Only a read can call this an outage.
    const lost = (cause?: unknown) => {
      const options = { network, ...(cause === undefined ? {} : { cause }) };
      return landed === 'unknown'
        ? new SubmissionUnknownError(options)
        : new ChainUnavailableError(options);
    };
    if (!response.ok) throw lost();
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw lost(error);
    }
    if (!isObject(body) || !isObject(body['result'])) throw lost();
    return body['result'];
  }

  // A result in an unexpected shape means the endpoint is not one we can
  // use, which is an outage of that endpoint, never a fact about the chain.
  function parse<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      throw new ChainUnavailableError({ network, cause: error });
    }
  }

  return {
    async getLatestLedger(opts) {
      const result = await call('getLatestLedger', {}, opts, 'no');
      return parse(() => ({
        sequence: int(result, 'sequence'),
        closeTime: BigInt(str(result, 'closeTime')),
      }));
    },

    async getLedgerEntries(keys, opts) {
      const result = await call('getLedgerEntries', { keys: [...keys] }, opts, 'no');
      return parse(() => {
        const list = result['entries'] ?? [];
        if (!Array.isArray(list)) throw new TypeError('malformed RPC result');
        const entries = list.map((item: unknown): RpcLedgerEntry => {
          if (!isObject(item)) throw new TypeError('malformed RPC result');
          const live = optionalInt(item, 'liveUntilLedgerSeq');
          return {
            key: str(item, 'key'),
            xdr: str(item, 'xdr'),
            lastModifiedLedgerSeq: int(item, 'lastModifiedLedgerSeq'),
            ...(live === undefined ? {} : { liveUntilLedgerSeq: live }),
          };
        });
        return { latestLedger: int(result, 'latestLedger'), entries };
      });
    },

    async simulateTransaction(txXdr, opts) {
      const result = await call('simulateTransaction', { transaction: txXdr }, opts, 'no');
      return parse(() => {
        int(result, 'latestLedger');
        return result as unknown as RawSimulation;
      });
    },

    async sendTransaction(txXdr, opts) {
      const result = await call('sendTransaction', { transaction: txXdr }, opts, 'unknown');
      const status = result['status'];
      const hash = result['hash'];
      if (!SEND_STATUSES.has(status) || typeof hash !== 'string') {
        throw new SubmissionUnknownError({ network });
      }
      const errorResultXdr = result['errorResultXdr'];
      return {
        status: status as RpcSendStatus,
        hash,
        ...(typeof errorResultXdr === 'string' ? { errorResultXdr } : {}),
      };
    },

    async getTransaction(hash, opts) {
      const result = await call('getTransaction', { hash }, opts, 'no');
      return parse(() => {
        const status = result['status'];
        if (!TX_STATUSES.has(status)) throw new TypeError('malformed RPC result');
        const ledger = optionalInt(result, 'ledger');
        const resultXdr = result['resultXdr'];
        const resultMetaXdr = result['resultMetaXdr'];
        return {
          status: status as RpcTransaction['status'],
          ...(ledger === undefined ? {} : { ledger }),
          ...(typeof resultXdr === 'string' ? { resultXdr } : {}),
          ...(typeof resultMetaXdr === 'string' ? { resultMetaXdr } : {}),
        };
      });
    },
  };
}
