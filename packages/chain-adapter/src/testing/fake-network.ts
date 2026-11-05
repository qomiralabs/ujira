// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One fake network: the in-memory ledger with its token, factory and
// mandates, plus what a real network adds around them. Every transaction
// closes a ledger and is kept by hash with its events, so the adapter can
// reconcile by hash after a timeout or a crash. Ledgers can be dropped in a
// reorganization up to the finality depth, and time moves only when a test
// moves it, so a run is the same every time.
//
// Several adapter instances can share one network, which is how a test
// restarts the adapter after a simulated crash: the chain and the store
// survive, the process does not.

import { parseNetworksConfig } from '../config.js';
import type { NetworksConfig, StellarNetworkConfig } from '../config.js';
import { InvalidInputError } from '../errors.js';
import { tenantRefOf, tenantTagOf } from '../tenant-ref.js';
import type { NetworkId } from '../networks.js';
import type { SignerRef } from '../signer.js';
import type {
  Destination,
  SigningRequest,
  SubmissionOp,
  TenantScope,
  UnixSeconds,
} from '../types.js';

import { TRUSTLINE_AUTHORIZED } from '../stellar/account-rules.js';
import type { StellarAccountEntry, StellarTrustlineEntry } from '../stellar/account-rules.js';
import type {
  StellarLedgerEntry,
  StellarLedgerKey,
  StellarLedgerReader,
} from '../stellar/check-destination.js';

import { accountFromSeed, addressXdr, contractAddress } from './address.js';
import { hexOf, sha256, utf8 } from './bytes.js';
import { MandateEngine } from './engine.js';
import type { EngineConfig } from './types.js';
import { MandateFactory } from './factory.js';
import { TokenFailure } from './failures.js';
import { FakeFaults } from './faults.js';
import { FakeLedger, TESTNET_PASSPHRASE } from './ledger.js';
import { FakeToken } from './token.js';
import type { EngineEvent, TokenEvent } from './types.js';

export const PUBNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/** 2026-01-01T00:00:00Z, the default start of every fake network. */
export const FAKE_GENESIS = 1_767_225_600n;

/** The fee every fake transaction pays, in stroops. */
export const FAKE_TX_FEE = 100n;

export interface FakeNetworkOptions {
  readonly network?: NetworkId;
  readonly now?: bigint;
  /** Seeds the fault plan. */
  readonly seed?: number;
  /** Ledgers a transaction must be buried under before it is final; 0 means at inclusion. */
  readonly finalityDepth?: number;
  /** Executor channel accounts in the pool. */
  readonly executors?: number;
}

export interface TestAccount {
  readonly address: string;
  readonly seed: Uint8Array;
}

/** A transaction the network has seen, success or failure. */
export interface FakeTx {
  readonly hash: string;
  readonly ledger: bigint;
  readonly closedAt: bigint;
  readonly op: SubmissionOp;
  readonly source: string;
  readonly ok: boolean;
  /** What the call threw when it failed. */
  readonly error: unknown;
  readonly result: unknown;
  readonly events: readonly EngineEvent[];
  readonly tokenEvents: readonly TokenEvent[];
}

export interface FakeDeposit {
  readonly txHash: string;
  readonly eventIndex: number;
  readonly token: string;
  readonly from: string | null;
  readonly to: string;
  readonly amount: bigint;
  readonly ledger: bigint;
  readonly closedAt: bigint;
  /** Position in the order deposits were dropped by reorganizations, or null while it stands. */
  droppedAs: number | null;
}

/** What the adapter keeps of a signing request until the signed payload comes back. */
export interface StoredRequest {
  readonly request: SigningRequest;
  readonly scope: TenantScope;
  readonly signer: SignerRef;
  readonly op: SubmissionOp;
  readonly mandate: string | null;
  readonly payoutId: string | null;
  readonly attempt: number | null;
  readonly sequenceOrNonce: bigint;
  readonly validUntil: UnixSeconds;
  readonly reservationId: string | null;
  /** Runs the call on the chain as `caller`. */
  readonly run: (caller: string) => unknown;
  /** The signed payload accepted for it, and its transaction, once submitted. */
  submittedAs: string | null;
  txHash: string | null;
}

interface ClosedLedger {
  readonly seq: bigint;
  readonly closedAt: bigint;
  readonly restore: (() => void) | null;
}

/**
 * The tag a mandate at this address stores for a tenant. The real adapter
 * writes and checks the same value, so a fake mandate and a real one agree
 * on whose it is.
 */
export function mandateTenantTag(scope: TenantScope, mandate: string): string {
  return tenantTagOf(tenantRefOf(scope), addressXdr(mandate));
}

function checkDepth(field: string, n: number, max: number): number {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) {
    throw new InvalidInputError({ issues: [`${field} (invalid)`] });
  }
  return n;
}

export class FakeNetwork {
  readonly network: NetworkId;
  readonly ledger: FakeLedger;
  readonly token: FakeToken;
  readonly otherToken: FakeToken;
  readonly factory: MandateFactory;
  readonly feeAddress: string;
  readonly issuer: string;
  readonly faults: FakeFaults;
  readonly finalityDepth: number;
  readonly config: NetworksConfig;
  /** This network's own section of the config. */
  readonly networkConfig: StellarNetworkConfig;
  readonly executors: readonly (TestAccount & { readonly keyId: string })[];
  readonly feeSponsor: TestAccount;
  /** Signing requests by ID, standing in for the signing requests table. */
  readonly requests = new Map<string, StoredRequest>();
  readonly #accounts = new Map<string, TestAccount>();
  readonly #ledgerAccounts = new Map<string, StellarAccountEntry | null>();
  readonly #ledgerTrustlines = new Map<string, StellarTrustlineEntry | null>();

  /**
   * The read a real network answers with one getLedgerEntries call. Every
   * address has an account and an authorized trustline until a test says
   * otherwise, so a test states only the case it is about.
   */
  readonly ledgerReader: StellarLedgerReader = {
    getLedgerEntries: (_network, keys) =>
      Promise.resolve(keys.map((key) => this.#ledgerEntry(key))),
  };
  readonly #genesis: ClosedLedger;
  readonly #ledgers: ClosedLedger[] = [];
  readonly #txs = new Map<string, FakeTx>();
  readonly #dropped = new Map<string, FakeTx>();
  readonly #deposits: FakeDeposit[] = [];
  readonly #sequences = new Map<string, bigint>();
  readonly #methods = new Map<string, Destination>();
  #drops = 0;
  #finalFloor = 1n;
  #ids = 0;

  constructor(options: FakeNetworkOptions = {}) {
    this.network = options.network ?? 'stellar:testnet';
    this.finalityDepth = checkDepth('finalityDepth', options.finalityDepth ?? 0, 64);
    this.faults = new FakeFaults(options.seed ?? 1);
    this.ledger = new FakeLedger({
      now: options.now ?? FAKE_GENESIS,
      networkPassphrase: this.network === 'stellar:pubnet' ? PUBNET_PASSPHRASE : TESTNET_PASSPHRASE,
    });
    this.issuer = this.account('issuer').address;
    this.feeAddress = this.account('fee').address;
    this.token = new FakeToken(this.ledger, {
      address: this.contract('usdc'),
      onTransfer: (t) => {
        if (this.faults.refuses(t.to.address)) throw new TokenFailure(t.token, 'not_authorized');
      },
    });
    this.otherToken = new FakeToken(this.ledger, {
      address: this.contract('other'),
      kind: 'contract',
    });
    this.factory = new MandateFactory(this.ledger, {
      address: this.contract('factory'),
      feeAddress: this.feeAddress,
      assets: [this.token.address],
    });
    const count = checkDepth('executors', options.executors ?? 2, 16);
    this.executors = Array.from({ length: count }, (_, i) => ({
      ...this.account(`executor-${String(i + 1)}`),
      keyId: `executor-${String(i + 1)}`,
    }));
    this.feeSponsor = this.account('fee-sponsor');
    const config = parseNetworksConfig({ [this.network]: this.#configSection() });
    this.config = config;
    const own = config[this.network];
    // Parsing the section it was given always yields it back.
    if (own === undefined) throw new InvalidInputError({ issues: ['config (missing)'] });
    this.networkConfig = own;
    this.#genesis = { seq: 1n, closedAt: this.ledger.now, restore: null };
    this.#ledgers.push(this.#genesis);
  }

  /** Sets what the ledger holds for an account. Null makes it absent. */
  setLedgerAccount(address: string, entry: StellarAccountEntry | null): void {
    this.#ledgerAccounts.set(address, entry);
  }

  /** Sets what the ledger holds for an account's trustline. Null makes it absent. */
  setLedgerTrustline(address: string, entry: StellarTrustlineEntry | null): void {
    this.#ledgerTrustlines.set(address, entry);
  }

  /** What an activation leaves behind: the account and the trustline, back to the defaults. */
  activateRecipient(address: string): void {
    this.#ledgerAccounts.delete(address);
    this.#ledgerTrustlines.delete(address);
  }

  #ledgerEntry(key: StellarLedgerKey): StellarLedgerEntry | null {
    if (key.kind === 'account') {
      const set = this.#ledgerAccounts.get(key.accountId);
      if (set === null) return null;
      return {
        kind: 'account',
        ...(set ?? {
          accountId: key.accountId,
          masterWeight: 1,
          thresholds: { low: 0, medium: 0, high: 0 },
          signers: [],
        }),
      };
    }
    const set = this.#ledgerTrustlines.get(key.accountId);
    if (set === null) return null;
    return {
      kind: 'trustline',
      ...(set ?? {
        accountId: key.accountId,
        asset: key.asset,
        balance: this.token.balance(key.accountId),
        limit: 2n ** 63n - 1n,
        buyingLiabilities: 0n,
        flags: TRUSTLINE_AUTHORIZED,
      }),
    };
  }

  /** A deterministic test account for `name` on this network. */
  account(name: string): TestAccount {
    const found = this.#accounts.get(name);
    if (found !== undefined) return found;
    const seed = sha256(utf8(`fake:${this.network}:${name}`));
    const made = { address: accountFromSeed(seed), seed };
    this.#accounts.set(name, made);
    return made;
  }

  contract(name: string): string {
    return contractAddress(sha256(utf8(`fake-contract:${this.network}:${name}`)));
  }

  nextId(prefix: string): string {
    this.#ids += 1;
    return `${prefix}-${String(this.#ids)}`;
  }

  now(): UnixSeconds {
    return this.ledger.now as UnixSeconds;
  }

  get head(): bigint {
    return this.#top().seq;
  }

  /** The highest ledger that can no longer be reorganized away. */
  get finalHead(): bigint {
    const final = this.head - BigInt(this.finalityDepth);
    // A ledger that was final stays final, even after the head moves back.
    return final > this.#finalFloor ? final : this.#finalFloor;
  }

  /** How many ledgers a reorganization can still drop. */
  get reorgableDepth(): number {
    return Number(this.head - this.finalHead);
  }

  /** The close time of the final head, which is what a deadline is proved against. */
  get finalTime(): bigint {
    return this.#ledgers.find((l) => l.seq === this.finalHead)?.closedAt ?? this.ledger.now;
  }

  isFinal(ledger: bigint): boolean {
    return ledger <= this.finalHead;
  }

  /** The newest ledger an RPC trailing by the lag fault can see. */
  get visibleHead(): bigint {
    const lag = BigInt(this.faults.lagSeconds);
    if (lag === 0n) return this.head;
    const cutoff = this.ledger.now - lag;
    const seen = this.#ledgers.filter((l) => l.closedAt <= cutoff);
    return seen.at(-1)?.seq ?? 0n;
  }

  /** Moves time forward and closes one empty ledger at the new time. */
  advance(seconds: bigint): void {
    this.ledger.advance(seconds);
    this.#close();
  }

  /**
   * The factory's code deployed directly, as anyone can, with the factory, its
   * fee address and a supported asset in its storage. It emits what a mandate
   * emits, and the factory says nothing about it.
   */
  deployDirect(address: string, config: EngineConfig): MandateEngine {
    return this.ledger.invoke(this.contract('direct-deployer'), 'call', () => {
      return new MandateEngine(this.ledger, {
        address,
        factory: this.factory.address,
        feeAddress: this.feeAddress,
        config,
      });
    });
  }

  mandate(address: string): MandateEngine | undefined {
    const found = this.ledger.contract(address);
    return found instanceof MandateEngine ? found : undefined;
  }

  /** The next sequence number of a source account, consumed. */
  nextSequence(address: string): bigint {
    const next = (this.#sequences.get(address) ?? 0n) + 1n;
    this.#sequences.set(address, next);
    return next;
  }

  /** A recipient method's destination, standing in for the recipient lookup. */
  registerRecipientMethod(id: string, destination: Destination): void {
    this.#methods.set(id, destination);
  }

  recipientMethod(id: string): Destination | undefined {
    return this.#methods.get(id);
  }

  /** Runs `run` and puts every contract back, as a simulation does. */
  simulate<T>(run: () => T): T {
    const restore = this.ledger.snapshot();
    try {
      return run();
    } finally {
      restore();
    }
  }

  /**
   * Includes a transaction in a new ledger. A call that throws is included
   * as failed, with nothing changed, as a failed transaction is on chain.
   */
  include(hash: string, op: SubmissionOp, source: string, run: () => unknown): FakeTx {
    if (this.#txs.has(hash)) throw new InvalidInputError({ issues: ['tx.hash (duplicate)'] });
    const seq = this.#close();
    const events = this.ledger.events.length;
    const tokenEvents = this.ledger.tokenEvents.length;
    let ok = true;
    let result: unknown = null;
    let error: unknown = null;
    try {
      result = run();
    } catch (thrown) {
      ok = false;
      error = thrown;
    }
    const tx: FakeTx = Object.freeze({
      hash,
      ledger: seq,
      closedAt: this.ledger.now,
      op,
      source,
      ok,
      error,
      result,
      events: this.ledger.events.slice(events),
      tokenEvents: this.ledger.tokenEvents.slice(tokenEvents),
    });
    this.#txs.set(hash, tx);
    tx.tokenEvents.forEach((e, eventIndex) => {
      if (e.to === null) return;
      this.#deposits.push({
        txHash: hash,
        eventIndex,
        token: e.token,
        from: e.from,
        to: e.to.address,
        amount: e.amount,
        ledger: seq,
        closedAt: tx.closedAt,
        droppedAs: null,
      });
    });
    return tx;
  }

  tx(hash: string): FakeTx | undefined {
    return this.#txs.get(hash);
  }

  /** A transaction that landed and was then reorganized away. */
  droppedTx(hash: string): FakeTx | undefined {
    return this.#dropped.get(hash);
  }

  /** Every standing transaction, oldest first. */
  get txs(): readonly FakeTx[] {
    return [...this.#txs.values()];
  }

  get deposits(): readonly FakeDeposit[] {
    return this.#deposits;
  }

  /** Mints `amount` of the settlement asset to `to` in a transaction of its own. */
  fund(to: string, amount: bigint): FakeTx {
    return this.include(this.#hash(`mint:${this.nextId('mint')}`), 'fund', this.issuer, () => {
      this.token.mint(to, amount);
    });
  }

  /** The newest standing transaction whose mandate events name `payoutId`. */
  lastTouch(payoutId: string): FakeTx | undefined {
    return this.txs.findLast((tx) => tx.ok && tx.events.some((e) => touches(e, payoutId)));
  }

  /** The transaction that executed `payoutId`, with the event's index in it. */
  execution(payoutId: string): { readonly tx: FakeTx; readonly eventIndex: number } | undefined {
    for (const tx of this.txs) {
      const eventIndex = tx.events.findIndex(
        (e) => e.name === 'payout_executed' && e.fields['payout_id'] === payoutId,
      );
      if (tx.ok && eventIndex >= 0) return { tx, eventIndex };
    }
    return undefined;
  }

  /** Whether an execution of `payoutId` was reorganized away. */
  executionDropped(payoutId: string): boolean {
    return [...this.#dropped.values()].some((tx) =>
      tx.events.some((e) => e.name === 'payout_executed' && e.fields['payout_id'] === payoutId),
    );
  }

  /**
   * Drops the newest `depth` ledgers and every transaction in them. Only
   * ledgers that are not final can go.
   */
  reorg(depth: number): void {
    checkDepth('depth', depth, this.reorgableDepth);
    if (depth === 0) return;
    const keep = this.#ledgers.length - depth;
    // The depth check keeps the final head, so the ledger at keep exists.
    const lowest = this.#ledgers[keep] ?? this.#genesis;
    lowest.restore?.();
    this.#ledgers.length = keep;
    for (const [hash, tx] of this.#txs) {
      if (tx.ledger >= lowest.seq) {
        this.#txs.delete(hash);
        this.#dropped.set(hash, tx);
      }
    }
    for (const d of this.#deposits) {
      if (d.ledger >= lowest.seq && d.droppedAs === null) {
        d.droppedAs = this.#drops;
        this.#drops += 1;
      }
    }
    this.faults.note(`reorg ${String(depth)}`);
  }

  #close(): bigint {
    const seq = this.head + 1n;
    // Only a ledger that can still be dropped needs its state saved.
    const restore = this.finalityDepth > 0 ? this.ledger.snapshot() : null;
    this.#ledgers.push({ seq, closedAt: this.ledger.now, restore });
    const final = seq - BigInt(this.finalityDepth);
    if (final > this.#finalFloor) this.#finalFloor = final;
    const keep = this.finalityDepth + 2;
    // Saved state below the deepest possible reorganization is never used again.
    const stale = this.#ledgers.length - keep;
    const old = stale > 0 ? this.#ledgers[stale - 1] : undefined;
    if (old !== undefined && old.restore !== null) {
      this.#ledgers[stale - 1] = { ...old, restore: null };
    }
    return seq;
  }

  // The first ledger is never dropped, so there is always a top.
  #top(): ClosedLedger {
    return this.#ledgers.at(-1) ?? this.#genesis;
  }

  #hash(text: string): string {
    return hexOf(sha256(utf8(`${this.network}:${text}`))).slice(2);
  }

  #configSection(): Record<string, unknown> {
    const keyRef = (keyId: string, address: string) => ({ provider: 'fake', keyId, address });
    return {
      enabled: true,
      rpc: [{ url: 'secretRef:fake_rpc', weight: 1 }],
      maxEndpointLagSeconds: 30,
      explorer: { tx: 'https://stellar.expert/explorer/testnet/tx/{hash}' },
      health: {
        maxHeadLagSeconds: 30,
        degradedErrorBps: 500,
        downErrorBps: 2000,
        hysteresisChecks: 3,
      },
      trustedFactories: { '1': [this.factory.address] },
      assets: { USDC: { sac: this.token.address, issuer: this.issuer } },
      deposits: { startLedger: 0, availableAt: 'final', pageEvents: 100 },
      executor: {
        txValiditySeconds: 60,
        keys: this.executors.map((e) => keyRef(e.keyId, e.address)),
      },
      feeSponsor: {
        perPrincipalFundingAccounts: 1,
        reserveSponsorshipDailyStroops: '10000000',
        maxFeePerTxStroops: '100000',
        perPrincipalPerMinute: 60,
        perPrincipalDailyCount: 1000,
        perPrincipalDailyFeeStroops: '10000000',
        globalDailyFeeStroops: '100000000',
        lowBalanceStroops: '1000000',
        minBalanceStroops: '100000',
        key: keyRef('fee-sponsor', this.feeSponsor.address),
      },
      sep10: [],
      signingWindowSeconds: 300,
    };
  }
}

function touches(e: EngineEvent, payoutId: string): boolean {
  return e.name !== 'payout_request_rejected' && e.fields['payout_id'] === payoutId;
}
