// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How the widget asks a recipient's wallet to sign. The integrator supplies
// it, from whatever wallet library their page already uses, so the widget
// carries no wallet code of its own. Without one, the recipient signs the
// message in their wallet themselves and pastes the signature back.

export interface SignedMessage {
  /** Base64 signature over the message, as SEP-53 defines it. */
  signature: string;
  /** The key that signed, when it is not the account's own. */
  signer?: string;
}

export interface WalletConnector {
  /** Signs a text message with the key for `address`. */
  signMessage(message: string, address: string): Promise<SignedMessage>;
  /**
   * Signs a transaction envelope with the key for `address`. Optional: free
   * activation is offered only when the page can do this.
   */
  signTransaction?(
    transaction: string,
    options: { address: string; networkPassphrase: string },
  ): Promise<string>;
}
