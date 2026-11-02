// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// An offline Stellar RPC for the adapter's unit tests. Ledger entries and
// read answers come from responses recorded on testnet; write calls are
// answered the way simulation in recording mode answers them: the address
// the mandate would require_auth gets an authorization entry, as the source
// account when it is the transaction's source and with its own address
// credentials otherwise. Test code only.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Address, SorobanDataBuilder, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import type { Transaction } from '@stellar/stellar-sdk/base';

import { tenantRefOf, tenantTagOf } from '../tenant-ref.js';
import type { Bytes32, TenantScope } from '../types.js';
import { addressXdr } from './address-xdr.js';
import { mandateAddressOf } from './mandate-address.js';
import type {
  RawSimulation,
  RpcLatestLedger,
  RpcLedgerEntry,
  RpcSendResult,
  RpcTransaction,
  StellarRpc,
} from './rpc.js';
import { asAddress, asBytes, bytes32, field, fieldsOf, struct, unit } from './scval.js';
import { instanceKey } from './trust.js';
import { PASSPHRASES, txHash } from './tx.js';

interface RecordedCall {
  readonly method: string;
  readonly params: { readonly keys?: readonly string[]; readonly transaction?: string };
  readonly result: Record<string, unknown>;
}

export interface ReadFixture {
  readonly scope: { readonly principalId: string; readonly projectId: string };
  readonly mandate: string;
  readonly calls: readonly RecordedCall[];
}

export const FIXTURE_FACTORY = 'CAAVOGDGGM7JOLDS3CIQNPGSJOYFI54CJSAQQEFQKW7CES5UYIAZOYUQ';
export const FIXTURE_USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

export function loadReadFixture(): ReadFixture {
  return JSON.parse(
    readFileSync(path.join(import.meta.dirname, 'fixtures', 'testnet-read.json'), 'utf8'),
  ) as ReadFixture;
}

/** A recorded struct with its stored tenant reference replaced by the tag. */
function withTenantTag(value: xdr.ScVal, tag: Bytes32): xdr.ScVal {
  const kept = [...fieldsOf(value)].filter(([name]) => name !== 'tenant_ref');
  return struct({ ...Object.fromEntries(kept), tenant_tag: bytes32('tenantTag', tag) });
}

/**
 * The fixture was recorded from the mandate wasm that stored the tenant
 * reference itself, and testnet still runs that wasm. The two places it shows
 * are moved to the tag here, as the loader's own step, so the file stays what
 * the chain answered and nothing passes as recorded that was not. Delete this
 * once the fixture is recorded again from the redeployed wasm.
 */
function upgradeRecorded(rpc: FakeRpc, fixture: ReadFixture): void {
  const tag = tenantTagOf(tenantRefOf(fixture.scope as TenantScope), addressXdr(fixture.mandate));
  const key = instanceKey(fixture.mandate).toXdr('base64');
  const entry = rpc.entries.get(key);
  if (entry === undefined) throw new Error('the fixture has no mandate instance');
  const data = xdr.LedgerEntryData.fromXdr(entry.xdr, 'base64');
  if (data.type !== 'contractData' || data.contractData.val.type !== 'scvContractInstance') {
    throw new Error('the fixture mandate entry is not an instance');
  }
  const { contractData: cd } = data;
  const { instance } = cd.val as Extract<xdr.ScVal, { type: 'scvContractInstance' }>;
  const fixedKey = unit('Fixed').toXdr('base64');
  const upgraded = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: cd.ext,
      contract: cd.contract,
      key: cd.key,
      durability: cd.durability,
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: instance.executable,
          storage: (instance.storage ?? []).map((e) =>
            e.key.toXdr('base64') === fixedKey
              ? new xdr.ScMapEntry({ key: e.key, val: withTenantTag(e.val, tag) })
              : e,
          ),
        }),
      ),
    }),
  );
  rpc.entries.set(key, { ...entry, xdr: upgraded.toXdr('base64') });
  const config = rpc.reads.get('config');
  const [result] = config?.results ?? [];
  if (config === undefined || result === undefined) throw new Error('the fixture has no config');
  rpc.reads.set('config', {
    ...config,
    results: [
      {
        ...result,
        xdr: withTenantTag(xdr.ScVal.fromXdr(result.xdr, 'base64'), tag).toXdr('base64'),
      },
    ],
  });
}

/** The function a transaction invokes and its arguments. */
export function invoked(tx: Transaction): {
  readonly contract: string;
  readonly fn: string;
  readonly args: readonly xdr.ScVal[];
} {
  const envelope = tx.toEnvelope();
  const body = envelope.type === 'envelopeTypeTx' ? envelope.v1.tx.operations[0]?.body : undefined;
  if (body?.type !== 'invokeHostFunction') throw new Error('not an invocation');
  const func = body.invokeHostFunctionOp.hostFunction;
  if (func.type !== 'hostFunctionTypeInvokeContract') throw new Error('not a contract call');
  return {
    contract: Address.fromScAddress(func.invokeContract.contractAddress).toString(),
    fn: func.invokeContract.functionName.toString(),
    args: func.invokeContract.args,
  };
}

const CALLER_FUNCTIONS = new Set([
  'pause',
  'approve',
  'reject',
  'cancel',
  'cancel_batch',
  'sweep',
  'recovery_revoke',
  'recovery_rotate_agent',
  'request_payout',
  'execute',
]);

export type SimulateHandler = (tx: Transaction) => RawSimulation | undefined;

export interface FakeRpcOptions {
  /** Who authorizes calls that take no caller. */
  principal: string;
  /** The proposed principal, who authorizes accept_principal. */
  proposed?: string;
}

export class FakeRpc implements StellarRpc {
  readonly entries = new Map<string, RpcLedgerEntry>();
  readonly reads = new Map<string, RawSimulation>();
  readonly simulated: Transaction[] = [];
  readonly sent: string[] = [];
  readonly txs = new Map<string, RpcTransaction>();
  readonly calls: string[] = [];
  latest: RpcLatestLedger = { sequence: 5_500_000, closeTime: 1_793_500_000n };
  sendResult: (envelope: string) => RpcSendResult = (envelope) => ({
    status: 'PENDING',
    hash: txHash(TransactionBuilder.fromXdr(envelope, PASSPHRASES['stellar:testnet'])),
  });
  /** Consulted first for every simulation; undefined falls through to the default. */
  onSimulate: SimulateHandler = () => undefined;
  resourceFee = 50_000n;

  constructor(readonly options: FakeRpcOptions) {}

  /** Loads the recorded ledger entries and read answers. */
  static fromFixture(fixture: ReadFixture, options: FakeRpcOptions): FakeRpc {
    const rpc = new FakeRpc(options);
    for (const call of fixture.calls) {
      if (call.method === 'getLedgerEntries') {
        // Recorded with `ledger` for the key, so a secret scanner does not
        // take a base64 ledger key for a credential.
        for (const recorded of call.result['entries'] as (Omit<RpcLedgerEntry, 'key'> & {
          readonly ledger: string;
        })[]) {
          const { ledger, ...entry } = recorded;
          rpc.entries.set(ledger, { key: ledger, ...entry });
        }
      }
      if (call.method === 'simulateTransaction' && call.params.transaction !== undefined) {
        const tx = TransactionBuilder.fromXdr(
          call.params.transaction,
          PASSPHRASES['stellar:testnet'],
        );
        rpc.reads.set(invoked(tx as Transaction).fn, call.result as unknown as RawSimulation);
      }
    }
    upgradeRecorded(rpc, fixture);
    return rpc;
  }

  getLatestLedger(): Promise<RpcLatestLedger> {
    this.calls.push('getLatestLedger');
    return Promise.resolve(this.latest);
  }

  getLedgerEntries(keys: readonly string[]) {
    this.calls.push('getLedgerEntries');
    const entries = keys.flatMap((key) => {
      const entry = this.entries.get(key);
      return entry === undefined ? [] : [entry];
    });
    return Promise.resolve({ latestLedger: this.latest.sequence, entries });
  }

  simulateTransaction(txXdr: string): Promise<RawSimulation> {
    this.calls.push('simulateTransaction');
    const tx = TransactionBuilder.fromXdr(txXdr, PASSPHRASES['stellar:testnet']) as Transaction;
    this.simulated.push(tx);
    const custom = this.onSimulate(tx);
    if (custom !== undefined) return Promise.resolve(custom);
    const op = tx.operations[0]?.type;
    if (op === 'restoreFootprint' || op === 'extendFootprintTtl') {
      // As the RPC does, the footprint the transaction declares comes back
      // with a resource fee added.
      const envelope = tx.toEnvelope();
      const declared =
        envelope.type === 'envelopeTypeTx' && envelope.v1.tx.ext.type === 'sorobanData'
          ? envelope.v1.tx.ext.sorobanData
          : undefined;
      return Promise.resolve({
        ...this.success(tx, xdr.ScVal.scvVoid(), []),
        transactionData: new SorobanDataBuilder(declared)
          .setResourceFee(this.resourceFee)
          .build()
          .toXdr('base64'),
      });
    }
    const call = invoked(tx);
    const read = this.reads.get(call.fn);
    if (
      read !== undefined &&
      call.args.length === 0 &&
      ['version', 'config', 'state'].includes(call.fn)
    ) {
      return Promise.resolve(read);
    }
    return Promise.resolve(this.success(tx, this.retval(call)));
  }

  sendTransaction(txXdr: string): Promise<RpcSendResult> {
    this.calls.push('sendTransaction');
    this.sent.push(txXdr);
    return Promise.resolve(this.sendResult(txXdr));
  }

  getTransaction(hash: string): Promise<RpcTransaction> {
    this.calls.push('getTransaction');
    return Promise.resolve(
      this.txs.get(hash) ?? { status: 'SUCCESS', ledger: this.latest.sequence },
    );
  }

  /** A successful recording mode answer for `tx`, with `auth` computed when not given. */
  success(
    tx: Transaction,
    retval: xdr.ScVal,
    auth?: readonly xdr.SorobanAuthorizationEntry[],
  ): RawSimulation {
    return {
      id: '1',
      latestLedger: this.latest.sequence,
      minResourceFee: this.resourceFee.toString(),
      transactionData: new SorobanDataBuilder()
        .setResourceFee(this.resourceFee)
        .build()
        .toXdr('base64'),
      results: [
        {
          auth: (auth ?? this.authFor(tx)).map((entry) => entry.toXdr('base64')),
          xdr: retval.toXdr('base64'),
        },
      ],
    };
  }

  #authorizer(tx: Transaction): string | null {
    const call = invoked(tx);
    const [first] = call.args;
    if (CALLER_FUNCTIONS.has(call.fn) && first?.type === 'scvAddress') {
      return Address.fromScAddress(first.address).toString();
    }
    if (call.fn === 'accept_principal') return this.options.proposed ?? null;
    if (call.fn === 'create' && first?.type === 'scvMap') {
      const principal = (first.map ?? []).find(
        (e) => e.key.type === 'scvSymbol' && e.key.sym.toString() === 'principal',
      );
      return principal?.val.type === 'scvAddress'
        ? Address.fromScAddress(principal.val.address).toString()
        : null;
    }
    return this.options.principal;
  }

  authFor(tx: Transaction): xdr.SorobanAuthorizationEntry[] {
    const who = this.#authorizer(tx);
    if (who === null) return [];
    const call = invoked(tx);
    const rootInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(call.contract).toScAddress(),
          functionName: call.fn,
          args: [...call.args],
        }),
      ),
      subInvocations: [],
    });
    const credentials =
      who === tx.source
        ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
        : xdr.SorobanCredentials.sorobanCredentialsAddress(
            new xdr.SorobanAddressCredentials({
              address: Address.fromString(who).toScAddress(),
              nonce: 42n,
              signatureExpirationLedger: 0,
              signature: xdr.ScVal.scvVoid(),
            }),
          );
    return [new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation })];
  }

  retval(call: ReturnType<typeof invoked>): xdr.ScVal {
    if (call.fn === 'create') {
      const [config, salt] = call.args;
      if (config === undefined || salt === undefined) throw new Error('create takes two arguments');
      const deployed = mandateAddressOf(
        'stellar:testnet',
        call.contract,
        asAddress(field(fieldsOf(config), 'principal')),
        `0x${Buffer.from(asBytes(salt)).toString('hex')}` as Bytes32,
      );
      return Address.fromString(deployed).toScVal();
    }
    return xdr.ScVal.scvVoid();
  }
}
