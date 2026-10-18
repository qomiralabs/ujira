// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { InvalidInputError } from './errors.js';
import { isNetworkId, namespaceOf } from './networks.js';
import type { ChainNamespace, NetworkId } from './networks.js';
import type { ReceiptRef } from './types.js';

export interface ReceiptRefParts {
  readonly network: NetworkId;
  readonly txHash: string;
  readonly eventIndex: number;
}

const PREFIX = 'ujira:tx:v1:';
// The longest valid reference today is the prefix, stellar:testnet, a 64
// character hash and a ten digit index, joined by colons: 103 characters.
// The cap leaves room for a longer network or hash, and refuses anything
// much longer before it is split.
const MAX_LENGTH = 128;
const U32_MAX = 4_294_967_295;

/**
 * The transaction hash format of each chain namespace. Stellar hashes are
 * 64 lowercase hex characters. A chain added later brings its own entry.
 */
export const RECEIPT_HASH_FORMATS: Readonly<Record<ChainNamespace, RegExp>> = Object.freeze({
  stellar: /^[0-9a-f]{64}$/,
});
const EVENT_INDEX = /^(?:0|[1-9][0-9]{0,9})$/;

// Issues name the part that was wrong, never the text: a reference may
// arrive from anyone verifying a receipt, and logs are no place for
// whatever they sent.
function invalid(path: string, code: string): InvalidInputError {
  return new InvalidInputError({ issues: [`${path} (${code})`] });
}

function checkParts(network: unknown, txHash: unknown, eventIndex: unknown): ReceiptRefParts {
  if (!isNetworkId(network)) throw invalid('receiptRef.network', 'unknown');
  const hashFormat = RECEIPT_HASH_FORMATS[namespaceOf(network)];
  if (typeof txHash !== 'string' || !hashFormat.test(txHash)) {
    throw invalid('receiptRef.txHash', 'invalid_format');
  }
  if (
    typeof eventIndex !== 'number' ||
    !Number.isSafeInteger(eventIndex) ||
    eventIndex < 0 ||
    eventIndex > U32_MAX
  ) {
    throw invalid('receiptRef.eventIndex', 'invalid_format');
  }
  return { network, txHash, eventIndex };
}

// Own data fields of a plain object only, so a getter or a prototype
// cannot supply a part.
function ownField(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** Builds ujira:tx:v1:{caip2}:{txHash}:{eventIndex}, checking every part. */
export function formatReceiptRef(parts: ReceiptRefParts): ReceiptRef {
  const input: unknown = parts;
  const proto: unknown =
    typeof input === 'object' && input !== null ? Object.getPrototypeOf(input) : undefined;
  if (
    typeof input !== 'object' ||
    input === null ||
    (proto !== Object.prototype && proto !== null)
  ) {
    throw invalid('receiptRefParts', 'not_an_object');
  }
  const { network, txHash, eventIndex } = checkParts(
    ownField(input, 'network'),
    ownField(input, 'txHash'),
    ownField(input, 'eventIndex'),
  );
  return `${PREFIX}${network}:${txHash}:${String(eventIndex)}` as ReceiptRef;
}

/** Reads a reference back into its parts. Throws InvalidInputError for anything malformed. */
export function parseReceiptRef(text: string): ReceiptRefParts {
  const input: unknown = text;
  if (typeof input !== 'string') throw invalid('receiptRef', 'not_a_string');
  if (input.length > MAX_LENGTH) throw invalid('receiptRef', 'too_long');
  if (!input.startsWith(PREFIX)) throw invalid('receiptRef', 'invalid_format');
  // The network ID holds a colon itself, so the hash and index are taken
  // from the right and whatever is left is the network.
  const rest = input.slice(PREFIX.length);
  const indexAt = rest.lastIndexOf(':');
  const hashAt = indexAt <= 0 ? -1 : rest.lastIndexOf(':', indexAt - 1);
  if (hashAt <= 0) throw invalid('receiptRef', 'invalid_format');
  const indexText = rest.slice(indexAt + 1);
  if (!EVENT_INDEX.test(indexText)) throw invalid('receiptRef.eventIndex', 'invalid_format');
  return checkParts(rest.slice(0, hashAt), rest.slice(hashAt + 1, indexAt), Number(indexText));
}
