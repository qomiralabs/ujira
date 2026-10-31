// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandate factory on the fake chain. It holds the supported assets and
// the fee address, checks a configuration fully before it deploys, and puts
// each mandate at the address the principal and salt determine, so a create
// that failed can be retried with the same salt.

import { addressXdr, checkAddress, deployedAddress } from './address.js';
import { bytesOf, sha256 } from './bytes.js';
import { HostAuthFailure, TransportFailure, refusal } from './failures.js';
import * as input from './input.js';
import type { FakeLedger, LedgerContract } from './ledger.js';
import { MandateEngine } from './engine.js';
import { validateConfig } from './rules.js';
import { SPEC_VERSION } from './spec.js';
import type { EngineConfig, Invocation } from './types.js';

export interface MandateFactoryOptions {
  readonly address: string;
  /** Copied into every mandate; a principal can never choose it. */
  readonly feeAddress: string;
  /** The settlement assets the factory supports, fixed for its life. */
  readonly assets: readonly string[];
}

export class MandateFactory implements LedgerContract {
  readonly address: string;
  readonly feeAddress: string;
  readonly assets: readonly string[];
  readonly #ledger: FakeLedger;

  constructor(ledger: FakeLedger, options: MandateFactoryOptions) {
    this.address = checkAddress('factory', options.address);
    this.feeAddress = checkAddress('feeAddress', options.feeAddress);
    this.assets = Object.freeze(input.addresses('assets', options.assets));
    this.#ledger = ledger;
    ledger.register(this);
  }

  /** The factory keeps no state of its own; its mandates save themselves. */
  checkpoint(): () => void {
    return () => undefined;
  }

  /** Where a create by `principal` with `salt` puts the mandate. */
  mandateAddress(principal: string, salt: string): string {
    return deployedAddress(
      this.#ledger.networkId,
      this.address,
      sha256(
        addressXdr(checkAddress('principal', principal)),
        bytesOf(input.bytes32('salt', salt)),
      ),
    );
  }

  /** create: the caller must be the configured principal. */
  create(inv: Invocation, config: EngineConfig, salt: string): MandateEngine {
    const c = input.config(config);
    const at = this.mandateAddress(c.principal, salt);
    input.invocation(inv);
    return this.#ledger.invoke(this.address, 'call', () => {
      const signer = inv.signedBy ?? inv.caller;
      if (signer !== c.principal) throw new HostAuthFailure(c.principal, signer);
      if (!this.assets.includes(c.asset)) throw refusal('ASSET_NOT_SUPPORTED');
      // The factory finds the first error itself: on a real chain an error
      // from the constructor reaches the caller only as a generic host error.
      validateConfig(c, this.feeAddress, this.#ledger.now);
      if (this.#ledger.contract(at) !== undefined) {
        throw new TransportFailure('a contract already exists at the derived address');
      }
      this.#ledger.emit(this.address, 'mandate_created', {
        mandate: at,
        principal: c.principal,
        asset: c.asset,
        tenant_ref: c.tenantRef,
        spec_version: SPEC_VERSION,
        fee_address: this.feeAddress,
      });
      return new MandateEngine(this.#ledger, {
        address: at,
        factory: this.address,
        feeAddress: this.feeAddress,
        config: c,
      });
    });
  }
}
