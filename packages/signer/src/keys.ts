// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Local keys: one ed25519 key per signer ref, derived from a single seed so
// development, tests and CI need one secret and no key manager. Every ref
// gets its own key, so an executor key can never be asked to sign as the
// fee sponsor, and a managed agent key is bound to its own tenant.

import { hkdfSync } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';
import { InvalidInputError, SignerDeniedError } from '@ujira/chain-adapter';
import type { SignerRef } from '@ujira/chain-adapter';
import { z } from 'zod';

/** The variable the local signer reads its seed from. */
export const LOCAL_SEED_VARIABLE = 'UJIRA_SIGNER_LOCAL_SEED';

// A new salt gives every local key a new value, so it only changes on purpose.
const DERIVATION_SALT = 'ujira/signer/local/v1';

const seedSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** The 32 byte seed from its 64 lower case hex characters. The value never appears in the error. */
export function parseLocalSeed(text: unknown): Uint8Array {
  const parsed = seedSchema.safeParse(text);
  if (!parsed.success) {
    throw new InvalidInputError({ issues: [`${LOCAL_SEED_VARIABLE} (invalid)`] });
  }
  return Uint8Array.from(Buffer.from(parsed.data, 'hex'));
}

/**
 * The derivation label of a ref: every field that names the key, encoded so
 * no two refs share one. An external ref has no key here to derive.
 */
export function keyLabel(ref: SignerRef): string {
  switch (ref.kind) {
    case 'executor':
      return JSON.stringify([ref.kind, ref.network, ref.keyId]);
    case 'fee_sponsor':
    case 'attester':
      return JSON.stringify([ref.kind, ref.network]);
    case 'sep10':
      return JSON.stringify([ref.kind, ref.network, ref.anchorId]);
    case 'managed_agent':
      return JSON.stringify([
        ref.kind,
        ref.network,
        ref.scope.principalId,
        ref.scope.projectId,
        ref.agentId,
      ]);
    case 'external':
      throw new SignerDeniedError({ network: ref.network });
  }
}

export interface LocalKey {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** The key for `label`, by HKDF-SHA256 over the seed. */
export function deriveKey(seed: Uint8Array, label: string): LocalKey {
  const secretKey = new Uint8Array(hkdfSync('sha256', seed, DERIVATION_SALT, label, 32));
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}
