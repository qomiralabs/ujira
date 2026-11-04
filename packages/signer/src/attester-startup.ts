// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the attester service checks before it takes any work. The attester's
// key is not pinned in configuration, so nothing else would notice one of the
// public test keys behind it, and a service signing with one would be vouching
// for destinations with a key anyone can rebuild.

import { SignerDeniedError, isPublicTestAttesterKey } from '@ujira/chain-adapter';
import type { CallOptions, NetworkId, SignerProvider } from '@ujira/chain-adapter';
import { decodeAccountAddress } from '@ujira/chain-adapter/codecs';

export interface AttesterStartupOptions {
  readonly signer: Pick<SignerProvider, 'address'>;
  /** The networks this service attests on. */
  readonly networks: readonly NetworkId[];
  /** The deployment environment; process.env.NODE_ENV when left out. */
  readonly nodeEnv?: string | undefined;
  readonly opts: CallOptions;
}

/**
 * Resolves when the attester's key may be used; otherwise throws
 * SignerDeniedError for a public test key in anything but a test, or the
 * signer's own error, and the caller must not start. Only an explicit test
 * environment is let through, so a deployment that forgot to set one fails
 * closed.
 */
export async function verifyAttesterStartup(options: AttesterStartupOptions): Promise<void> {
  const nodeEnv = options.nodeEnv ?? process.env['NODE_ENV'];
  if (nodeEnv === 'test') return;
  for (const network of options.networks) {
    const { value } = await options.signer.address({ kind: 'attester', network }, options.opts);
    if (isPublicTestAttesterKey(decodeAccountAddress(value))) {
      throw new SignerDeniedError({ network });
    }
  }
}
