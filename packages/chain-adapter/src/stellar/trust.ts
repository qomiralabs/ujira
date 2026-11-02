// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Whether a mandate can be trusted, read from its own ledger entry. A mandate
// cannot prove who deployed it: its constructor takes the factory as an
// argument, and anyone could deploy the same code naming a trusted factory.
// So the factory it names is only the start. A mandate is trusted when it
// names a factory in the trusted list, runs exactly the code that factory
// deploys, pays fees to that factory's fee address and settles in an asset
// that factory supports. Such a contract runs the reviewed rules whoever
// deployed it, which is what a call against it needs to know. It says nothing
// about the contract's events: one deployed directly never got a mandate_created
// from the factory, so only registration from that event may book events.
// Factory facts are fixed for the factory's life, so they are read once and
// kept.

import { Address, xdr } from '@stellar/stellar-sdk/base';

import { InvalidInputError, MandateUntrustedError, TenantMismatchError } from '../errors.js';
import type { NetworkId } from '../networks.js';
import { tenantRefOf, tenantTagOf } from '../tenant-ref.js';
import type { Bytes32, CallOptions, MandateRef, TenantScope } from '../types.js';
import { addressXdr } from './address-xdr.js';
import type { StellarRpc } from './rpc.js';
import { asAddress, asBytes32, asU32, asVec, field, fieldsOf, unit } from './scval.js';

export interface MandateInstance {
  readonly address: string;
  readonly factory: string;
  readonly asset: string;
  readonly feeAddress: string;
  readonly tenantTag: Bytes32;
  readonly recipientMode: number;
  readonly wasmHash: string;
}

interface FactoryFacts {
  readonly wasmHash: string;
  readonly feeAddress: string;
  readonly assets: readonly string[];
}

export function instanceKey(contract: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

interface Instance {
  readonly wasmHash: string;
  readonly storage: ReadonlyMap<string, xdr.ScVal>;
}

function decodeInstance(entryXdr: string): Instance | null {
  const data = xdr.LedgerEntryData.fromXdr(entryXdr, 'base64');
  if (data.type !== 'contractData' || data.contractData.val.type !== 'scvContractInstance') {
    return null;
  }
  const { executable, storage: entries } = data.contractData.val.instance;
  // A token contract has no wasm, so it is no mandate and no factory.
  if (executable.type !== 'contractExecutableWasm') return null;
  const storage = new Map<string, xdr.ScVal>();
  for (const entry of entries ?? []) storage.set(entry.key.toXdr('base64'), entry.val);
  return { wasmHash: Buffer.from(executable.wasmHash.value).toString('hex'), storage };
}

function stored(instance: Instance, key: string): xdr.ScVal | undefined {
  return instance.storage.get(unit(key).toXdr('base64'));
}

/** Reads and checks mandates against the network's trusted factories. */
export class MandateTrust {
  readonly #factories = new Map<string, Promise<FactoryFacts | null>>();

  constructor(
    private readonly network: NetworkId,
    private readonly rpc: StellarRpc,
    private readonly trusted: () => readonly string[],
  ) {}

  /** The mandate's fixed facts, after the tenant and trust checks. */
  async verify(scope: TenantScope, ref: MandateRef, opts: CallOptions): Promise<MandateInstance> {
    const { network } = this;
    if (ref.network !== network || ref.address.network !== network) {
      throw new InvalidInputError({ network, issues: ['mandate.network (mismatch)'] });
    }
    const mandate = ref.address.value;
    const instance = await this.#instance(mandate, 'mandate.address', opts);
    const fixedValue = instance === null ? undefined : stored(instance, 'Fixed');
    if (instance === null || fixedValue === undefined) {
      throw new MandateUntrustedError({ network });
    }
    const fixed = fieldsOf(fixedValue);
    const facts: MandateInstance = {
      address: mandate,
      factory: asAddress(field(fixed, 'factory')),
      asset: asAddress(field(fixed, 'asset')),
      feeAddress: asAddress(field(fixed, 'fee_address')),
      tenantTag: asBytes32(field(fixed, 'tenant_tag')),
      recipientMode: asU32(field(fixed, 'recipient_mode')),
      wasmHash: instance.wasmHash,
    };
    // The tenant comes first, so another tenant learns nothing about the
    // mandate, not even whether it is trusted.
    // The tag is recomputed for this address, so one copied from another
    // mandate of the same tenant does not pass either.
    if (facts.tenantTag !== tenantTagOf(tenantRefOf(scope), addressXdr(mandate))) {
      throw new TenantMismatchError({ network });
    }
    if (!(await this.isTrusted(facts, opts))) throw new MandateUntrustedError({ network });
    return facts;
  }

  async isTrusted(facts: MandateInstance, opts: CallOptions): Promise<boolean> {
    if (!this.trusted().includes(facts.factory)) return false;
    const factory = await this.factory(facts.factory, opts);
    return (
      factory !== null &&
      factory.wasmHash === facts.wasmHash &&
      factory.feeAddress === facts.feeAddress &&
      factory.assets.includes(facts.asset)
    );
  }

  /** Whether `factory` is trusted and live on this network. */
  async isTrustedFactory(factory: string, opts: CallOptions): Promise<boolean> {
    return this.trusted().includes(factory) && (await this.factory(factory, opts)) !== null;
  }

  factory(address: string, opts: CallOptions): Promise<FactoryFacts | null> {
    let facts = this.#factories.get(address);
    if (facts === undefined) {
      facts = this.#readFactory(address, opts);
      this.#factories.set(address, facts);
      // A failed read is not a fact about the factory, so it is not kept.
      facts.catch(() => this.#factories.delete(address));
    }
    return facts;
  }

  async #readFactory(address: string, opts: CallOptions): Promise<FactoryFacts | null> {
    const instance = await this.#instance(address, 'factory', opts);
    if (instance === null) return null;
    const wasm = stored(instance, 'MandateWasm');
    const fee = stored(instance, 'FeeAddress');
    const assets = stored(instance, 'Assets');
    if (wasm === undefined || fee === undefined || assets === undefined) return null;
    return {
      wasmHash: asBytes32(wasm).slice(2),
      feeAddress: asAddress(fee),
      assets: asVec(assets).map(asAddress),
    };
  }

  async #instance(
    contract: string,
    fieldName: string,
    opts: CallOptions,
  ): Promise<Instance | null> {
    let key: string;
    try {
      key = instanceKey(contract).toXdr('base64');
    } catch {
      throw new InvalidInputError({ network: this.network, issues: [`${fieldName} (invalid)`] });
    }
    const { entries } = await this.rpc.getLedgerEntries([key], opts);
    const entry = entries.find((e) => e.key === key);
    return entry === undefined ? null : decodeInstance(entry.xdr);
  }
}
