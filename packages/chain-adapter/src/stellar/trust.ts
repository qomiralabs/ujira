// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Whether a contract is a mandate. It cannot prove who deployed it: its
// constructor takes the factory as an argument, and anyone can deploy the same
// code with no signature from the principal it names, storing a trusted
// factory, that factory's fee address and a supported asset. So nothing it
// stores or runs is a reason to trust it. It is trusted only when it was
// registered from a trusted factory's mandate_created. A direct deploy never
// gets one, which is what tells the two apart. The stored facts are still
// compared, since a mandate that disagrees with its factory is wrong either
// way, but passing them proves nothing. Factory facts are fixed for the
// factory's life, so they are read once and kept.

import { Address, xdr } from '@stellar/stellar-sdk/base';

import {
  InternalError,
  InvalidInputError,
  MandatePendingError,
  MandateUntrustedError,
  TenantMismatchError,
} from '../errors.js';
import type { NetworkId } from '../networks.js';
import { tenantRefOf, tenantTagOf } from '../tenant-ref.js';
import type {
  Bytes32,
  CallOptions,
  MandateRef,
  MandateRegistry,
  TenantScope,
  UnixSeconds,
} from '../types.js';
import { addressXdr } from './address-xdr.js';
import { approverEpochsOf } from './payout-views.js';
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
    private readonly registry: MandateRegistry,
    private readonly clock: { nowSeconds(): UnixSeconds },
    private readonly pendingMaxAgeSeconds: () => number,
  ) {}

  /**
   * Each approver's current epoch. The mandate's config view lists approvers without
   * their epochs, so this reads its storage, as verify does. A mandate that does not
   * hold roles the way this expects fails here rather than giving a count nobody can
   * trust, so call it only for a mandate that has been verified.
   */
  async approverEpochs(contract: string, opts: CallOptions): Promise<ReadonlyMap<string, number>> {
    const instance = await this.#instance(contract, 'mandate.address', opts);
    const roles = instance === null ? undefined : stored(instance, 'Roles');
    if (roles === undefined) throw new InternalError({ network: this.network });
    return approverEpochsOf(roles);
  }

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
    const tag = tenantTagOf(tenantRefOf(scope), addressXdr(mandate));
    if (facts.tenantTag !== tag) throw new TenantMismatchError({ network });
    const registration = await this.registry.registered(network, mandate, opts);
    if (registration === null) await this.#refuseIfPending(scope, mandate, opts);
    if (
      registration === null ||
      registration.flagged ||
      registration.tenantTag !== tag ||
      registration.factory !== facts.factory ||
      !(await this.#agreesWithFactory(facts, opts))
    ) {
      throw new MandateUntrustedError({ network });
    }
    return facts;
  }

  // A tenant's own recent claim makes this something to wait for. An old one does
  // not: a real create registers within minutes, so a contract still unregistered
  // after the limit is treated as what it most likely is, and a payout held on it
  // resolves. A registration arriving later still counts, since this reads no claim
  // once a contract is registered.
  async #refuseIfPending(scope: TenantScope, mandate: string, opts: CallOptions): Promise<void> {
    const { network } = this;
    const claimedAt = await this.registry.claimedAt(scope, network, mandate, opts);
    if (claimedAt === null) return;
    const age = this.clock.nowSeconds() - claimedAt;
    if (age <= BigInt(this.pendingMaxAgeSeconds())) throw new MandatePendingError({ network });
  }

  async #agreesWithFactory(facts: MandateInstance, opts: CallOptions): Promise<boolean> {
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
