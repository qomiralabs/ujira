// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A test token on the fake chain. A 'classic' token behaves like a Stellar
// asset contract over a classic asset: an account holds it only through a
// trustline, which the issuer can deauthorize, and the issuer can claw a
// balance back. A contract address needs no trustline. Every account starts
// with an authorized trustline, as the shared vectors assume.
//
// The token can be made to misbehave the ways the spec cares about: return
// a value from transfer, call back into a contract during a transfer, or
// fail a balance read.

import { InvalidInputError } from '../errors.js';

import { accountKeyOf, checkAddress } from './address.js';
import { TokenFailure, TransportFailure } from './failures.js';
import type { FakeLedger, LedgerContract } from './ledger.js';
import type { EngineDestination } from './types.js';

export type TrustlineState = 'authorized' | 'deauthorized' | 'none';

/** What set_receiving can make of an account's trustline. */
export type ReceivingState = 'receivable' | 'deauthorized' | 'no_trustline';

export interface TokenTransfer {
  readonly token: string;
  readonly from: string;
  readonly to: EngineDestination;
  readonly amount: bigint;
}

/**
 * Runs inside the token's transfer, before any balance moves. It may call
 * other contracts; if it throws, the transfer fails.
 */
export type TransferHook = (transfer: TokenTransfer) => void;

export interface FakeTokenOptions {
  readonly address: string;
  /** 'classic' gates accounts on trustlines; 'contract' keeps plain balances. */
  readonly kind?: 'classic' | 'contract';
  /** Return this from transfer instead of nothing, which the mandate must refuse. */
  readonly transferReturns?: unknown;
  readonly onTransfer?: TransferHook;
}

interface TokenState {
  balances: Map<string, bigint>;
  trustlines: Map<string, TrustlineState>;
  failBalanceReads: boolean;
}

export class FakeToken implements LedgerContract {
  readonly address: string;
  readonly kind: 'classic' | 'contract';
  readonly #ledger: FakeLedger;
  readonly #returns: unknown;
  #onTransfer: TransferHook | null;
  #state: TokenState = { balances: new Map(), trustlines: new Map(), failBalanceReads: false };

  constructor(ledger: FakeLedger, options: FakeTokenOptions) {
    this.address = checkAddress('token', options.address);
    this.kind = options.kind ?? 'classic';
    this.#ledger = ledger;
    this.#returns = options.transferReturns;
    this.#onTransfer = options.onTransfer ?? null;
    ledger.register(this);
  }

  checkpoint(): () => void {
    const saved = structuredClone(this.#state);
    return () => {
      this.#state = saved;
    };
  }

  /** Replaces the transfer hook, or removes it with null. */
  setTransferHook(hook: TransferHook | null): void {
    this.#onTransfer = hook;
  }

  /** While on, every balance read fails as a read the host could not make. */
  setBalanceReadFailure(on: boolean): void {
    this.#state.failBalanceReads = on;
  }

  trustline(account: string): TrustlineState {
    return this.#state.trustlines.get(account) ?? 'authorized';
  }

  balance(holder: string): bigint {
    checkAddress('holder', holder);
    return this.#ledger.invoke(this.address, 'view', () => {
      if (this.#state.failBalanceReads) {
        throw new TransportFailure('the token could not answer a balance read');
      }
      return this.#state.balances.get(holder) ?? 0n;
    });
  }

  /** Moves `amount` from `from` to the destination's address; the tag rides along. */
  transfer(from: string, to: EngineDestination, amount: bigint): unknown {
    checkAddress('from', from);
    checkAddress('to', to.address);
    return this.#ledger.invoke(this.address, 'call', () => {
      this.#onTransfer?.({ token: this.address, from, to, amount });
      this.#checkAmount(amount);
      this.#canMove(from);
      this.#canMove(to.address);
      this.#debit(from, amount);
      this.#credit(to.address, amount);
      this.#ledger.emitToken({ token: this.address, name: 'transfer', from, to, amount });
      return this.#returns;
    });
  }

  mint(to: string, amount: bigint): void {
    checkAddress('to', to);
    this.#ledger.invoke(this.address, 'call', () => {
      this.#checkAmount(amount);
      this.#canMove(to);
      this.#credit(to, amount);
      this.#ledger.emitToken({
        token: this.address,
        name: 'mint',
        from: null,
        to: { address: to, tag: null },
        amount,
      });
    });
  }

  /** The issuer takes `amount` back from `from` without its authorization. */
  clawback(from: string, amount: bigint): void {
    checkAddress('from', from);
    this.#ledger.invoke(this.address, 'call', () => {
      this.#checkAmount(amount);
      this.#debit(from, amount);
      this.#ledger.emitToken({ token: this.address, name: 'clawback', from, to: null, amount });
    });
  }

  /** Whether an account can receive the token from now on. */
  setReceiving(account: string, state: ReceivingState): void {
    if (this.kind !== 'classic' || accountKeyOf(checkAddress('account', account)) === null) {
      throw new InvalidInputError({ issues: ['account (no_trustline)'] });
    }
    if (state === 'no_trustline' && (this.#state.balances.get(account) ?? 0n) !== 0n) {
      // A trustline is only removed at a zero balance.
      throw new InvalidInputError({ issues: ['account (nonzero_balance)'] });
    }
    const next: Record<ReceivingState, TrustlineState> = {
      receivable: 'authorized',
      deauthorized: 'deauthorized',
      no_trustline: 'none',
    };
    this.#state.trustlines.set(account, next[state]);
  }

  #checkAmount(amount: bigint): void {
    if (amount < 0n) throw new TokenFailure(this.address, 'invalid_amount');
  }

  // A classic token moves an account's balance only through an authorized
  // trustline, in either direction.
  #canMove(holder: string): void {
    if (this.kind !== 'classic' || accountKeyOf(holder) === null) return;
    const line = this.trustline(holder);
    if (line === 'none') throw new TokenFailure(this.address, 'no_trustline');
    if (line === 'deauthorized') throw new TokenFailure(this.address, 'not_authorized');
  }

  #debit(holder: string, amount: bigint): void {
    const held = this.#state.balances.get(holder) ?? 0n;
    if (held < amount) throw new TokenFailure(this.address, 'insufficient_balance');
    this.#state.balances.set(holder, held - amount);
  }

  #credit(holder: string, amount: bigint): void {
    this.#state.balances.set(holder, (this.#state.balances.get(holder) ?? 0n) + amount);
  }
}
