// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which KMS key serves which ref, read from the pinned keyRef objects in
// configuration. A key pinned under any other provider is not this backend's
// to use, so it resolves to nothing and the signature is refused.

import { NETWORK_IDS, pinnedKeys } from '@ujira/chain-adapter';
import type { NetworksConfig, SignerRef } from '@ujira/chain-adapter';

import { keyLabel } from '../keys.js';

import { AWS_KMS_PROVIDER } from './signer.js';
import type { KmsKeyResolver } from './signer.js';

export interface ExtraKmsKey {
  /** A key configuration does not pin, such as the attester's. */
  readonly ref: SignerRef;
  readonly keyId: string;
}

/**
 * A resolver over every key the config pins for this provider, plus `extra`.
 * Managed agent keys live in the database and are added by the service that
 * reads them, through `fallback`.
 */
export function configKeyResolver(
  config: NetworksConfig,
  extra: readonly ExtraKmsKey[] = [],
  fallback: KmsKeyResolver = () => Promise.resolve(null),
): KmsKeyResolver {
  const keys = new Map<string, string>();
  for (const network of NETWORK_IDS) {
    const section = config[network];
    if (section === undefined) continue;
    for (const { ref, key } of pinnedKeys(network, section)) {
      if (key.provider === AWS_KMS_PROVIDER) keys.set(keyLabel(ref), key.keyId);
    }
  }
  for (const { ref, keyId } of extra) keys.set(keyLabel(ref), keyId);
  return (ref, opts) => {
    const keyId = keys.get(keyLabel(ref));
    return keyId === undefined ? fallback(ref, opts) : Promise.resolve(keyId);
  };
}
