// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The layout every executor channel account and the fee sponsor are held to, and
// the setup and check that put it in place on testnet.
//
// The account's own master key is switched off. A managed signer, the key the
// signer service holds, can pay and call contracts and cannot change signers. An
// offline recovery signer is the only key that can, so a lost or exposed managed
// key is replaced by the recovery signer and the account address never changes,
// and no principal has to authorize anything again.
//
// Testnet only. Mainnet accounts need the maintainer's approval and the hardware
// wallets behind the recovery signer, so this refuses any other network.

import {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-base';

import { InvalidInputError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type { CallOptions } from '../types.js';

import type { RpcLedgerEntry, StellarRpc } from './rpc.js';
import { accountKey, waitForTransaction } from './tx.js';
import type { WaitOptions } from './tx.js';

/** A managed signer can pay and call contracts; only the recovery signer reaches high. */
export const ACCOUNT_LAYOUT = Object.freeze({
  masterWeight: 0,
  managedWeight: 1,
  recoveryWeight: 2,
  low: 1,
  medium: 1,
  high: 2,
});

const TESTNET: StellarNetworkId = 'stellar:testnet';
const FEE_PER_OPERATION = 100;
const VALID_FOR_SECONDS = 300;

/** An account's signing setup as the ledger holds it. */
export interface AccountLayoutState {
  readonly masterWeight: number;
  readonly low: number;
  readonly medium: number;
  readonly high: number;
  /** Signers other than the master key, by public key. */
  readonly signers: readonly { readonly key: string; readonly weight: number }[];
}

export interface SignerLayout {
  /** The managed signer's public key. */
  readonly managed: string;
  /** The recovery signer's public key. */
  readonly recovery: string;
}

/** Refuses any network but testnet, by its id and by what the RPC says it is. */
export function assertTestnet(network: string, passphrase?: string): StellarNetworkId {
  if (network !== TESTNET) {
    throw new InvalidInputError({ issues: ['network (testnet_only)'] });
  }
  if (passphrase !== undefined && passphrase !== (Networks.TESTNET as string)) {
    throw new InvalidInputError({ issues: ['rpc (not_testnet)'] });
  }
  return TESTNET;
}

/** Reads an account's signing setup out of its ledger entry, as base64 XDR. */
export function readAccountLayout(entry: RpcLedgerEntry): AccountLayoutState {
  const data = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
  if (data.switch().name !== 'account') {
    throw new InvalidInputError({ issues: ['entry (not_an_account)'] });
  }
  const account = data.account();
  const thresholds = account.thresholds();
  return {
    masterWeight: thresholds[0] ?? 0,
    low: thresholds[1] ?? 0,
    medium: thresholds[2] ?? 0,
    high: thresholds[3] ?? 0,
    signers: account
      .signers()
      .filter((signer) => signer.key().switch().name === 'signerKeyTypeEd25519')
      .map((signer) => ({
        key: StrKey.encodeEd25519PublicKey(signer.key().ed25519()),
        weight: signer.weight(),
      })),
  };
}

/** What would have to change to reach the layout, in words, empty when nothing does. */
export function layoutChanges(state: AccountLayoutState, want: SignerLayout): readonly string[] {
  const changes: string[] = [];
  const weightOf = (key: string): number =>
    state.signers.find((signer) => signer.key === key)?.weight ?? 0;
  if (weightOf(want.managed) !== ACCOUNT_LAYOUT.managedWeight) {
    changes.push(`managed signer weight ${String(weightOf(want.managed))} to 1`);
  }
  if (weightOf(want.recovery) !== ACCOUNT_LAYOUT.recoveryWeight) {
    changes.push(`recovery signer weight ${String(weightOf(want.recovery))} to 2`);
  }
  for (const signer of state.signers) {
    if (signer.key !== want.managed && signer.key !== want.recovery) {
      changes.push(`remove another signer of weight ${String(signer.weight)}`);
    }
  }
  if (state.masterWeight !== ACCOUNT_LAYOUT.masterWeight) {
    changes.push(`master weight ${String(state.masterWeight)} to 0`);
  }
  if (
    state.low !== ACCOUNT_LAYOUT.low ||
    state.medium !== ACCOUNT_LAYOUT.medium ||
    state.high !== ACCOUNT_LAYOUT.high
  ) {
    changes.push(
      `thresholds ${String(state.low)}/${String(state.medium)}/${String(state.high)} to 1/1/2`,
    );
  }
  return changes;
}

// Which key can make the change: the master key while it still meets the high
// threshold, which is so for a new account, and otherwise the recovery signer.
function signerFor(state: AccountLayoutState, want: SignerLayout): 'master' | 'recovery' {
  if (state.masterWeight > 0 && state.masterWeight >= state.high) return 'master';
  const recovery = state.signers.find((signer) => signer.key === want.recovery)?.weight ?? 0;
  if (recovery > 0 && recovery >= state.high) return 'recovery';
  throw new InvalidInputError({ issues: ['account (no_key_can_fix_it)'] });
}

/**
 * The one transaction that brings an account to the layout, unsigned. Signers are
 * added before the master key is switched off, in the same transaction, and every
 * operation is checked against the account as it was before it.
 */
export function buildLayoutTransaction(input: {
  readonly network: string;
  readonly account: string;
  readonly sequence: bigint;
  readonly state: AccountLayoutState;
  readonly want: SignerLayout;
  readonly nowSeconds: number;
}): { readonly xdr: string; readonly signer: 'master' | 'recovery' } {
  assertTestnet(input.network);
  const { state, want } = input;
  const operations: xdr.Operation[] = [];
  const weightOf = (key: string): number =>
    state.signers.find((signer) => signer.key === key)?.weight ?? 0;
  if (weightOf(want.managed) !== ACCOUNT_LAYOUT.managedWeight) {
    operations.push(
      Operation.setOptions({
        signer: { ed25519PublicKey: want.managed, weight: ACCOUNT_LAYOUT.managedWeight },
      }),
    );
  }
  if (weightOf(want.recovery) !== ACCOUNT_LAYOUT.recoveryWeight) {
    operations.push(
      Operation.setOptions({
        signer: { ed25519PublicKey: want.recovery, weight: ACCOUNT_LAYOUT.recoveryWeight },
      }),
    );
  }
  for (const signer of state.signers) {
    if (signer.key !== want.managed && signer.key !== want.recovery) {
      operations.push(
        Operation.setOptions({ signer: { ed25519PublicKey: signer.key, weight: 0 } }),
      );
    }
  }
  operations.push(
    Operation.setOptions({
      masterWeight: ACCOUNT_LAYOUT.masterWeight,
      lowThreshold: ACCOUNT_LAYOUT.low,
      medThreshold: ACCOUNT_LAYOUT.medium,
      highThreshold: ACCOUNT_LAYOUT.high,
    }),
  );
  const builder = new TransactionBuilder(new Account(input.account, input.sequence.toString()), {
    fee: String(FEE_PER_OPERATION),
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: input.nowSeconds + VALID_FOR_SECONDS },
  });
  for (const operation of operations) builder.addOperation(operation);
  return { xdr: builder.build().toEnvelope().toXDR('base64'), signer: signerFor(state, want) };
}

/**
 * Signs a testnet transaction with a secret the caller holds in memory. The secret
 * is not kept, logged or returned.
 */
export function signTestnetTransaction(txXdr: string, secret: string): string {
  const tx = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET);
  tx.sign(Keypair.fromSecret(secret));
  return tx.toEnvelope().toXDR('base64');
}

/** The public key of a secret, so a caller can check it holds the key it meant to. */
export function publicKeyOfSecret(secret: string): string {
  return Keypair.fromSecret(secret).publicKey();
}

export interface AccountSetupPorts {
  readonly rpc: Pick<StellarRpc, 'getLedgerEntries' | 'sendTransaction' | 'getTransaction'>;
  /** Funds a new account from the testnet faucet. */
  readonly fund: (address: string) => Promise<void>;
  /** Signs with the named key, held only for the call. */
  readonly sign: (keyName: string, txXdr: string) => Promise<string>;
  readonly nowSeconds: () => number;
  readonly wait: WaitOptions;
}

export interface AccountToSet {
  /** What the configuration calls it, such as channel-1 or fee-sponsor. */
  readonly role: string;
  /** The key name of the account's own key, which signs while the master is on. */
  readonly keyName: string;
  readonly address: string;
}

export interface AccountReport {
  readonly role: string;
  readonly account: string;
  readonly created: boolean;
  readonly changes: readonly string[];
  /** The transaction that made the changes, or null when there were none. */
  readonly txHash: string | null;
}

/** The ledger key that reads an account, as base64 XDR. */
export function accountLedgerKey(address: string): string {
  return accountKey(address);
}

/** The account's current sequence number, from its ledger entry. */
export function accountSequenceOf(entry: RpcLedgerEntry): bigint {
  const data = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
  if (data.switch().name !== 'account') {
    throw new InvalidInputError({ issues: ['entry (not_an_account)'] });
  }
  return BigInt(data.account().seqNum().toString());
}

async function readAccount(
  rpc: AccountSetupPorts['rpc'],
  address: string,
  opts: CallOptions,
): Promise<{ readonly state: AccountLayoutState; readonly sequence: bigint } | null> {
  const key = accountKey(address);
  const { entries } = await rpc.getLedgerEntries([key], opts);
  const entry = entries.find((found) => found.key === key);
  if (entry === undefined) return null;
  return { state: readAccountLayout(entry), sequence: accountSequenceOf(entry) };
}

/**
 * Creates each account that does not exist yet, then brings every one to the
 * layout. Safe to run again: an account already in the layout is left alone, and
 * one that drifted gets only what changed. Throws for a transaction the network
 * refuses, with the result code and never a key.
 */
export async function setUpAccounts(
  request: {
    readonly network: string;
    readonly accounts: readonly AccountToSet[];
    readonly want: SignerLayout;
    readonly recoveryKeyName: string;
  },
  ports: AccountSetupPorts,
  opts: CallOptions,
): Promise<readonly AccountReport[]> {
  const network = assertTestnet(request.network);
  const reports: AccountReport[] = [];
  for (const account of request.accounts) {
    let found = await readAccount(ports.rpc, account.address, opts);
    const created = found === null;
    if (found === null) {
      await ports.fund(account.address);
      found = await readAccount(ports.rpc, account.address, opts);
      if (found === null) throw new InvalidInputError({ issues: ['account (not_funded)'] });
    }
    const changes = layoutChanges(found.state, request.want);
    if (changes.length === 0) {
      reports.push({
        role: account.role,
        account: account.address,
        created,
        changes,
        txHash: null,
      });
      continue;
    }
    const built = buildLayoutTransaction({
      network,
      account: account.address,
      sequence: found.sequence + 1n,
      state: found.state,
      want: request.want,
      nowSeconds: ports.nowSeconds(),
    });
    const keyName = built.signer === 'master' ? account.keyName : request.recoveryKeyName;
    const signed = await ports.sign(keyName, built.xdr);
    const sent = await ports.rpc.sendTransaction(signed, opts);
    if (sent.status === 'ERROR') {
      throw new InvalidInputError({
        issues: [`transaction (${resultCodeOf(sent.errorResultXdr)})`],
      });
    }
    const landed = await waitForTransaction(
      ports.rpc as StellarRpc,
      network,
      sent.hash,
      ports.wait,
      opts,
    );
    if (landed.status !== 'SUCCESS') {
      throw new InvalidInputError({ issues: [`transaction (${resultCodeOf(landed.resultXdr)})`] });
    }
    reports.push({
      role: account.role,
      account: account.address,
      created,
      changes,
      txHash: sent.hash,
    });
  }
  return reports;
}

/** Each account and what differs from the layout, empty for an account in it. */
export async function verifyAccounts(
  request: {
    readonly network: string;
    readonly accounts: readonly Pick<AccountToSet, 'role' | 'address'>[];
    readonly want: SignerLayout;
  },
  rpc: AccountSetupPorts['rpc'],
  opts: CallOptions,
): Promise<
  readonly {
    readonly role: string;
    readonly account: string;
    readonly problems: readonly string[];
  }[]
> {
  assertTestnet(request.network);
  const results = [];
  for (const account of request.accounts) {
    const found = await readAccount(rpc, account.address, opts);
    results.push({
      role: account.role,
      account: account.address,
      problems:
        found === null ? ['account does not exist'] : layoutChanges(found.state, request.want),
    });
  }
  return results;
}

/**
 * A transaction result code from its XDR, in lower snake case (tx_bad_auth),
 * which is how Horizon and the docs spell it and the only form an error issue takes.
 */
export function resultCodeOf(resultXdr: string | undefined): string {
  if (resultXdr === undefined) return 'unknown';
  try {
    const name = xdr.TransactionResult.fromXDR(resultXdr, 'base64').result().switch().name;
    return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  } catch {
    return 'unreadable';
  }
}
