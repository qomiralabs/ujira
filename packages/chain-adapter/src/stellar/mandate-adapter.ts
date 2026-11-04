// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Mandate reads, mandate actions and signed submission on Stellar.
//
// An action is built for whoever signs it. A G account gets a transaction
// with itself as the source, which UJIRA wraps in a fee bump so the
// principal never needs XLM. A C smart wallet gets the authorization entry
// to sign, and UJIRA submits it from one of its channel accounts. Either way
// the adapter keeps its own copy of what it built and refuses a signed
// payload that differs from it in any byte other than the signature.

import { createHash, randomUUID } from 'node:crypto';

import { xdr } from '@stellar/stellar-sdk/base';
import type { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk/base';

import type { StellarNetworkConfig } from '../config.js';
import {
  InternalError,
  InvalidInputError,
  MandateUntrustedError,
  SignedPayloadMismatchError,
  SigningRequestExpiredError,
  SponsorDeniedError,
  SubmissionRejectedError,
  SubmissionUnknownError,
  UnsupportedError,
  isChainAdapterError,
} from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import { reservationIdOf } from '../sponsorship/policy.js';
import { canMoveSubmission } from '../submission-states.js';
import { tenantRefOf, tenantTagOf } from '../tenant-ref.js';
import { isPublicTestAttesterKey } from '../test-attester-keys.js';
import type {
  AdapterPorts,
  Bytes32,
  CallOptions,
  ChainAdapter,
  MandateAction,
  MandateActionRequest,
  MandateRef,
  MandateSnapshot,
  NativeAmount,
  SignedSubmission,
  SigningRequest,
  SigningSummary,
  SponsoredIntent,
  SubmissionPatch,
  SubmissionRecord,
  SubmissionRef,
  SubmissionState,
  TenantScope,
  UnixSeconds,
} from '../types.js';
import { addressXdr } from './address-xdr.js';
import { invocationOf } from './calls.js';
import { wrapInFeeBump } from './contract-call.js';
import { ExecutorSession, sendAndRecord } from './executor.js';
import type { ExecutorContext } from './executor.js';
import type {
  LoadedSigningRequest,
  SigningRequestStore,
  StoredSigningRequest,
} from './requests.js';
import { decodeFeeWrite1KB, feeWriteSettingKey } from './rent-settings.js';
import { archivedKeys, extendRestored, restoreAndExtend } from './restore.js';
import { STELLAR_LEDGER_SECONDS } from './restore-policy.js';
import { reconcileSubmission, reconcileUnresolved } from './lifecycle.js';
import type { ReconcileResult, SweepOptions } from './lifecycle.js';
import { mandateAddressOf } from './mandate-address.js';
import type { StellarRpc } from './rpc.js';
import { asAddress } from './scval.js';
import {
  PADDED_CALLS,
  createMemoryStepLog,
  padWriteBytes,
  resourceFailureOf,
  restoredKeysOf,
  ttlExtensionKey,
} from './soroban-rules.js';
import type { StepLog } from './soroban-rules.js';
import { MandateTrust } from './trust.js';
import {
  INCLUSION_FEE,
  SIMULATION_SOURCE,
  accountSequence,
  attach,
  invokeTx,
  parseEnvelope,
  readTx,
  returned,
  signedBy,
  simulate,
  simulatedData,
  txHash,
} from './tx.js';
import type { Simulated, WaitOptions } from './tx.js';
import { configViewOf, stateOf } from './views.js';

export interface StellarMandateAdapterOptions {
  readonly network: StellarNetworkId;
  /**
   * The deployment environment. Only 'test' may set a public test attester
   * key on a mandate, so left out, the keys are refused.
   */
  readonly nodeEnv?: string;
  readonly rpc: StellarRpc;
  readonly ports: AdapterPorts;
  readonly requests: SigningRequestStore;
  /** How the restore step waits for its transactions. */
  readonly wait?: WaitOptions;
  readonly executorLeaseSeconds?: number;
  /** How long a send may take before its outcome counts as unknown. */
  readonly submitTimeoutMs?: number;
  /** Overrides the network's soroban.instanceTtlExtendLedgers. */
  readonly instanceTtlExtendLedgers?: number;
  readonly newRequestId?: () => string;
  /** The mandate functions that get write padding. Defaults to PADDED_CALLS. */
  readonly paddedCalls?: ReadonlySet<string>;
  /** Where the step after a restore is remembered. Production backs this with the database. */
  readonly steps?: StepLog;
}

/**
 * How a principal-signed action turned out. Only getTransaction moves it to
 * landed: a send status or simulated events never do.
 */
export type SignedOutcome =
  | { readonly status: 'pending'; readonly txHash: string }
  | { readonly status: 'landed'; readonly txHash: string; readonly ledger: number }
  | { readonly status: 'resimulated'; readonly signingRequest: SigningRequest };

export type StellarMandateOperations = Pick<
  ChainAdapter,
  'network' | 'readMandate' | 'prepareMandateAction' | 'submitSigned'
>;

const SPEC_VERSION = 1;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;

/** How the restore step waits for each of its transactions to land. */
export const DEFAULT_WAIT: WaitOptions = {
  attempts: 30,
  intervalMs: 2_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const INTENTS: Partial<Record<StoredSigningRequest['op'], SponsoredIntent>> = {
  create: 'create_mandate',
  pause: 'pause',
  resume: 'resume',
  revoke: 'revoke',
  approve: 'approve',
  reject: 'reject',
  cancel: 'cancel',
  cancel_batch: 'cancel',
  withdraw: 'withdraw',
};

function invalid(network: StellarNetworkId, issue: string): InvalidInputError {
  return new InvalidInputError({ network, issues: [issue] });
}

function stroops(network: StellarNetworkId, amount: bigint): NativeAmount {
  return { network, asset: 'XLM', amount, scale: 7 };
}

export class StellarMandateAdapter implements StellarMandateOperations {
  readonly network: StellarNetworkId;
  readonly #rpc: StellarRpc;
  readonly #ports: AdapterPorts;
  readonly #requests: SigningRequestStore;
  readonly #trust: MandateTrust;
  readonly #executor: ExecutorContext;
  readonly #ttlExtendLedgers: number | undefined;
  readonly #newRequestId: () => string;
  readonly #paddedCalls: ReadonlySet<string>;
  readonly #steps: StepLog;
  readonly #nodeEnv: string | undefined;

  constructor(options: StellarMandateAdapterOptions) {
    this.network = options.network;
    this.#rpc = options.rpc;
    this.#ports = options.ports;
    this.#requests = options.requests;
    this.#trust = new MandateTrust(options.network, options.rpc, () => [
      ...this.#config().trustedFactories['1'],
    ]);
    this.#executor = {
      network: options.network,
      rpc: options.rpc,
      ports: options.ports,
      wait: options.wait ?? DEFAULT_WAIT,
      leaseSeconds: options.executorLeaseSeconds ?? DEFAULT_LEASE_SECONDS,
      submitTimeoutMs: options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS,
      lowBalanceAlerted: new Set(),
    };
    this.#ttlExtendLedgers = options.instanceTtlExtendLedgers;
    this.#newRequestId = options.newRequestId ?? randomUUID;
    this.#paddedCalls = options.paddedCalls ?? PADDED_CALLS;
    this.#steps = options.steps ?? createMemoryStepLog();
    this.#nodeEnv = options.nodeEnv;
  }

  #config(): StellarNetworkConfig {
    const config = this.#ports.config()[this.network];
    if (!config?.enabled) {
      throw new UnsupportedError({ network: this.network });
    }
    return config;
  }

  // -------------------------------------------------------------------------
  // Reads

  async readMandate(
    req: { readonly scope: TenantScope; readonly mandate: MandateRef },
    opts: CallOptions,
  ): Promise<MandateSnapshot> {
    const { network } = this;
    const config = this.#config();
    const instance = await this.#trust.verify(req.scope, req.mandate, opts);
    // A trusted factory may list assets UJIRA does not settle in, such as a
    // test token. Those mandates have no place in a snapshot.
    if (instance.asset !== config.assets.USDC.sac) throw new UnsupportedError({ network });
    const call = (fn: string): Promise<Simulated> =>
      simulate(
        this.#rpc,
        network,
        readTx(network, { contract: instance.address, fn, args: [] }),
        instance.address,
        opts,
      );
    const [version, configSim, stateSim, latest] = await Promise.all([
      call('version'),
      call('config'),
      call('state'),
      this.#rpc.getLatestLedger(opts),
    ]);
    const versionValue = returned(version);
    if (versionValue.type !== 'scvU32' || versionValue.u32 !== SPEC_VERSION) {
      throw new UnsupportedError({ network });
    }
    const state = stateOf(returned(stateSim));
    return {
      mandate: req.mandate,
      trustedFactory: true,
      tenantTagMatches: true,
      asset: 'USDC',
      config: configViewOf(returned(configSim), {
        network,
        factory: instance.factory,
        policyEpoch: state.policyEpoch,
      }),
      state,
      observedAt: {
        ledgerOrBlock: BigInt(Math.max(configSim.latestLedger, stateSim.latestLedger)),
        time: latest.closeTime as UnixSeconds,
        finality: 'final',
      },
    };
  }

  // -------------------------------------------------------------------------
  // Actions

  // The contract only checks the key's length, so a mandate set up with a key
  // anyone can rebuild would pay on anybody's attestation. Here is the last
  // place that can see it before the principal signs.
  #refuseTestAttester(action: MandateAction): void {
    if (this.#nodeEnv === 'test') return;
    let attester: Uint8Array | null = null;
    if (action.op === 'create') attester = action.config.attester;
    if (action.op === 'set_attestation_policy') attester = action.attester;
    if (attester !== null && isPublicTestAttesterKey(attester)) {
      throw invalid(this.network, 'attester (test_key)');
    }
  }

  prepareMandateAction(req: MandateActionRequest, opts: CallOptions): Promise<SigningRequest> {
    return this.#prepare(req, opts, 0);
  }

  async #prepare(
    req: MandateActionRequest,
    opts: CallOptions,
    resimulations: number,
  ): Promise<SigningRequest> {
    const { network } = this;
    const config = this.#config();
    const { action } = req;
    const signer = await this.#signerAddress(req, opts);
    const caller = req.caller;
    if (caller !== undefined && (caller.network !== network || caller.value !== signer)) {
      throw invalid(network, 'caller (not_signer)');
    }
    const target = await this.#targetFor(req, opts);
    const inv = invocationOf(action, {
      mandate: target.address,
      tenantTag: target.tenantTag,
      caller: signer,
      assetContract: config.assets.USDC.sac,
    });
    this.#refuseTestAttester(action);
    const now = this.#ports.clock.nowSeconds();
    const validUntil = (now + BigInt(config.signingWindowSeconds)) as UnixSeconds;
    const viaWallet = signer.startsWith('C');
    let sequence: bigint | null = null;
    if (!viaWallet) {
      sequence = await accountSequence(this.#rpc, signer, opts);
      if (sequence === null) throw invalid(network, 'signer (account_not_found)');
    }
    const build = {
      network,
      source: viaWallet ? SIMULATION_SOURCE : signer,
      sequence: sequence ?? 0n,
      maxTime: validUntil,
    };
    const tx = invokeTx(inv, build);
    let sim = await simulate(this.#rpc, network, tx, inv.contract, opts);
    const archived = archivedKeys(sim);
    if (archived.length > 0) {
      await ExecutorSession.run(this.#executor, opts, (session) =>
        restoreAndExtend(
          this.#executor,
          session,
          {
            scope: req.scope,
            target: { mandate: target.address, asset: config.assets.USDC.sac },
            keys: archived,
            instanceTtlExtendLedgers:
              this.#ttlExtendLedgers ?? config.soroban.instanceTtlExtendLedgers,
            correlationId: opts.correlationId,
          },
          opts,
        ),
      );
      sim = await simulate(this.#rpc, network, tx, inv.contract, opts);
    }
    const auth = (sim.result?.auth ?? []).map((entry) =>
      checkedEntry(network, entry, signer, viaWallet),
    );
    // The tag in this call is bound to the address worked out above. If the
    // factory would deploy anywhere else the tag would be wrong for good, so
    // nothing is handed out to sign.
    if (action.op === 'create' && asAddress(returned(sim)) !== target.address) {
      throw new InternalError({ network });
    }
    const padding = this.#paddedCalls.has(inv.fn)
      ? padWriteBytes(simulatedData(sim), {
          network,
          paddingBytes: config.soroban.writeBytesPadding,
          feeWrite1KB: await this.#feeWrite1KB(opts),
        })
      : { sorobanData: simulatedData(sim), addedFee: 0n };
    const fee = BigInt(sim.minResourceFee) + padding.addedFee + INCLUSION_FEE * 2n;
    if (fee > config.feeSponsor.maxFeePerTxStroops) throw new SponsorDeniedError({ network });
    const summary: SigningSummary = {
      action: action.op,
      ...(req.mandate === null ? {} : { mandate: req.mandate }),
      ...(action.op === 'withdraw' ? { amount: action.amount } : {}),
      feePaidBy: 'ujira',
      estimatedFee: stroops(network, fee),
    };
    const requestId = this.#newRequestId();
    const base = {
      requestId,
      scope: req.scope,
      network,
      op: action.op,
      mandate: target.address,
      payoutId: 'payoutId' in action ? action.payoutId : null,
      signer,
      fee,
      validUntil,
      summary,
      ...(resimulations === 0 ? {} : { resimulations }),
    } as const;
    const reason = resimulations === 0 ? {} : { reason: 'RESIMULATED' as const };
    const signerRef = { network, value: signer };
    if (!viaWallet) {
      const assembled = invokeTx(inv, { ...build, sorobanData: padding.sorobanData }, auth);
      await this.#requests.save({
        ...base,
        kind: 'stellar_transaction',
        payload: assembled.toXdr(),
        hostFunction: null,
        sequence: BigInt(assembled.sequence),
      });
      return {
        kind: 'stellar_transaction',
        network,
        xdr: assembled.toXdr(),
        signer: signerRef,
        validUntil,
        sponsored: true,
        summary,
        requestId,
        ...reason,
      };
    }
    const [entry] = auth;
    if (entry === undefined || auth.length !== 1) throw new SubmissionRejectedError({ network });
    const expirationLedger =
      sim.latestLedger +
      Number(
        (BigInt(config.signingWindowSeconds) + STELLAR_LEDGER_SECONDS - 1n) /
          STELLAR_LEDGER_SECONDS,
      );
    const unsigned = withSignature(entry, xdr.ScVal.scvVoid(), expirationLedger);
    await this.#requests.save({
      ...base,
      kind: 'stellar_auth_entry',
      payload: unsigned.toXdr('base64'),
      hostFunction: hostFunctionOf(tx).toXdr('base64'),
      sequence: null,
    });
    return {
      kind: 'stellar_auth_entry',
      network,
      entryXdr: unsigned.toXdr('base64'),
      signer: signerRef,
      expirationLedger,
      summary,
      requestId,
      ...reason,
    };
  }

  // The price of a ledger write, read only for a call that gets padded.
  async #feeWrite1KB(opts: CallOptions): Promise<bigint> {
    const key = feeWriteSettingKey();
    const { entries } = await this.#rpc.getLedgerEntries([key], opts);
    const [entry] = entries;
    if (entry === undefined) throw new InternalError({ network: this.network });
    return decodeFeeWrite1KB(entry.xdr);
  }

  /** Asks the chain about one recorded submission and moves its record forward. */
  reconcile(record: SubmissionRecord, opts: CallOptions): Promise<ReconcileResult> {
    return reconcileSubmission(this.#executor, record, opts);
  }

  /** Reconciles what is still open, oldest first, and alerts on what is stuck. */
  reconcileUnresolved(sweep: SweepOptions, opts: CallOptions): Promise<readonly ReconcileResult[]> {
    return reconcileUnresolved(this.#executor, sweep, opts);
  }

  async #signerAddress(req: MandateActionRequest, opts: CallOptions): Promise<string> {
    const { network } = this;
    if (req.signer.network !== network) throw invalid(network, 'signer.network (mismatch)');
    const resolved =
      req.signer.kind === 'external'
        ? req.signer.address
        : await this.#ports.signer.address(req.signer, opts);
    if (resolved.network !== network || !/^[GC]/.test(resolved.value)) {
      throw invalid(network, 'signer.address (invalid)');
    }
    return resolved.value;
  }

  /** The mandate a request acts on: verified on chain, or for create, the one it will deploy. */
  async #targetFor(
    req: MandateActionRequest,
    opts: CallOptions,
  ): Promise<{ readonly address: string; readonly tenantTag: Bytes32 }> {
    const { network } = this;
    const { action } = req;
    if (action.op !== 'create') {
      if (req.mandate === null) throw invalid(network, 'mandate (required)');
      return this.#trust.verify(req.scope, req.mandate, opts);
    }
    if (req.mandate !== null) throw invalid(network, 'mandate (not_null)');
    if (action.factory.network !== network) throw invalid(network, 'factory.network (mismatch)');
    if (!(await this.#trust.isTrustedFactory(action.factory.value, opts))) {
      throw new MandateUntrustedError({ network });
    }
    const address = mandateAddressOf(
      network,
      action.factory.value,
      action.config.principal.value,
      action.salt,
    );
    return { address, tenantTag: tenantTagOf(tenantRefOf(req.scope), addressXdr(address)) };
  }

  // -------------------------------------------------------------------------
  // Submission

  async submitSigned(req: SignedSubmission, opts: CallOptions): Promise<SubmissionRef> {
    const { network } = this;
    const loaded = await this.#requests.load(req.scope, req.requestId);
    if (loaded === null) throw invalid(network, 'requestId (not_found)');
    if (loaded.use !== null) return this.#replay(loaded.use, req.signed, opts);
    const { request } = loaded;
    if (this.#ports.clock.nowSeconds() > request.validUntil) {
      throw new SigningRequestExpiredError({ network });
    }
    const signed =
      request.kind === 'stellar_transaction'
        ? { kind: 'tx' as const, tx: this.#checkedTransaction(request, req.signed) }
        : { kind: 'entry' as const, entry: this.#checkedEntry(request, req.signed) };
    const earlier = await this.#requests.claim(req.scope, request.requestId, req.signed);
    if (earlier !== null) return this.#replay(earlier, req.signed, opts);

    // Keyed by what is paid for, which is what the signer looks up before the
    // sponsor signs. A wallet's entry has no transaction of its own yet: the
    // channel's is built at send time, so the signed entry stands in for it.
    const reservationId = reservationIdOf(
      network,
      signed.kind === 'tx'
        ? signed.tx.hash()
        : createHash('sha256').update(signed.entry.toXdr()).digest(),
    );
    await this.#ports.sponsorship.reserve({
      scope: request.scope,
      network,
      reservationId,
      intent: INTENTS[request.op] ?? 'admin',
      maxFee: stroops(network, request.fee),
    });
    try {
      const hash =
        signed.kind === 'tx'
          ? await this.#submitFeeBumped(request, signed.tx, reservationId, req.correlationId, opts)
          : await this.#submitFromChannel(
              request,
              signed.entry,
              reservationId,
              req.correlationId,
              opts,
            );
      return { network, txHash: hash, finality: 'none' };
    } catch (error) {
      // Only an outcome that certainly sent nothing gives the reservation back.
      if (isChainAdapterError(error) && error.landed === 'no') {
        await this.#ports.sponsorship.release({ scope: request.scope, reservationId });
      }
      throw error;
    }
  }

  /**
   * How a signed action turned out, read from getTransaction alone. A failure
   * for resources gets a new signing request to sign, up to the configured
   * retries, and then fails as SUBMISSION_REJECTED with nothing landed, never
   * as a mandate rule. `req` is the action the request was prepared for.
   */
  async signedOutcome(
    req: MandateActionRequest,
    requestId: string,
    opts: CallOptions,
  ): Promise<SignedOutcome> {
    const { network } = this;
    const loaded = await this.#requests.load(req.scope, requestId);
    if (loaded === null) throw invalid(network, 'requestId (not_found)');
    const { request, use } = loaded;
    if (request.op !== req.action.op) throw invalid(network, 'action (mismatch)');
    if (use?.txHash == null) throw invalid(network, 'requestId (not_submitted)');
    const txHash = use.txHash;
    const tx = await this.#rpc.getTransaction(txHash, opts);
    if (tx.status === 'NOT_FOUND') return { status: 'pending', txHash };
    if (tx.status === 'SUCCESS') {
      const ledger = tx.ledger ?? 0;
      await this.#closeSubmission(req.scope, txHash, {
        state: 'landed',
        landedAtHeight: BigInt(ledger),
      });
      await this.#extendAfterRestore(request, tx.resultMetaXdr, ledger, opts);
      return { status: 'landed', txHash, ledger };
    }
    await this.#closeSubmission(req.scope, txHash, {
      state: 'failed',
      errorCode: 'SUBMISSION_REJECTED',
    });
    if (resourceFailureOf(tx.resultXdr) === null) {
      throw new SubmissionRejectedError({ network, landed: 'yes' });
    }
    const resimulations = (request.resimulations ?? 0) + 1;
    if (resimulations > this.#config().soroban.resimulateRetries) {
      throw new SubmissionRejectedError({ network, landed: 'no' });
    }
    return {
      status: 'resimulated',
      signingRequest: await this.#prepare(req, opts, resimulations),
    };
  }

  // The outcome can be read any number of times and the reconciliation sweep
  // may get there first, and the store refuses any move out of a closed record.
  // A record it cannot find still goes to the store, which refuses it.
  async #closeSubmission(
    scope: TenantScope,
    txHash: string,
    patch: SubmissionPatch & { readonly state: SubmissionState },
  ): Promise<void> {
    const { network } = this;
    const { store } = this.#ports;
    const record = await store.findSubmission(scope, network, txHash);
    if (record !== null && !canMoveSubmission(record.state, patch.state)) return;
    await store.updateSubmission(scope, network, txHash, patch);
  }

  // After any transaction whose result lists restored entries: a sponsored
  // extension, as its own step, once per network, mandate and ledger.
  async #extendAfterRestore(
    request: StoredSigningRequest,
    resultMetaXdr: string | undefined,
    ledger: number,
    opts: CallOptions,
  ): Promise<void> {
    const { network } = this;
    const restored = restoredKeysOf(resultMetaXdr);
    const { mandate } = request;
    if (restored.length === 0 || mandate === null) return;
    const step = ttlExtensionKey(network, mandate, ledger);
    if (await this.#steps.isDone(step)) return;
    const config = this.#config();
    await ExecutorSession.run(this.#executor, opts, (session) =>
      extendRestored(
        this.#executor,
        session,
        {
          scope: request.scope,
          target: { mandate, asset: config.assets.USDC.sac },
          keys: restored.map((key) => xdr.LedgerKey.fromXdr(key, 'base64')),
          instanceTtlExtendLedgers:
            this.#ttlExtendLedgers ?? config.soroban.instanceTtlExtendLedgers,
          correlationId: opts.correlationId,
        },
        opts,
      ),
    );
    await this.#steps.markDone(step);
  }

  async #replay(
    earlier: NonNullable<LoadedSigningRequest['use']>,
    signed: string,
    opts: CallOptions,
  ): Promise<SubmissionRef> {
    const { network } = this;
    if (earlier.signed !== signed) throw new SignedPayloadMismatchError({ network });
    if (earlier.txHash === null) throw new SubmissionUnknownError({ network });
    const tx = await this.#rpc.getTransaction(earlier.txHash, opts);
    return {
      network,
      txHash: earlier.txHash,
      finality: tx.status === 'NOT_FOUND' ? 'none' : 'final',
    };
  }

  /** The signed transaction, if its body is byte for byte the one built and the signer signed it. */
  #checkedTransaction(request: StoredSigningRequest, signedXdr: string): Transaction {
    const { network } = this;
    const signed = parseEnvelope(signedXdr, network);
    const built = parseEnvelope(request.payload, network);
    if (
      'innerTransaction' in signed ||
      'innerTransaction' in built ||
      signed.tx.toXdr('base64') !== built.tx.toXdr('base64') ||
      !signedBy(signed, request.signer)
    ) {
      throw new SignedPayloadMismatchError({ network });
    }
    return signed;
  }

  /** The signed entry, if it is the one built with only a signature added. */
  #checkedEntry(request: StoredSigningRequest, signedXdr: string): xdr.SorobanAuthorizationEntry {
    const { network } = this;
    let entry: xdr.SorobanAuthorizationEntry;
    try {
      entry = xdr.SorobanAuthorizationEntry.fromXdr(signedXdr, 'base64');
    } catch {
      throw invalid(network, 'signed (malformed)');
    }
    const credentials = entry.credentials;
    if (
      credentials.type !== 'sorobanCredentialsAddress' ||
      credentials.address.signature.type === 'scvVoid' ||
      withSignature(entry, xdr.ScVal.scvVoid()).toXdr('base64') !== request.payload
    ) {
      throw new SignedPayloadMismatchError({ network });
    }
    return entry;
  }

  /** A G signer's transaction, inside a fee bump the sponsor pays for. */
  async #submitFeeBumped(
    request: StoredSigningRequest,
    inner: Transaction,
    reservationId: string,
    correlationId: string,
    opts: CallOptions,
  ): Promise<string> {
    const { network } = this;
    const sponsor = this.#config().feeSponsor.key.address;
    const bump = parseEnvelope(
      wrapInFeeBump({ network, inner: inner.toXdr(), feeSource: sponsor, fee: INCLUSION_FEE }),
      network,
    ) as FeeBumpTransaction;
    const signature = await this.#ports.signer.sign(
      { kind: 'fee_sponsor', network },
      { kind: 'stellar_fee_bump', network, xdr: bump.toXdr() },
      opts,
    );
    attach(bump, sponsor, signature);
    const hash = txHash(bump);
    await this.#record(
      request,
      hash,
      request.signer,
      request.sequence ?? 0n,
      reservationId,
      correlationId,
      opts,
    );
    await sendAndRecord(
      this.#executor,
      request.scope,
      hash,
      bump.toXdr(),
      request.validUntil,
      opts,
    );
    return hash;
  }

  /** A smart wallet's signed entry, sent from a leased channel account. */
  async #submitFromChannel(
    request: StoredSigningRequest,
    entry: xdr.SorobanAuthorizationEntry,
    reservationId: string,
    correlationId: string,
    opts: CallOptions,
  ): Promise<string> {
    const { network } = this;
    const config = this.#config();
    const func = xdr.HostFunction.fromXdr(request.hostFunction ?? '', 'base64');
    if (func.type !== 'hostFunctionTypeInvokeContract')
      throw new SubmissionRejectedError({ network });
    const target = asAddress(xdr.ScVal.scvAddress(func.invokeContract.contractAddress));
    return ExecutorSession.run(this.#executor, opts, async (session) => {
      const inv = {
        contract: target,
        fn: func.invokeContract.functionName.toString(),
        args: func.invokeContract.args,
      };
      const build = {
        network,
        source: session.address,
        sequence: session.sequence,
        maxTime: this.#ports.clock.nowSeconds() + BigInt(config.executor.txValiditySeconds),
      };
      // Simulated again with the signature in place, so the footprint covers
      // what the wallet's own check reads.
      const sim = await simulate(this.#rpc, network, invokeTx(inv, build, [entry]), target, opts);
      const assembled = invokeTx(inv, { ...build, sorobanData: simulatedData(sim) }, [entry]);
      if (BigInt(assembled.fee) > config.feeSponsor.maxFeePerTxStroops) {
        throw new SponsorDeniedError({ network });
      }
      const signature = await this.#ports.signer.sign(
        { kind: 'executor', network, keyId: session.lease.keyId },
        { kind: 'stellar_tx', network, xdr: assembled.toXdr() },
        opts,
      );
      attach(assembled, session.address, signature);
      const hash = txHash(assembled);
      await this.#record(
        request,
        hash,
        session.address,
        BigInt(assembled.sequence),
        reservationId,
        correlationId,
        opts,
      );
      session.sequence = BigInt(assembled.sequence);
      await sendAndRecord(
        this.#executor,
        request.scope,
        hash,
        assembled.toXdr(),
        build.maxTime,
        opts,
      );
      return hash;
    });
  }

  async #record(
    request: StoredSigningRequest,
    hash: string,
    signerAddress: string,
    sequence: bigint,
    reservationId: string,
    correlationId: string,
    opts: CallOptions,
  ): Promise<void> {
    await this.#requests.setTxHash(request.scope, request.requestId, hash);
    await this.#ports.store.recordSubmission({
      scope: request.scope,
      network: this.network,
      txHash: hash,
      op: request.op,
      mandate: request.mandate,
      payoutId: request.payoutId,
      attempt: null,
      signerAddress,
      sequenceOrNonce: sequence,
      maxTime: request.validUntil,
      state: 'built',
      landedAtHeight: null,
      errorCode: null,
      specCode: null,
      replacesTxHash: null,
      submittedAtLedger: BigInt((await this.#rpc.getLatestLedger(opts)).sequence),
      reservationId,
      correlationId,
      createdAt: this.#ports.clock.nowSeconds(),
    });
  }
}

/**
 * Keeps an authorization entry only if the signer can satisfy it. A G signer
 * is the source of its own transaction, so every entry must be covered by
 * the source account. A C wallet signs entries for itself and nothing else.
 * An entry for anyone else is a host authorization failure waiting to
 * happen, so it is refused now, as a rejection, before anyone signs.
 */
function checkedEntry(
  network: StellarNetworkId,
  entry: xdr.SorobanAuthorizationEntry,
  signer: string,
  viaWallet: boolean,
): xdr.SorobanAuthorizationEntry {
  const credentials = entry.credentials;
  const ok = viaWallet
    ? credentials.type === 'sorobanCredentialsAddress' &&
      asAddress(xdr.ScVal.scvAddress(credentials.address.address)) === signer
    : credentials.type === 'sorobanCredentialsSourceAccount';
  if (!ok) throw new SubmissionRejectedError({ network });
  return entry;
}

/** The entry with this signature and, when given, this expiration ledger. */
function withSignature(
  entry: xdr.SorobanAuthorizationEntry,
  signature: xdr.ScVal,
  expirationLedger?: number,
): xdr.SorobanAuthorizationEntry {
  const credentials = entry.credentials;
  if (credentials.type !== 'sorobanCredentialsAddress') return entry;
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: credentials.address.address,
        nonce: credentials.address.nonce,
        signatureExpirationLedger:
          expirationLedger ?? credentials.address.signatureExpirationLedger,
        signature,
      }),
    ),
    rootInvocation: entry.rootInvocation,
  });
}

function hostFunctionOf(tx: Transaction): xdr.HostFunction {
  const envelope = tx.toEnvelope();
  const body = envelope.type === 'envelopeTypeTx' ? envelope.v1.tx.operations[0]?.body : undefined;
  if (body?.type !== 'invokeHostFunction') throw new InvalidInputError();
  return body.invokeHostFunctionOp.hostFunction;
}
