// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A scripted mandate behind the offline RPC, for the payout step tests: the test
// sets what payout(id) answers and which calls the mandate refuses, and the real
// adapter does the rest. Test code only.

import { createHash } from 'node:crypto';

import {
  Address,
  Keypair,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk/base';
import type { Transaction } from '@stellar/stellar-sdk/base';
import { tokenAmount } from '@ujira/core';

import { SignerDeniedError } from '../errors.js';
import { MANDATE_ERRORS } from '../mandate-errors.js';
import type { MandateErrorName } from '../mandate-errors.js';
import type {
  AdapterAlerts,
  Bytes32,
  LegKey,
  MandateRegistration,
  PayRequest,
  PayoutId,
  SponsorshipPolicy,
  UnixSeconds,
  Uuid,
} from '../types.js';
import type { SignerProvider, SignerRef } from '../signer.js';
import { trustlineKey } from './destination-check.js';
import { StellarMandateAdapter } from './mandate-adapter.js';
import type { ExecutionMirror } from './pay.js';
import type { RawSimulation, RpcEvent } from './rpc.js';
import { address, bytes32, i128, struct, sym, u32, u64, vec } from './scval.js';
import { NETWORK, addAccount, setup } from './test-adapter.js';
import type { TestSetup } from './test-adapter.js';
import { invoked } from './test-rpc.js';
import { PASSPHRASES, footprintTx, invokeTx, parseEnvelope } from './tx.js';

export const METHOD = '00000000-0000-4000-8000-0000000000aa' as Uuid;
export const TOTAL = 1_000_000n;

export const payoutIdOf = (n: number): PayoutId =>
  `0x${n.toString(16).padStart(2, '0').repeat(32)}` as unknown as PayoutId;

export function record(
  status: 1 | 2,
  over: {
    total?: bigint;
    fee?: bigint;
    expiresAt?: bigint;
    approvals?: readonly { readonly approver: string; readonly epoch: number }[];
  } = {},
): xdr.ScVal {
  return vec([
    sym('Record'),
    struct({
      status: u32('status', status),
      total: i128('total', over.total ?? TOTAL),
      fee: i128('fee', over.fee ?? 0n),
      expires_at: u64('expiresAt', over.expiresAt ?? 9_000_000_000n),
      approvals: vec(
        (over.approvals ?? []).map((a) =>
          struct({ approver: address('approver', a.approver), epoch: u32('epoch', a.epoch) }),
        ),
      ),
    }),
  ]);
}

export function tombstone(status: 3 | 4 | 5): xdr.ScVal {
  return vec([sym('Tombstone'), struct({ status: u32('status', status) })]);
}

/** A failed simulation as the mandate fails one: its code in a diagnostic event. */
export function refusal(contract: string, name: MandateErrorName): RawSimulation {
  return {
    id: '1',
    latestLedger: 100,
    error: `HostError: Error(Contract, #${String(MANDATE_ERRORS[name])})`,
    events: [
      new xdr.DiagnosticEvent({
        inSuccessfulContractCall: false,
        event: new xdr.ContractEvent({
          ext: xdr.ExtensionPoint.v0(),
          contractId: new xdr.ContractId(Address.fromString(contract).toBuffer()),
          type: xdr.ContractEventType.diagnostic,
          body: xdr.ContractEventBody.v0(
            new xdr.ContractEventV0({
              topics: [
                sym('error'),
                xdr.ScVal.scvError(xdr.ScError.sceContract(MANDATE_ERRORS[name])),
              ],
              data: xdr.ScVal.scvVoid(),
            }),
          ),
        }),
      }).toXdr('base64'),
    ],
  };
}

export interface PayWorld extends TestSetup {
  readonly payouts: StellarMandateAdapter;
  readonly agent: Keypair;
  readonly recipient: string;
  readonly managed: SignerRef;
  /** What payout(id) answers, by ID; absent otherwise. */
  readonly views: Map<string, xdr.ScVal>;
  /** Calls the mandate refuses, by function name. */
  readonly refused: Map<
    string,
    MandateErrorName | ((tx: Transaction) => RawSimulation | undefined)
  >;
  readonly alerts: Parameters<AdapterAlerts['batch']>[0][];
  readonly divergences: Parameters<AdapterAlerts['divergence']>[0][];
}

export function trustline(
  t: TestSetup,
  account: string,
  over: { flags?: number; limit?: bigint; balance?: bigint } = {},
): void {
  const issuer = t.ports.config()[NETWORK]?.assets.USDC.issuer ?? '';
  const key = trustlineKey(account, issuer);
  const parsed = xdr.LedgerKey.fromXdr(key, 'base64');
  if (parsed.type !== 'trustline') throw new Error('not a trustline key');
  t.rpc.entries.set(key, {
    key,
    lastModifiedLedgerSeq: 1,
    xdr: xdr.LedgerEntryData.trustline(
      new xdr.TrustLineEntry({
        accountId: parsed.trustLine.accountId,
        asset: parsed.trustLine.asset,
        balance: over.balance ?? 0n,
        limit: over.limit ?? 9_000_000_000n,
        flags: over.flags ?? 1,
        ext: xdr.TrustLineEntryExt.v0(),
      }),
    ).toXdr('base64'),
  });
}

export function payWorld(
  options: {
    readonly mirror?: ExecutionMirror;
    readonly registered?: boolean;
    readonly registration?: Partial<MandateRegistration>;
    /** Puts something in front of the signer, such as the real signer policies. */
    readonly wrapSigner?: (inner: SignerProvider, agent: Keypair, t: TestSetup) => SignerProvider;
    readonly sponsorship?: (t: TestSetup) => SponsorshipPolicy;
  } = {},
): PayWorld {
  const t = setup({
    ...(options.registered === undefined ? {} : { registered: options.registered }),
    ...(options.registration === undefined ? {} : { registration: options.registration }),
  });
  const agent = Keypair.random();
  const recipient = Keypair.random().publicKey();
  addAccount(t.rpc, recipient, 1n);
  addAccount(t.rpc, agent.publicKey(), 50n);
  trustline(t, recipient);
  t.methods.set(METHOD, {
    address: { network: NETWORK, value: recipient },
    tag: null,
  });
  const views = new Map<string, xdr.ScVal>();
  const refused: PayWorld['refused'] = new Map();
  const alerts: PayWorld['alerts'] = [];
  const divergences: PayWorld['divergences'] = [];
  t.rpc.onSimulate = (tx) => {
    if (tx.operations[0]?.type !== 'invokeHostFunction') return undefined;
    const call = invoked(tx);
    const rule = refused.get(call.fn);
    if (typeof rule === 'string') return refusal(call.contract, rule);
    if (rule !== undefined) {
      const answer = rule(tx);
      if (answer !== undefined) return answer;
    }
    if (call.fn === 'payout') {
      const [id] = call.args;
      const key = id?.type === 'scvBytes' ? Buffer.from(id.bytes.value).toString('hex') : '';
      return t.rpc.success(tx, views.get(`0x${key}`) ?? xdr.ScVal.scvVoid(), []);
    }
    return undefined;
  };
  const signer: SignerProvider = {
    ...t.ports.signer,
    address: (ref, opts) =>
      ref.kind === 'managed_agent'
        ? Promise.resolve({ network: NETWORK, value: agent.publicKey() })
        : t.ports.signer.address(ref, opts),
    sign: (ref, payload, opts) => {
      if (ref.kind !== 'managed_agent') return t.ports.signer.sign(ref, payload, opts);
      // What the agent signer's policy allows, and all a test may ask of it.
      if (payload.kind !== 'stellar_tx') {
        return Promise.reject(new SignerDeniedError({ network: NETWORK }));
      }
      const tx = TransactionBuilder.fromXdr(payload.xdr, PASSPHRASES[NETWORK]);
      return Promise.resolve({
        kind: 'ed25519' as const,
        signature: agent.sign(tx.hash()),
        publicKey: agent.rawPublicKey(),
      });
    },
  };
  const payouts = new StellarMandateAdapter({
    network: NETWORK,
    rpc: t.rpc,
    ports: {
      ...t.ports,
      signer: options.wrapSigner?.(signer, agent, t) ?? signer,
      ...(options.sponsorship === undefined ? {} : { sponsorship: options.sponsorship(t) }),
      alerts: {
        ...t.ports.alerts,
        batch: (e) => alerts.push(e),
        divergence: (e) => divergences.push(e),
      },
    },
    requests: t.requests,
    methods: { destination: (_scope, id) => Promise.resolve(t.methods.get(id) ?? null) },
    wait: { attempts: 2, intervalMs: 0, sleep: () => Promise.resolve() },
    ...(options.mirror === undefined ? {} : { mirror: options.mirror }),
    newRequestId: () => 'req-pay',
  });
  return {
    ...t,
    payouts,
    agent,
    recipient,
    managed: {
      kind: 'managed_agent',
      network: NETWORK,
      scope: t.scope,
      agentId: '00000000-0000-4000-8000-0000000000bb' as Uuid,
    },
    views,
    refused,
    alerts,
    divergences,
  };
}

export function payRequest(w: PayWorld, n = 1, over: Partial<PayRequest> = {}): PayRequest {
  const payoutId = payoutIdOf(n);
  return {
    scope: w.scope,
    mandate: w.mandate,
    payoutId,
    attempt: 1,
    recipientRef: `0x${'11'.repeat(32)}` as Bytes32,
    taskRef: `0x${'22'.repeat(32)}` as Bytes32,
    total: tokenAmount(TOTAL, 'USDC', 'stellar'),
    fee: tokenAmount(0n, 'USDC', 'stellar'),
    legs: [
      {
        index: 0,
        legKey: `${payoutId as unknown as string}00` as LegKey,
        rail: 'stellar.wallet',
        recipientMethodId: METHOD,
        amount: tokenAmount(TOTAL, 'USDC', 'stellar'),
        deliveryCurrency: 'USDC',
      },
    ],
    deadline: (w.rpc.latest.closeTime + 600n) as UnixSeconds,
    attestations: [],
    execute: 'auto',
    signer: w.managed,
    ...over,
  };
}

/** A payout_executed as the RPC reports it, with what the contract puts in it. */
export function executedEvent(
  contract: string,
  payoutId: PayoutId,
  legs: readonly xdr.ScVal[],
  over: Partial<RpcEvent> = {},
): RpcEvent {
  return {
    type: 'contract',
    contractId: contract,
    txHash: 'ab'.repeat(32),
    id: '0000000123456-0000000003',
    ledger: 123,
    ledgerClosedAt: '2026-11-02T00:00:00Z',
    inSuccessfulContractCall: true,
    topic: [sym('payout_executed').toXdr('base64'), bytes32('id', payoutId).toXdr('base64')],
    value: struct({
      recipient_ref: bytes32('r', `0x${'11'.repeat(32)}` as Bytes32),
      total: i128('total', TOTAL),
      fee: i128('fee', 0n),
      legs: vec(legs),
      day: u64('day', 1n),
      spent: i128('spent', TOTAL),
    }).toXdr('base64'),
    ...over,
  };
}

// What a test of the signer needs, built here because the signer does not depend on
// the Stellar SDK and should not start to for a test.

/** An authorization entry for one call, under `who`'s own credentials. */
export function authEntryFor(
  who: string,
  contract: string,
  fn: string,
  signed = true,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(who).toScAddress(),
        nonce: 1n,
        signatureExpirationLedger: 100,
        signature: signed ? xdr.ScVal.scvBytes(Buffer.alloc(64, 1)) : xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(contract).toScAddress(),
          functionName: fn,
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

/** The same call, authorized by the transaction's own source. */
export function sourceAccountEntry(
  entry: xdr.SorobanAuthorizationEntry,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: entry.rootInvocation,
  });
}

/** What the adapter keys a wallet's reservation on: the signed entry. */
export function entryHash(entry: xdr.SorobanAuthorizationEntry): Uint8Array {
  return createHash('sha256').update(entry.toXdr()).digest();
}

/** The entry a wallet hands back: the one it was given, now with a signature. */
export function withWalletSignature(entryXdr: string): string {
  const entry = xdr.SorobanAuthorizationEntry.fromXdr(entryXdr, 'base64');
  const { credentials } = entry;
  if (credentials.type !== 'sorobanCredentialsAddress') throw new Error('not address credentials');
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: credentials.address.address,
        nonce: credentials.address.nonce,
        signatureExpirationLedger: credentials.address.signatureExpirationLedger,
        signature: xdr.ScVal.scvBytes(Buffer.alloc(64, 1)),
      }),
    ),
    rootInvocation: entry.rootInvocation,
  }).toXdr('base64');
}

export function signedBy(transactionXdr: string, key: Keypair): string {
  const tx = parseEnvelope(transactionXdr, NETWORK);
  tx.sign(key);
  return tx.toXdr();
}

function builtWith(w: PayWorld, resourceFee: bigint) {
  return {
    network: NETWORK,
    source: w.channel.publicKey(),
    sequence: 1n,
    maxTime: w.rpc.latest.closeTime + 60n,
    sorobanData: new SorobanDataBuilder().setResourceFee(resourceFee).build().toXdr('base64'),
  };
}

/** A call on the mandate from the channel account, carrying these entries. */
export function relayedCallXdr(
  w: PayWorld,
  auth: readonly xdr.SorobanAuthorizationEntry[],
  over: { contract?: string; fn?: string; resourceFee?: bigint } = {},
): string {
  return invokeTx(
    {
      contract: over.contract ?? w.mandate.address.value,
      fn: over.fn ?? 'pause',
      args: [],
    },
    builtWith(w, over.resourceFee ?? 1000n),
    auth,
  ).toXdr();
}

export function footprintXdr(w: PayWorld, kind: 'restore' | 'extend', resourceFee = 1000n): string {
  return footprintTx(
    kind === 'restore' ? { kind: 'restore' } : { kind: 'extend_ttl', extendTo: 100 },
    builtWith(w, resourceFee),
  ).toXdr();
}
