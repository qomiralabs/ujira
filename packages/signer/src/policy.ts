// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The policy every backend applies before a key is used: which kind of key
// may sign which kind of payload, and that the payload is one this key is
// meant to sign. The bytes signed are always computed here from the decoded
// payload, never taken from the caller, so what is signed is what was
// checked. A key manager behind the port only ever sees these bytes.

import { InvalidInputError, SignerDeniedError } from '@ujira/chain-adapter';
import type { SignPayload, SignerRef } from '@ujira/chain-adapter';
import {
  attestationMessage,
  decodeAuthEntry,
  decodeFeeBumpEnvelope,
  decodeTransactionEnvelope,
} from '@ujira/chain-adapter/codecs';

import { refuseUnpayable } from './unpayable.js';

type RefKind = SignerRef['kind'];

// One key, one job. The fee sponsor pays fees and nothing else, so it can
// never be the source of a payment; the attester signs attestations only,
// which share no layout with a transaction hash.
const ALLOWED: Readonly<Record<SignPayload['kind'], ReadonlySet<RefKind>>> = Object.freeze({
  stellar_tx: new Set<RefKind>(['executor', 'managed_agent']),
  // Named kinds of their own, so that stellar_tx can stay what it says: an executor
  // key signing a stellar_tx is always an execute, and nothing else.
  stellar_relayed_call: new Set<RefKind>(['executor']),
  stellar_footprint: new Set<RefKind>(['executor']),
  stellar_fee_bump: new Set<RefKind>(['fee_sponsor']),
  stellar_reserve_sandwich: new Set<RefKind>(['fee_sponsor']),
  stellar_auth_entry: new Set<RefKind>(['executor', 'managed_agent']),
  sep10_challenge: new Set<RefKind>(['sep10']),
  attestation: new Set<RefKind>(['attester']),
});

function deny(ref: SignerRef, cause?: unknown): SignerDeniedError {
  return new SignerDeniedError(
    cause === undefined ? { network: ref.network } : { network: ref.network, cause },
  );
}

/** The decoded payload, with a codec refusal turned into a denial. */
function decoded<T>(ref: SignerRef, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof InvalidInputError) throw deny(ref, error);
    throw error;
  }
}

/**
 * The bytes `ref`'s key signs for `payload`, or SignerDeniedError when the
 * ref may not sign this kind of payload or the payload is not this key's to
 * sign, or DestinationInvalidError for an attestation to an address that can
 * never pay out. `account` is the G address the ref's key controls.
 */
export function messageFor(ref: SignerRef, payload: SignPayload, account: string): Uint8Array {
  if (payload.network !== ref.network || !ALLOWED[payload.kind].has(ref.kind)) throw deny(ref);
  switch (payload.kind) {
    // The sandwich is the sponsor's own transaction; its structure is the
    // chain service's policy to check.
    case 'stellar_tx':
    case 'stellar_relayed_call':
    case 'stellar_footprint':
    case 'stellar_reserve_sandwich': {
      const tx = decoded(ref, () => decodeTransactionEnvelope(payload.xdr, payload.network));
      if (tx.source.account !== account) throw deny(ref);
      return tx.hash;
    }
    case 'stellar_fee_bump': {
      const bump = decoded(ref, () => decodeFeeBumpEnvelope(payload.xdr, payload.network));
      if (bump.feeSource.account !== account) throw deny(ref);
      return bump.hash;
    }
    case 'stellar_auth_entry': {
      const entry = decoded(ref, () =>
        decodeAuthEntry(payload.entryXdr, payload.network, payload.expirationLedger),
      );
      // Source account credentials have no hash: the transaction covers them.
      if (
        entry.hash === null ||
        entry.credentials.kind !== 'address' ||
        entry.credentials.address !== account
      ) {
        throw deny(ref);
      }
      return entry.hash;
    }
    case 'sep10_challenge': {
      // A challenge is the anchor's transaction at sequence 0, which can
      // never be applied, holding only manage data operations, the first of
      // them from the account logging in.
      const tx = decoded(ref, () => decodeTransactionEnvelope(payload.xdr, payload.network));
      const [first] = tx.operations;
      if (
        tx.sequence !== 0n ||
        tx.source.account === account ||
        first?.source?.account !== account ||
        !tx.operations.every((op) => op.type === 'manageData')
      ) {
        throw deny(ref);
      }
      return tx.hash;
    }
    case 'attestation': {
      if (payload.fields.mandate.network !== payload.network) throw deny(ref);
      // Ahead of the layout, which refuses an M address outright: an unpayable
      // one should read as unpayable, not as malformed.
      refuseUnpayable(payload.fields);
      return decoded(ref, () => attestationMessage(payload.fields));
    }
  }
}
