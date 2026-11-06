// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The chain signer's policy, for the executor, fee sponsor and SEP-10 keys.
// Each key does one job and the payload must be that job exactly:
// - an executor calls execute or execute_batch on a mandate the index knows
//   with this executor in its executor role, with the fee under the cap;
// - an executor also carries a smart wallet's own signed call, under a payload
//   kind of its own. A wallet cannot be a transaction's source, so a fee bump has
//   nothing to wrap. The channel account authorizes nothing in it and can only
//   lose the fee, and each one needs a reservation, so the sponsor's limits hold;
// - an executor also restores and extends entries, under a kind of its own, since
//   that changes no contract's state and its cost is bounded by the fee cap;
// - the fee sponsor wraps a transaction the payouts worker reserved a
//   sponsorship for, or opens and activates an account through a reserve
//   sandwich of exactly the expected operations, again only with a
//   reservation, and never above either fee cap;
// - a SEP-10 key signs only a challenge from the anchor it logs in to.
// Anything else is refused before the backend is asked.

import { createHash } from 'node:crypto';

import { InvalidInputError } from '@ujira/chain-adapter';
import type {
  CallOptions,
  NetworkId,
  SignPayload,
  SignerRef,
  TenantScope,
} from '@ujira/chain-adapter';
import {
  decodeAuthEntry,
  decodeFeeBumpEnvelope,
  decodeTransactionEnvelope,
  invocationAuthEntries,
} from '@ujira/chain-adapter/codecs';
import type { DecodedOperation, DecodedTransaction } from '@ujira/chain-adapter/codecs';

import { deny } from './policy.js';
import type { PolicyContext, PolicyDecision, RefKind, ServicePolicy } from './policy.js';
import type { MandateIndex, SponsorshipIntent, SponsorshipLedger } from './ports.js';

/** The calls an executor exists to make. */
export const EXECUTOR_FUNCTIONS: ReadonlySet<string> = new Set(['execute', 'execute_batch']);
/** The longest a reserve sandwich may stay valid. */
export const MAX_SANDWICH_VALIDITY_SECONDS = 300n;
/** SEP-10 servers give challenges a 15 minute window. */
export const MAX_CHALLENGE_VALIDITY_SECONDS = 900n;

export interface Sep10Anchor {
  /** The anchor's SIGNING_KEY, the challenge source. */
  readonly serverAccount: string;
  readonly homeDomain: string;
  readonly webAuthDomain: string;
}

export interface ChainNetworkPolicy {
  /** The most an executor transaction may pay, in stroops. */
  readonly executorMaxFeeStroops: bigint;
  /** The most the fee sponsor pays for one transaction, in stroops. */
  readonly sponsorMaxFeeStroops: bigint;
  /** The asset a reserve sandwich may add a trust line for. */
  readonly payoutAsset: { readonly code: string; readonly issuer: string };
  /** By anchor id. */
  readonly sep10: Readonly<Record<string, Sep10Anchor>>;
  /** Token contracts a wallet's own call may be relayed to, for funding a mandate. */
  readonly relayTokens?: readonly string[];
}

export interface ChainPolicyOptions {
  readonly networks: Partial<Readonly<Record<NetworkId, ChainNetworkPolicy>>>;
  readonly mandates: MandateIndex;
  readonly sponsorships: SponsorshipLedger;
}

const SANDWICH_INTENTS: ReadonlySet<SponsorshipIntent> = new Set([
  'create_funding_account',
  'recipient_activation',
]);

/**
 * What a principal's or agent's own transaction is reserved under. It is the
 * ledger's list, less what is not a transaction of theirs: an activation goes
 * through a sandwich, and an executor's own spend is never reserved at all.
 */
export const SIGNED_CALL_INTENTS: ReadonlySet<SponsorshipIntent> = new Set<SponsorshipIntent>([
  'fund',
  'create_mandate',
  'pause',
  'resume',
  'revoke',
  'approve',
  'reject',
  'cancel',
  'withdraw',
  'admin',
  'trustline',
]);

/** The decoded payload, with a codec refusal turned into a denial. */
function read<T>(ref: SignerRef, decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof InvalidInputError) throw deny(ref);
    throw error;
  }
}

/** The account an operation runs as. */
function sourceOf(op: DecodedOperation, tx: DecodedTransaction): string {
  return op.source?.account ?? tx.source.account;
}

export function chainPolicy(options: ChainPolicyOptions): ServicePolicy {
  const { mandates, sponsorships } = options;

  const network = (ref: SignerRef): ChainNetworkPolicy => {
    const found = options.networks[ref.network];
    if (found === undefined) throw deny(ref);
    return found;
  };

  const executorMandate = async (
    ref: SignerRef,
    contract: string,
    executor: string,
    opts: CallOptions,
  ): Promise<TenantScope> => {
    const mandate = await mandates.forExecutor(ref.network, contract, executor, opts);
    if (mandate === null) throw deny(ref);
    return mandate.tenant;
  };

  /**
   * A wallet's call carried by this channel. The channel must authorize nothing:
   * source account credentials would let the call spend as the channel, so every
   * entry has to be someone else's own signature. The reservation is what the
   * adapter wrote after matching the entry to the request it handed out, so this
   * key cannot be pointed at a call nobody asked for.
   */
  const relayedCall = async (
    ref: SignerRef,
    payload: Extract<SignPayload, { kind: 'stellar_relayed_call' }>,
    opts: CallOptions,
  ): Promise<TenantScope> => {
    const tx = read(ref, () => decodeTransactionEnvelope(payload.xdr, payload.network));
    const entries = read(ref, () => invocationAuthEntries(payload.xdr, payload.network));
    const [op] = tx.operations;
    const [entryXdr] = entries;
    if (
      tx.operations.length !== 1 ||
      op?.detail.kind !== 'invoke_contract' ||
      sourceOf(op, tx) !== tx.source.account ||
      entries.length !== 1 ||
      entryXdr === undefined
    ) {
      throw deny(ref);
    }
    const { contract, functionName } = op.detail;
    // Only the credentials and the call are read, so the ledger here is immaterial.
    const entry = read(ref, () => decodeAuthEntry(entryXdr, payload.network, 1));
    const call = entry.invocation;
    if (
      entry.credentials.kind !== 'address' ||
      !entry.credentials.signed ||
      entry.credentials.address === tx.source.account ||
      entry.credentials.address === tx.source.address ||
      call.kind !== 'contract_fn' ||
      call.contract !== contract ||
      call.functionName !== functionName
    ) {
      throw deny(ref);
    }
    // Keyed on the signed entry, since the channel's transaction is only built at
    // send time. The fee is bounded by the network's cap and not the reservation's:
    // the reservation was sized before the wallet's signature check was simulated.
    const row = await sponsorships.reserved(
      ref.network,
      createHash('sha256').update(Buffer.from(entryXdr, 'base64')).digest(),
      opts,
    );
    const limits = network(ref);
    if (
      row === null ||
      !SIGNED_CALL_INTENTS.has(row.intent) ||
      tx.fee > limits.sponsorMaxFeeStroops
    ) {
      throw deny(ref);
    }
    if (limits.relayTokens?.includes(contract) === true) return row.tenant;
    const mandate = await mandates.find(ref.network, contract, opts);
    if (
      mandate?.tenant.principalId !== row.tenant.principalId ||
      mandate.tenant.projectId !== row.tenant.projectId
    ) {
      throw deny(ref);
    }
    return row.tenant;
  };

  const footprint = (
    ref: SignerRef,
    payload: Extract<SignPayload, { kind: 'stellar_footprint' }>,
  ): void => {
    const tx = read(ref, () => decodeTransactionEnvelope(payload.xdr, payload.network));
    const [op] = tx.operations;
    if (
      tx.operations.length !== 1 ||
      (op?.detail.kind !== 'restore_footprint' && op?.detail.kind !== 'extend_footprint') ||
      sourceOf(op, tx) !== tx.source.account ||
      tx.fee > network(ref).executorMaxFeeStroops
    ) {
      throw deny(ref);
    }
  };

  const executor = async (
    ref: SignerRef,
    payload: SignPayload,
    opts: CallOptions,
  ): Promise<TenantScope | null> => {
    if (payload.kind === 'stellar_relayed_call') return relayedCall(ref, payload, opts);
    if (payload.kind === 'stellar_footprint') {
      footprint(ref, payload);
      return null;
    }
    if (payload.kind === 'stellar_tx') {
      const tx = read(ref, () => decodeTransactionEnvelope(payload.xdr, payload.network));
      // A Soroban transaction holds exactly one host function call.
      const [op] = tx.operations;
      if (
        tx.operations.length !== 1 ||
        op?.detail.kind !== 'invoke_contract' ||
        !EXECUTOR_FUNCTIONS.has(op.detail.functionName) ||
        sourceOf(op, tx) !== tx.source.account ||
        tx.fee > network(ref).executorMaxFeeStroops
      ) {
        throw deny(ref);
      }
      return executorMandate(ref, op.detail.contract, tx.source.account, opts);
    }
    if (payload.kind === 'stellar_auth_entry') {
      const entry = read(ref, () =>
        decodeAuthEntry(payload.entryXdr, payload.network, payload.expirationLedger),
      );
      const call = entry.invocation;
      // The executor authorizes the call itself and nothing nested in it.
      if (
        entry.credentials.kind !== 'address' ||
        call.kind !== 'contract_fn' ||
        !EXECUTOR_FUNCTIONS.has(call.functionName) ||
        call.subInvocations.length !== 0
      ) {
        throw deny(ref);
      }
      return executorMandate(ref, call.contract, entry.credentials.address, opts);
    }
    throw deny(ref);
  };

  const reservation = async (
    ref: SignerRef,
    hash: Uint8Array,
    intents: ReadonlySet<SponsorshipIntent>,
    fee: bigint,
    opts: CallOptions,
  ): Promise<TenantScope> => {
    const row = await sponsorships.reserved(ref.network, hash, opts);
    if (
      row === null ||
      !intents.has(row.intent) ||
      fee > row.maxFeeStroops ||
      fee > network(ref).sponsorMaxFeeStroops
    ) {
      throw deny(ref);
    }
    return row.tenant;
  };

  // Begin sponsoring X as the sponsor, optionally create X with nothing,
  // trust the payout asset as X, end sponsoring as X, and nothing else.
  const sandwich = (ref: SignerRef, tx: DecodedTransaction, now: bigint): void => {
    const sponsor = tx.source.account;
    const [begin, ...rest] = tx.operations;
    if (begin?.detail.kind !== 'begin_sponsoring' || sourceOf(begin, tx) !== sponsor) {
      throw deny(ref);
    }
    const sponsored = begin.detail.sponsoredId;
    const [first] = rest;
    const body = first?.detail.kind === 'create_account' ? rest : [undefined, ...rest];
    const [create, trust, end, ...extra] = body;
    const asset = network(ref).payoutAsset;
    const createOk =
      create === undefined ||
      (create.detail.kind === 'create_account' &&
        create.detail.destination === sponsored &&
        create.detail.startingBalance === 0n &&
        sourceOf(create, tx) === sponsor);
    const trustOk =
      trust?.detail.kind === 'change_trust' &&
      trust.detail.asset.kind === 'credit' &&
      trust.detail.asset.code === asset.code &&
      trust.detail.asset.issuer === asset.issuer &&
      sourceOf(trust, tx) === sponsored;
    const endOk = end?.detail.kind === 'end_sponsoring' && sourceOf(end, tx) === sponsored;
    // Valid now and for at most five more minutes, so a signed sandwich
    // that is not submitted soon is worth nothing.
    const bounds = tx.timeBounds;
    const timely =
      bounds !== null &&
      bounds.maxTime !== 0n &&
      now >= bounds.minTime &&
      now <= bounds.maxTime &&
      bounds.maxTime - now <= MAX_SANDWICH_VALIDITY_SECONDS;
    if (sponsored === sponsor || !createOk || !trustOk || !endOk || extra.length > 0 || !timely) {
      throw deny(ref);
    }
  };

  const sponsor = async (
    ref: SignerRef,
    payload: SignPayload,
    { opts, now }: PolicyContext,
  ): Promise<TenantScope> => {
    if (payload.kind === 'stellar_fee_bump') {
      const bump = read(ref, () => decodeFeeBumpEnvelope(payload.xdr, payload.network));
      return reservation(ref, bump.inner.hash, SIGNED_CALL_INTENTS, bump.fee, opts);
    }
    if (payload.kind === 'stellar_reserve_sandwich') {
      const tx = read(ref, () => decodeTransactionEnvelope(payload.xdr, payload.network));
      sandwich(ref, tx, now);
      return reservation(ref, tx.hash, SANDWICH_INTENTS, tx.fee, opts);
    }
    throw deny(ref);
  };

  const sep10 = (ref: SignerRef, payload: SignPayload, now: bigint): void => {
    if (ref.kind !== 'sep10' || payload.kind !== 'sep10_challenge') throw deny(ref);
    const anchor = network(ref).sep10[ref.anchorId];
    if (anchor === undefined) throw deny(ref);
    const tx = read(ref, () => decodeTransactionEnvelope(payload.xdr, payload.network));
    const [first, ...rest] = tx.operations;
    const bounds = tx.timeBounds;
    const named = (name: string, value: string) =>
      rest.filter(
        (op) =>
          op.detail.kind === 'manage_data' &&
          op.detail.name === name &&
          op.detail.value !== null &&
          Buffer.from(op.detail.value).toString('utf8') === value,
      ).length;
    if (
      tx.source.address !== anchor.serverAccount ||
      tx.sequence !== 0n ||
      bounds === null ||
      bounds.maxTime === 0n ||
      now < bounds.minTime ||
      now > bounds.maxTime ||
      bounds.maxTime - bounds.minTime > MAX_CHALLENGE_VALIDITY_SECONDS ||
      first?.detail.kind !== 'manage_data' ||
      first.detail.name !== `${anchor.homeDomain} auth` ||
      first.detail.value?.length !== 64 ||
      // Every later operation is the server's own manage data, one of them
      // naming the web auth domain.
      !rest.every(
        (op) => op.detail.kind === 'manage_data' && sourceOf(op, tx) === anchor.serverAccount,
      ) ||
      named('web_auth_domain', anchor.webAuthDomain) !== 1
    ) {
      throw deny(ref);
    }
  };

  return {
    refKinds: new Set<RefKind>(['executor', 'fee_sponsor', 'sep10']),
    async check(ref, payload, context: PolicyContext): Promise<PolicyDecision> {
      switch (ref.kind) {
        case 'executor':
          return { tenant: await executor(ref, payload, context.opts) };
        case 'fee_sponsor':
          return { tenant: await sponsor(ref, payload, context) };
        case 'sep10':
          sep10(ref, payload, context.now);
          return { tenant: null };
        default:
          throw deny(ref);
      }
    },
  };
}
