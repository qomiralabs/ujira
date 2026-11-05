// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What an operation does, for the operations a signer's policy has to read:
// which contract and function a Soroban call invokes, and the parts of a
// sponsorship sandwich and a SEP-10 challenge. Every other operation is
// reported by type alone, which is enough for a policy to refuse it.

import type { xdr } from '@stellar/stellar-base';

import { STRKEY_VERSION, encodeStrkey } from './strkey.js';
import { bytes, scAddressText } from './xdr.js';

/** A trust line's asset. A pool share line is never one a payout needs. */
export type DecodedTrustAsset =
  | { readonly kind: 'native' }
  | { readonly kind: 'credit'; readonly code: string; readonly issuer: string }
  | { readonly kind: 'pool_share' };

export type DecodedOperationDetail =
  | {
      readonly kind: 'invoke_contract';
      /** The C address called. */
      readonly contract: string;
      readonly functionName: string;
      readonly argCount: number;
    }
  /** Contract creation or upload, which no UJIRA key signs. */
  | { readonly kind: 'host_function' }
  | { readonly kind: 'begin_sponsoring'; readonly sponsoredId: string }
  | { readonly kind: 'end_sponsoring' }
  | {
      readonly kind: 'create_account';
      readonly destination: string;
      /** Stroops. */
      readonly startingBalance: bigint;
    }
  | {
      readonly kind: 'change_trust';
      readonly asset: DecodedTrustAsset;
      /** Stroops. */
      readonly limit: bigint;
    }
  | {
      readonly kind: 'manage_data';
      readonly name: string;
      /** Null when the entry is being deleted. */
      readonly value: Uint8Array | null;
    }
  /** Any other operation; its type says what it is. */
  | { readonly kind: 'restore_footprint' }
  | { readonly kind: 'extend_footprint' }
  | { readonly kind: 'other' };

function accountIdText(id: xdr.AccountId): string {
  return encodeStrkey(STRKEY_VERSION.account, bytes(id.ed25519()));
}

// Asset codes are padded with zero bytes to four or twelve.
function assetCode(code: Uint8Array): string {
  let end = code.length;
  while (end > 0 && code[end - 1] === 0) end -= 1;
  return Buffer.from(code.subarray(0, end)).toString('latin1');
}

function trustAsset(line: xdr.ChangeTrustAsset): DecodedTrustAsset {
  switch (line.switch().name) {
    case 'assetTypeNative':
      return { kind: 'native' };
    case 'assetTypeCreditAlphanum4': {
      const asset = line.alphaNum4();
      return {
        kind: 'credit',
        code: assetCode(bytes(asset.assetCode())),
        issuer: accountIdText(asset.issuer()),
      };
    }
    case 'assetTypeCreditAlphanum12': {
      const asset = line.alphaNum12();
      return {
        kind: 'credit',
        code: assetCode(bytes(asset.assetCode())),
        issuer: accountIdText(asset.issuer()),
      };
    }
    default:
      return { kind: 'pool_share' };
  }
}

/** The parts of `op` a policy reads, by its type. */
export function operationDetail(op: xdr.Operation, field: string): DecodedOperationDetail {
  const body = op.body();
  switch (body.switch().name) {
    case 'invokeHostFunction': {
      const fn = body.invokeHostFunctionOp().hostFunction();
      if (fn.switch().name !== 'hostFunctionTypeInvokeContract') return { kind: 'host_function' };
      const call = fn.invokeContract();
      return {
        kind: 'invoke_contract',
        contract: scAddressText(call.contractAddress(), field),
        functionName: call.functionName().toString(),
        argCount: call.args().length,
      };
    }
    case 'restoreFootprint':
      return { kind: 'restore_footprint' };
    case 'extendFootprintTtl':
      return { kind: 'extend_footprint' };
    case 'beginSponsoringFutureReserves':
      return {
        kind: 'begin_sponsoring',
        sponsoredId: accountIdText(body.beginSponsoringFutureReservesOp().sponsoredId()),
      };
    case 'endSponsoringFutureReserves':
      return { kind: 'end_sponsoring' };
    case 'createAccount': {
      const create = body.createAccountOp();
      return {
        kind: 'create_account',
        destination: accountIdText(create.destination()),
        startingBalance: BigInt(create.startingBalance().toString()),
      };
    }
    case 'changeTrust': {
      const trust = body.changeTrustOp();
      return {
        kind: 'change_trust',
        asset: trustAsset(trust.line()),
        limit: BigInt(trust.limit().toString()),
      };
    }
    case 'manageData': {
      const data = body.manageDataOp();
      // An absent value reads as undefined or null depending on the path.
      const value: unknown = data.dataValue();
      return {
        kind: 'manage_data',
        name: data.dataName().toString(),
        value: value instanceof Uint8Array ? bytes(value) : null,
      };
    }
    default:
      return { kind: 'other' };
  }
}
