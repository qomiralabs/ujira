// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A testnet ledger in memory, for the account setup's tests. It holds classic
// accounts, checks a transaction's signatures as the network does (the envelope
// against the low threshold, a change of signers against the high one), and
// applies SetOptions. Keys are random and live only in memory.

import { Keypair, Networks, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-base';
import type { Operation, Transaction } from '@stellar/stellar-base';

import type { AccountSetupPorts } from '../stellar/account-setup.js';
import type { RpcLedgerEntry, RpcSendResult, RpcTransaction } from '../stellar/rpc.js';
import { accountKey } from '../stellar/tx.js';

interface HeldAccount {
  sequence: bigint;
  masterWeight: number;
  low: number;
  medium: number;
  high: number;
  signers: Map<string, number>;
}

export interface MemoryAccountLedger {
  readonly rpc: AccountSetupPorts['rpc'];
  readonly fund: AccountSetupPorts['fund'];
  readonly sign: AccountSetupPorts['sign'];
  /** A key held under a name, made on first use. Returns its public key. */
  key(name: string): string;
  /** Every transaction sent, as base64 XDR, refused ones included. */
  readonly sent: string[];
  /** The account as held, or undefined. */
  account(address: string): Readonly<HeldAccount> | undefined;
}

function refused(result: xdr.TransactionResultResult): string {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('100'),
    result,
    ext: new xdr.TransactionResultExt(0),
  }).toXDR('base64');
}

function entryOf(address: string, held: HeldAccount): RpcLedgerEntry {
  const data = xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      balance: xdr.Int64.fromString('100000000000'),
      seqNum: xdr.Int64.fromString(held.sequence.toString()),
      numSubEntries: held.signers.size,
      inflationDest: null,
      flags: 0,
      homeDomain: '',
      thresholds: Buffer.from([held.masterWeight, held.low, held.medium, held.high]),
      signers: [...held.signers].map(
        ([key, weight]) =>
          new xdr.Signer({
            key: xdr.SignerKey.signerKeyTypeEd25519(StrKey.decodeEd25519PublicKey(key)),
            weight,
          }),
      ),
      ext: new xdr.AccountEntryExt(0),
    }),
  );
  return { key: accountKey(address), xdr: data.toXDR('base64'), lastModifiedLedgerSeq: 1 };
}

export function createMemoryAccountLedger(): MemoryAccountLedger {
  const keys = new Map<string, Keypair>();
  const accounts = new Map<string, HeldAccount>();
  const results = new Map<string, RpcTransaction>();
  const sent: string[] = [];
  let ledger = 100;

  const weightSigned = (tx: Transaction, address: string, held: HeldAccount): number => {
    const hash = tx.hash();
    const signedBy = (publicKey: string): boolean =>
      tx.signatures.some((signature) =>
        Keypair.fromPublicKey(publicKey).verify(hash, signature.signature()),
      );
    let weight = signedBy(address) ? held.masterWeight : 0;
    for (const [key, signerWeight] of held.signers) {
      if (signedBy(key)) weight += signerWeight;
    }
    return weight;
  };

  const apply = (held: HeldAccount, op: Operation.SetOptions): void => {
    if (op.masterWeight !== undefined) held.masterWeight = op.masterWeight;
    if (op.lowThreshold !== undefined) held.low = op.lowThreshold;
    if (op.medThreshold !== undefined) held.medium = op.medThreshold;
    if (op.highThreshold !== undefined) held.high = op.highThreshold;
    const signer = op.signer as { ed25519PublicKey?: string; weight?: number } | undefined;
    if (signer?.ed25519PublicKey !== undefined && signer.weight !== undefined) {
      if (signer.weight === 0) held.signers.delete(signer.ed25519PublicKey);
      else held.signers.set(signer.ed25519PublicKey, signer.weight);
    }
  };

  return {
    sent,
    key(name) {
      const held = keys.get(name) ?? Keypair.random();
      keys.set(name, held);
      return held.publicKey();
    },
    account: (address) => accounts.get(address),
    fund(address) {
      if (!accounts.has(address)) {
        accounts.set(address, {
          sequence: BigInt(ledger) << 32n,
          masterWeight: 1,
          low: 0,
          medium: 0,
          high: 0,
          signers: new Map(),
        });
      }
      return Promise.resolve();
    },
    sign(name, txXdr) {
      const keypair = keys.get(name);
      if (keypair === undefined) return Promise.reject(new Error('no such key'));
      const tx = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET) as Transaction;
      tx.sign(keypair);
      return Promise.resolve(tx.toEnvelope().toXDR('base64'));
    },
    rpc: {
      getLedgerEntries(asked) {
        const entries = [...accounts]
          .map(([address, held]) => entryOf(address, held))
          .filter((entry) => asked.includes(entry.key));
        return Promise.resolve({ latestLedger: ledger, entries });
      },
      sendTransaction(txXdr): Promise<RpcSendResult> {
        sent.push(txXdr);
        const tx = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET) as Transaction;
        const hash = tx.hash().toString('hex');
        const held = accounts.get(tx.source);
        if (held === undefined) {
          const errorResultXdr = refused(xdr.TransactionResultResult.txNoAccount());
          return Promise.resolve({ status: 'ERROR', hash, errorResultXdr });
        }
        // The order the network checks in: the sequence, then the envelope's
        // signatures against the low threshold. A threshold of 0 still takes a
        // signature of some weight.
        if (BigInt(tx.sequence) !== held.sequence + 1n) {
          const errorResultXdr = refused(xdr.TransactionResultResult.txBadSeq());
          return Promise.resolve({ status: 'ERROR', hash, errorResultXdr });
        }
        const weight = weightSigned(tx, tx.source, held);
        if (weight < Math.max(held.low, 1)) {
          const errorResultXdr = refused(xdr.TransactionResultResult.txBadAuth());
          return Promise.resolve({ status: 'ERROR', hash, errorResultXdr });
        }
        // Accepted, so it lands and uses the sequence even if it then fails.
        // Every operation here changes signers or thresholds, which takes the
        // high threshold; short of it the operation fails, not the envelope.
        held.sequence = BigInt(tx.sequence);
        ledger += 1;
        if (weight < Math.max(held.high, 1)) {
          const ops = tx.operations.map(() => xdr.OperationResult.opBadAuth());
          const resultXdr = refused(xdr.TransactionResultResult.txFailed(ops));
          results.set(hash, { status: 'FAILED', ledger, resultXdr });
          return Promise.resolve({ status: 'PENDING', hash });
        }
        for (const op of tx.operations) {
          if (op.type === 'setOptions') apply(held, op);
        }
        results.set(hash, { status: 'SUCCESS', ledger });
        return Promise.resolve({ status: 'PENDING', hash });
      },
      getTransaction(hash) {
        return Promise.resolve(results.get(hash) ?? { status: 'NOT_FOUND' });
      },
    },
  };
}
