// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The operations schema's record of every infrastructure key: what it is
// for, where it lives and the account it must control. A signer service
// checks each key it serves against its row before it takes any work, so a
// key swapped in the key manager stops the service instead of signing for
// an account nobody recorded.

import { SignerAddressMismatchError, SignerDeniedError } from '@ujira/chain-adapter';
import type { CallOptions, NetworkId, SignerProvider, SignerRef } from '@ujira/chain-adapter';

import { LOCAL_PROVIDER } from '../startup.js';

export type SigningKeyPurpose = 'executor' | 'fee_sponsor' | 'sep10' | 'attester';

/** One active row of ops.signing_keys, as the service reads it. */
export interface SigningKeyRow {
  readonly purpose: SigningKeyPurpose;
  readonly network: NetworkId;
  /** For a sep10 key only. */
  readonly anchorId: string | null;
  /** aws_kms, gcp_kms or local. */
  readonly provider: string;
  /** The key manager's id for the key. */
  readonly keyRef: string;
  /** The G account the key must control. */
  readonly address: string;
}

export interface SigningKeyRegistry {
  /** The active rows for these purposes. */
  activeKeys(
    purposes: ReadonlySet<SigningKeyPurpose>,
    opts: CallOptions,
  ): Promise<readonly SigningKeyRow[]>;
}

export function memorySigningKeyRegistry(rows: readonly SigningKeyRow[] = []): SigningKeyRegistry {
  return {
    activeKeys: (purposes) => Promise.resolve(rows.filter((row) => purposes.has(row.purpose))),
  };
}

/** The ref a row's key is served under. */
export function refOfRow(row: SigningKeyRow): SignerRef {
  switch (row.purpose) {
    case 'executor':
      return { kind: 'executor', network: row.network, keyId: row.keyRef };
    case 'fee_sponsor':
      return { kind: 'fee_sponsor', network: row.network };
    case 'attester':
      return { kind: 'attester', network: row.network };
    case 'sep10':
      if (row.anchorId === null) throw new SignerDeniedError({ network: row.network });
      return { kind: 'sep10', network: row.network, anchorId: row.anchorId };
  }
}

export interface ServedKeysOptions {
  readonly provider: SignerProvider;
  readonly registry: SigningKeyRegistry;
  readonly purposes: ReadonlySet<SigningKeyPurpose>;
  /** The deployment environment; process.env.NODE_ENV when left out. */
  readonly nodeEnv?: string | undefined;
  readonly opts: CallOptions;
}

/**
 * Resolves when every active key the service serves controls its recorded
 * account. A local key in production is SignerDeniedError, a key that
 * controls another account is SignerAddressMismatchError, and a service
 * with no key at all for its purposes is SignerDeniedError, since it could
 * only ever refuse.
 */
export async function verifyServedKeys(options: ServedKeysOptions): Promise<number> {
  const rows = await options.registry.activeKeys(options.purposes, options.opts);
  if (rows.length === 0) throw new SignerDeniedError();
  const nodeEnv = options.nodeEnv ?? process.env['NODE_ENV'];
  for (const row of rows) {
    if (nodeEnv === 'production' && row.provider === LOCAL_PROVIDER) {
      throw new SignerDeniedError({ network: row.network });
    }
  }
  for (const row of rows) {
    const actual = await options.provider.address(refOfRow(row), options.opts);
    if (actual.network !== row.network || actual.value !== row.address) {
      throw new SignerAddressMismatchError({ network: row.network });
    }
  }
  return rows.length;
}
