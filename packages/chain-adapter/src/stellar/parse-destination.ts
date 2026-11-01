// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandate binds a destination as an address and an optional tag, and on
// Stellar an M address carries its tag inside it. Every form a recipient may
// give (G, G with a memo id, M, C) is read here into that one pair, so two
// spellings of the same destination compare equal on the allowlist, in an
// attestation and in the database.

import {
  KEY_BYTES,
  MUXED_BYTES,
  STRKEY_VERSION,
  encodeAccountAddress,
  readStrkey,
  splitMuxed,
} from '../codecs/strkey.js';
import { InvalidInputError, UnsupportedMemoDestinationError } from '../errors.js';
import type { DestinationParseReason } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type { Destination, RawDestination } from '../types.js';

interface AddressForm {
  readonly kind: 'account' | 'contract' | 'muxed';
  readonly version: number;
  readonly payloadBytes: number;
}

// The first character names the kind, so a seed or any other strkey is
// refused before it is decoded.
const FORMS: ReadonlyMap<string, AddressForm> = new Map<string, AddressForm>([
  ['G', { kind: 'account', version: STRKEY_VERSION.account, payloadBytes: KEY_BYTES }],
  ['C', { kind: 'contract', version: STRKEY_VERSION.contract, payloadBytes: KEY_BYTES }],
  ['M', { kind: 'muxed', version: STRKEY_VERSION.muxed, payloadBytes: MUXED_BYTES }],
]);

// A memo id is a u64 in decimal. A leading zero would not survive the trip
// to an id, so digits with one are a text memo that only looks numeric.
const MEMO_ID = /^(?:0|[1-9][0-9]*)$/;
// Twenty digits hold every u64, so a longer run is out of range before it is
// converted.
const MAX_MEMO_ID_DIGITS = 20;
const U64_MAX = (1n << 64n) - 1n;

const ADDRESS = 'destination.address';
const MEMO = 'destination.memoId';

// Issues name the field and the reason, never the value: a destination is
// personal data, and a seed pasted into the address field by mistake must
// not reach a log.
function refused(
  network: StellarNetworkId,
  reason: DestinationParseReason,
  path: string,
): InvalidInputError {
  return new InvalidInputError({ network, reason, issues: [`${path} (${reason.toLowerCase()})`] });
}

// Own data fields of a plain object only, so a getter or a prototype cannot
// supply a part.
function ownField(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function readTag(network: StellarNetworkId, memoId: unknown): bigint | null {
  if (memoId === undefined) return null;
  if (typeof memoId !== 'string') throw refused(network, 'MALFORMED', MEMO);
  // A contract cannot attach a transaction memo to a transfer, so a
  // destination that needs a text or hash memo can never be paid.
  if (!MEMO_ID.test(memoId)) throw new UnsupportedMemoDestinationError({ network, path: MEMO });
  const id = memoId.length > MAX_MEMO_ID_DIGITS ? undefined : BigInt(memoId);
  if (id === undefined || id > U64_MAX) throw refused(network, 'TAG_OUT_OF_RANGE', MEMO);
  return id;
}

/**
 * Reads a destination into the address and tag pair the mandate binds. The
 * address comes back as the base G or the C, never an M, so it is the
 * account a receivability check reads. Throws InvalidInputError with a
 * DestinationParseReason; never WRONG_NETWORK, since Stellar addresses name
 * no network.
 */
export function parseStellarDestination(
  network: StellarNetworkId,
  raw: RawDestination,
): Destination {
  const input: unknown = raw;
  const proto: unknown =
    typeof input === 'object' && input !== null ? Object.getPrototypeOf(input) : undefined;
  if (
    typeof input !== 'object' ||
    input === null ||
    (proto !== Object.prototype && proto !== null)
  ) {
    throw refused(network, 'MALFORMED', 'destination');
  }
  const address = ownField(input, 'address');
  if (typeof address !== 'string') throw refused(network, 'MALFORMED', ADDRESS);
  const form = FORMS.get(address.charAt(0));
  if (form === undefined) throw refused(network, 'MALFORMED', ADDRESS);
  const payload = readStrkey(address, form.version, form.payloadBytes);
  if (payload === 'checksum') throw refused(network, 'CHECKSUM', ADDRESS);
  if (payload === 'malformed') throw refused(network, 'MALFORMED', ADDRESS);
  // The all zero key is a valid strkey that nobody can sign for, so anything
  // sent there is gone for good. It is also what an unset buffer encodes to.
  if (payload.subarray(0, KEY_BYTES).every((byte) => byte === 0)) {
    throw refused(network, 'ZERO_ADDRESS', ADDRESS);
  }
  const memoId = ownField(input, 'memoId');
  if (form.kind === 'account') {
    return { address: { network, value: address }, tag: readTag(network, memoId) };
  }
  // A transfer takes a muxed id only with an account, never a contract, and
  // an M address already carries its own: a second could only repeat it or
  // contradict it.
  if (memoId !== undefined) throw refused(network, 'TAG_NOT_SUPPORTED', MEMO);
  if (form.kind === 'contract') return { address: { network, value: address }, tag: null };
  const { publicKey, id } = splitMuxed(payload);
  return { address: { network, value: encodeAccountAddress(publicKey) }, tag: id };
}
