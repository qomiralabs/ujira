// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The attestation parity fixture signs with two ed25519 keys whose seeds are
// the SHA-256 of public labels, so anyone can rebuild the private keys and
// sign as them. A mandate or a service set up with one would accept
// attestations from anybody, and the contract cannot tell, since it only
// checks the key's length. They sit in a vendored file, one copy and paste
// from a config, so everything that sets an attester refuses them by name.

/** Both public keys, in lower case hex. */
export const PUBLIC_TEST_ATTESTER_KEYS: readonly string[] = Object.freeze([
  '421adb50c10fe73fb1fc0d4211a16911a188bb001eaf0391b479316026141d48',
  'a51a56cfabe1fbb71d7172c52fd2bb9d715f75fb50e65b060961fb1690a59cab',
]);

/** Whether a raw 32 byte ed25519 public key is one anyone can sign for. */
export function isPublicTestAttesterKey(key: Uint8Array): boolean {
  const input: unknown = key;
  return (
    input instanceof Uint8Array &&
    PUBLIC_TEST_ATTESTER_KEYS.includes(Buffer.from(input).toString('hex'))
  );
}
