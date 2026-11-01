// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Transaction plumbing shared by reads, actions and the restore step:
// network passphrases, sequence reads, simulation with error mapping, and
// signatures from the signer port attached as Stellar expects them.

import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk/base';
import type { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk/base';
import { Api, parseRawSimulation } from '@stellar/stellar-sdk/rpc';

import { encodeAccountAddress } from '../codecs/strkey.js';
import {
  InvalidInputError,
  SignerAddressMismatchError,
  SignerDeniedError,
  SubmissionUnknownError,
} from '../errors.js';
import type { NetworkId, StellarNetworkId } from '../networks.js';
import type { SignatureResult } from '../signer.js';
import type { CallOptions } from '../types.js';
import type { Invocation } from './calls.js';
import type { RpcTransaction, StellarRpc } from './rpc.js';
import { callFailure } from './sim-errors.js';

export const PASSPHRASES: Readonly<Record<StellarNetworkId, string>> = {
  'stellar:pubnet': Networks.PUBLIC,
  'stellar:testnet': Networks.TESTNET,
};

/** A source for read only simulations. It needs no account on chain. */
export const SIMULATION_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** The inclusion fee offered per operation, in stroops. */
export const INCLUSION_FEE = 100n;

export type Simulated = Api.SimulateTransactionSuccessResponse;

export function accountKey(address: string): string {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
  ).toXdr('base64');
}

/** The account's current sequence number, or null when the account does not exist. */
export async function accountSequence(
  rpc: StellarRpc,
  address: string,
  opts: CallOptions,
): Promise<bigint | null> {
  const key = accountKey(address);
  const { entries } = await rpc.getLedgerEntries([key], opts);
  const entry = entries.find((e) => e.key === key);
  if (entry === undefined) return null;
  const data = xdr.LedgerEntryData.fromXdr(entry.xdr, 'base64');
  return data.type === 'account' ? data.account.seqNum : null;
}

export interface BuildOptions {
  readonly network: StellarNetworkId;
  readonly source: string;
  /** The source's current sequence; the transaction uses the next one. */
  readonly sequence: bigint;
  readonly maxTime: bigint;
  readonly auth?: readonly xdr.SorobanAuthorizationEntry[];
}

export function builder(build: BuildOptions): TransactionBuilder {
  return new TransactionBuilder(new Account(build.source, build.sequence.toString()), {
    fee: INCLUSION_FEE.toString(),
    networkPassphrase: PASSPHRASES[build.network],
    timebounds: { minTime: 0, maxTime: Number(build.maxTime) },
  });
}

export function invokeTx(inv: Invocation, build: BuildOptions): Transaction {
  return builder(build)
    .addOperation(
      Operation.invokeContractFunction({
        contract: inv.contract,
        function: inv.fn,
        args: [...inv.args],
        auth: [...(build.auth ?? [])],
      }),
    )
    .build();
}

/** A read only call, simulated and never sent. */
export function readTx(network: StellarNetworkId, inv: Invocation): Transaction {
  return invokeTx(inv, { network, source: SIMULATION_SOURCE, sequence: 0n, maxTime: 0n });
}

/**
 * Simulates and returns the success response, or throws the mapped failure
 * for `target`, the contract the transaction calls.
 */
export async function simulate(
  rpc: StellarRpc,
  network: NetworkId,
  tx: Transaction,
  target: string,
  opts: CallOptions,
): Promise<Simulated> {
  const raw = await rpc.simulateTransaction(tx.toXdr(), opts);
  const parsed = parseRawSimulation(raw);
  if (Api.isSimulationSuccess(parsed)) return parsed;
  throw callFailure(network, target, raw.events ?? []);
}

/** The value a successful simulation returned. */
export function returned(sim: Simulated): xdr.ScVal {
  return sim.result?.retval ?? xdr.ScVal.scvVoid();
}

/**
 * Checks a signature from the port was made by `address` over this
 * envelope's hash, then attaches it.
 */
export function attach(
  tx: Transaction | FeeBumpTransaction,
  address: string,
  result: SignatureResult,
): void {
  if (encodeAccountAddress(result.publicKey) !== address) {
    throw new SignerAddressMismatchError();
  }
  try {
    tx.addSignature(address, Buffer.from(result.signature).toString('base64'));
  } catch (error) {
    throw new SignerDeniedError({ cause: error });
  }
}

/** Whether a decorated signature on `tx` was made by `address` over its hash. */
export function signedBy(tx: Transaction, address: string): boolean {
  const key = Keypair.fromPublicKey(address);
  const hash = tx.hash();
  return tx.signatures.some((s) => key.verify(hash, s.signature.value));
}

export function parseEnvelope(
  envelopeXdr: string,
  network: StellarNetworkId,
): Transaction | FeeBumpTransaction {
  try {
    return TransactionBuilder.fromXdr(envelopeXdr, PASSPHRASES[network]);
  } catch {
    throw new InvalidInputError({ network, issues: ['signed (malformed)'] });
  }
}

export function txHash(tx: Transaction | FeeBumpTransaction): string {
  return Buffer.from(tx.hash()).toString('hex');
}

export interface WaitOptions {
  readonly attempts: number;
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Polls until the transaction is included, and returns its final status. */
export async function waitForTransaction(
  rpc: StellarRpc,
  network: NetworkId,
  hash: string,
  wait: WaitOptions,
  opts: CallOptions,
): Promise<RpcTransaction> {
  for (let attempt = 0; attempt < wait.attempts; attempt += 1) {
    const tx = await rpc.getTransaction(hash, opts);
    if (tx.status !== 'NOT_FOUND') return tx;
    await wait.sleep(wait.intervalMs);
  }
  throw new SubmissionUnknownError({ network });
}
