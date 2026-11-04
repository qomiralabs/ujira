// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a recipient or a provider may give as a Stellar destination, read
// into what the mandate can bind. A contract cannot attach a transaction
// memo and a muxed tag is only a 64 bit number, so only G, C and M (with a
// numeric id) can ever be paid: a text, hash or return memo is refused here,
// when the destination is captured, instead of failing at payout time. A G
// address with a numeric memo comes back as the M address that carries it.

import { decodeAccountAddress, encodeMuxedAddress } from '../codecs/strkey.js';
import { InvalidInputError, UnsupportedMemoDestinationError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type { Destination } from '../types.js';

import { parseStellarDestination } from './parse-destination.js';

/** The memo types a Stellar destination can name. Only none and id are payable. */
export const STELLAR_MEMO_TYPES = Object.freeze(['none', 'id', 'text', 'hash', 'return'] as const);

export type StellarMemoType = (typeof STELLAR_MEMO_TYPES)[number];

export interface BindableDestination {
  /** The address and tag pair the mandate binds. */
  readonly destination: Destination;
  /** The one text to store and show: G, C, or the M address that carries the tag. */
  readonly address: string;
}

const MEMO_TYPES: ReadonlySet<unknown> = new Set<unknown>(STELLAR_MEMO_TYPES);
const UNPAYABLE: ReadonlySet<unknown> = new Set<unknown>(['text', 'hash', 'return']);
const INPUT_KEYS: ReadonlySet<string> = new Set(['address', 'memoType', 'memo']);

// Where each anchor protocol says to send funds and with which memo: SEP-6
// withdraw responses, SEP-24 transaction records and SEP-31 send responses.
const INSTRUCTION_FORMS = [
  { address: 'account_id', memoType: 'memo_type', memo: 'memo' },
  { address: 'withdraw_anchor_account', memoType: 'withdraw_memo_type', memo: 'withdraw_memo' },
  { address: 'stellar_account_id', memoType: 'stellar_memo_type', memo: 'stellar_memo' },
] as const;

interface Parts {
  readonly address: unknown;
  readonly memoType: unknown;
  readonly memo: unknown;
}

interface Paths {
  readonly memoType: string;
  readonly memo: string;
}

// Issues name the field and the reason, never the value: a destination is
// personal data.
function malformed(network: StellarNetworkId, path: string): InvalidInputError {
  return new InvalidInputError({ network, reason: 'MALFORMED', issues: [`${path} (malformed)`] });
}

function isPlainRecord(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Own data fields only, so a getter or a prototype cannot supply a part.
function ownField(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function bindable(
  network: StellarNetworkId,
  address: unknown,
  memoId?: string,
): BindableDestination {
  const destination = parseStellarDestination(network, {
    address: address as string,
    ...(memoId === undefined ? {} : { memoId }),
  });
  const { tag } = destination;
  const value = destination.address.value;
  return Object.freeze({
    destination,
    address: tag === null ? value : encodeMuxedAddress(decodeAccountAddress(value), tag),
  });
}

function bind(network: StellarNetworkId, parts: Parts, paths: Paths): BindableDestination {
  const { address, memoType, memo } = parts;
  if (memoType === undefined || memoType === 'none') {
    // A memo with no type cannot be told apart from text, so it is not guessed at.
    if (memo !== undefined) throw malformed(network, paths.memo);
    return bindable(network, address);
  }
  if (!MEMO_TYPES.has(memoType)) throw malformed(network, paths.memoType);
  if (UNPAYABLE.has(memoType)) {
    throw new UnsupportedMemoDestinationError({ network, path: paths.memo });
  }
  if (typeof memo !== 'string') throw malformed(network, paths.memo);
  return bindable(network, address, memo);
}

/**
 * Reads a destination a recipient entered: an address and an optional
 * memo with its type. Throws UnsupportedMemoDestinationError for a text,
 * hash or return memo, or an id memo that is not a decimal number, and
 * InvalidInputError with a DestinationParseReason for anything else.
 */
export function readStellarBindable(
  network: StellarNetworkId,
  input: unknown,
): BindableDestination {
  if (!isPlainRecord(input)) throw malformed(network, 'destination');
  if (Object.keys(input).some((key) => !INPUT_KEYS.has(key))) {
    throw malformed(network, 'destination');
  }
  return bind(
    network,
    {
      address: ownField(input, 'address'),
      memoType: ownField(input, 'memoType'),
      memo: ownField(input, 'memo'),
    },
    { memoType: 'destination.memoType', memo: 'destination.memo' },
  );
}

/**
 * Reads where a provider says to send funds, from an anchor's SEP-6,
 * SEP-24 or SEP-31 response. Other fields of the response are ignored, but
 * it must name exactly one destination. The same rules apply as for
 * readStellarBindable: a text or hash memo is refused.
 */
export function readStellarDepositInstruction(
  network: StellarNetworkId,
  instruction: unknown,
): BindableDestination {
  if (!isPlainRecord(instruction)) throw malformed(network, 'instruction');
  const named = INSTRUCTION_FORMS.filter(
    (form) => ownField(instruction, form.address) !== undefined,
  );
  const [form, ...others] = named;
  if (form === undefined || others.length > 0) throw malformed(network, 'instruction');
  return bind(
    network,
    {
      address: ownField(instruction, form.address),
      memoType: ownField(instruction, form.memoType),
      memo: ownField(instruction, form.memo),
    },
    { memoType: `instruction.${form.memoType}`, memo: `instruction.${form.memo}` },
  );
}
