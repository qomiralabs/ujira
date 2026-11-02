// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/signer: the backends behind the chain adapter's SignerProvider and
// AttesterSigner ports. Callers hand over a typed intent and get raw ed25519
// bytes back, so no caller handles key material or a key manager's
// signature encoding, and the backend changes by configuration alone. The
// port types come from @ujira/chain-adapter; payloads are decoded only
// through its pure codecs subpath.

export { verifyAttesterStartup } from './attester-startup.js';
export type { AttesterStartupOptions } from './attester-startup.js';
export { LOCAL_SEED_VARIABLE } from './keys.js';
export { LocalAttesterSigner, LocalSigner } from './local-signer.js';
export type { LocalSignerOptions } from './local-signer.js';
export { RemoteAttesterSigner } from './remote-attester.js';
export { RemoteSigner } from './remote.js';
export type { RemoteSignerOptions } from './remote.js';
export { LOCAL_PROVIDER, verifySignerStartup } from './startup.js';
export type { SignerStartupOptions } from './startup.js';
