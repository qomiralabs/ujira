// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The last step before a signed envelope leaves the adapter. The memo rule
// runs again here, because an envelope can reach submission without passing
// through the builder: assembled by a wallet, returned by a signer or read
// back from storage after a restart.

import {
  assertNoMemoOnContractCall,
  checkNetwork,
  readTransactionEnvelope,
} from '../codecs/memo.js';
import {
  InvalidInputError,
  RpcTimeoutError,
  SubmissionUnknownError,
  isChainAdapterError,
} from '../errors.js';
import type { StellarNetworkId } from '../networks.js';

/**
 * Where a signed envelope is sent: an RPC node, or a relayer that pays the
 * fee and sends it on. `send` should stop when `signal` aborts; the submit
 * path gives up at the deadline either way.
 */
export interface EnvelopeTransport<T> {
  send(envelopeXdr: string, signal: AbortSignal): Promise<T>;
}

export interface SubmitOptions {
  readonly network: StellarNetworkId;
  /** How long to wait for the transport, in whole milliseconds. */
  readonly timeoutMs: number;
}

/** What a relayer is handed: the signed inner transaction, which it wraps in its own fee bump. */
export interface RelayerRequest {
  readonly network: StellarNetworkId;
  readonly xdr: string;
}

// Longer than any RPC send should take; a caller asking for more has a bug.
const MAX_TIMEOUT_MS = 600_000;

function checkTimeout(timeoutMs: unknown): number {
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new InvalidInputError({ issues: ['options.timeoutMs (out_of_range)'] });
  }
  return timeoutMs;
}

/**
 * The request for a relayer. Only a plain transaction is accepted, since
 * the relayer adds the fee bump, and it must carry no memo if it calls a
 * contract. Throws MemoOnContractCallError or InvalidInputError.
 */
export function relayerRequest(envelopeXdr: string, network: StellarNetworkId): RelayerRequest {
  const checked = checkNetwork(network);
  const envelope = readTransactionEnvelope(envelopeXdr);
  if (envelope.switch().name !== 'envelopeTypeTx') {
    throw new InvalidInputError({ issues: ['xdr (wrong_envelope_type)'] });
  }
  assertNoMemoOnContractCall(envelopeXdr, checked);
  return Object.freeze({ network: checked, xdr: envelopeXdr });
}

/**
 * Sends a signed envelope, exactly as given, after the memo check. A memo
 * on a contract call throws MemoOnContractCallError and nothing is sent.
 * An adapter error from the transport is passed on as it is. No answer by
 * the deadline is RpcTimeoutError, and any other failure is
 * SubmissionUnknownError, both landed unknown, because a send that failed
 * on the way back may still have gone through.
 */
export async function submitEnvelope<T>(
  transport: EnvelopeTransport<T>,
  envelopeXdr: string,
  options: SubmitOptions,
): Promise<T> {
  const network = checkNetwork(options.network);
  const timeoutMs = checkTimeout(options.timeoutMs);
  assertNoMemoOnContractCall(envelopeXdr, network);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RpcTimeoutError({ network }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([transport.send(envelopeXdr, controller.signal), deadline]);
  } catch (err) {
    if (isChainAdapterError(err)) throw err;
    throw new SubmissionUnknownError({ network, cause: err });
  } finally {
    clearTimeout(timer);
  }
}
