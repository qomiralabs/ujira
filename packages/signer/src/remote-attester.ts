// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The attester service behind the attester port. The fields go over the wire
// and the service rebuilds the message from them; this side rebuilds it too
// and checks the signature against it, so the two must agree on every byte
// before a caller ever sees a signature.

import { ed25519 } from '@noble/curves/ed25519.js';
import { SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';
import type {
  AttestationFields,
  AttesterSigner,
  CallOptions,
  NetworkId,
  SignatureResult,
} from '@ujira/chain-adapter';
import { attestationMessage, decodeAccountAddress } from '@ujira/chain-adapter/codecs';
import { z } from 'zod';

import { RemoteSigner, signatureSchema } from './remote.js';

const attestResponse = z.strictObject({ signature: signatureSchema });

export class RemoteAttesterSigner extends RemoteSigner implements AttesterSigner {
  async signAttestation(fields: AttestationFields, opts: CallOptions): Promise<SignatureResult> {
    const network = fields.mandate.network;
    const parsed = attestResponse.safeParse(
      await this.call('POST', '/v1/attest', { fields }, opts, network),
    );
    if (!parsed.success) throw new SignerUnavailableError({ network });
    const result = parsed.data.signature;
    if (!ed25519.verify(result.signature, attestationMessage(fields), result.publicKey)) {
      throw new SignerDeniedError({ network });
    }
    return { kind: 'ed25519', signature: result.signature, publicKey: result.publicKey };
  }

  async publicKey(network: NetworkId, opts: CallOptions): Promise<Uint8Array> {
    const address = await this.address({ kind: 'attester', network }, opts);
    return decodeAccountAddress(address.value);
  }
}
