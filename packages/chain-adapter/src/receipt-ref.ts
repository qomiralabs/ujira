// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { InvalidInputError } from './errors.js';
import { isNetworkId, isStellarNetwork } from './networks.js';
import type { NetworkId } from './networks.js';
import type { ReceiptRef } from './types.js';

export interface ReceiptRefParts {
  readonly network: NetworkId;
  readonly txHash: string;
  readonly eventIndex: number;
}

const PREFIX = 'ujira:tx:v1:';
// The longest valid reference is the prefix, eip155:11142220, a 66
// character hash and a ten digit index, joined by colons: 106 characters.
// Anything much longer is refused before it is split.
const MAX_LENGTH = 128;
const U32_MAX = 4_294_967_295;
const STELLAR_HASH = /^[0-9a-f]{64}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;
const EVENT_INDEX = /^(?:0|[1-9][0-9]{0,9})$/;

// Messages never repeat the input: a reference may arrive from anyone
// verifying a receipt, and logs are no place for whatever they sent.
function invalid(what: string): InvalidInputError {
  return new InvalidInputError(`Invalid receipt reference: ${what}`);
}

function checkParts(network: unknown, txHash: unknown, eventIndex: unknown): ReceiptRefParts {
  if (!isNetworkId(network)) throw invalid('unknown network');
  const hashFormat = isStellarNetwork(network) ? STELLAR_HASH : EVM_HASH;
  if (typeof txHash !== 'string' || !hashFormat.test(txHash)) throw invalid('transaction hash');
  if (
    typeof eventIndex !== 'number' ||
    !Number.isSafeInteger(eventIndex) ||
    eventIndex < 0 ||
    eventIndex > U32_MAX
  ) {
    throw invalid('event index');
  }
  return { network, txHash, eventIndex };
}

/** Builds ujira:tx:v1:{caip2}:{txHash}:{eventIndex}, checking every part. */
export function formatReceiptRef(parts: ReceiptRefParts): ReceiptRef {
  const { network, txHash, eventIndex } = checkParts(parts.network, parts.txHash, parts.eventIndex);
  return `${PREFIX}${network}:${txHash}:${String(eventIndex)}` as ReceiptRef;
}

/** Reads a reference back into its parts. Throws InvalidInputError for anything malformed. */
export function parseReceiptRef(text: string): ReceiptRefParts {
  if (typeof text !== 'string') throw invalid('not a string');
  if (text.length > MAX_LENGTH) throw invalid('too long');
  if (!text.startsWith(PREFIX)) throw invalid('prefix or version');
  // The network ID holds a colon itself, so the hash and index are taken
  // from the right and whatever is left is the network.
  const rest = text.slice(PREFIX.length);
  const indexAt = rest.lastIndexOf(':');
  const hashAt = indexAt <= 0 ? -1 : rest.lastIndexOf(':', indexAt - 1);
  if (hashAt <= 0) throw invalid('shape');
  const indexText = rest.slice(indexAt + 1);
  if (!EVENT_INDEX.test(indexText)) throw invalid('event index');
  return checkParts(rest.slice(0, hashAt), rest.slice(hashAt + 1, indexAt), Number(indexText));
}
