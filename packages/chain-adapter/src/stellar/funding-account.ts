// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The sponsored create_funding_account flow: a forwarding account the principal
// alone controls, with UJIRA paying the reserves and never a signer on it.
//
// The transaction is UJIRA's own, with the sponsor as its source, so unlike a
// mandate action it is not fee bumped. The wallet signs for the new account
// first, then the sponsor signs it as a reserve sandwich. The signer service
// checks that shape again, and finds the reservation by the transaction's hash,
// so that is what it is reserved under. Because every attempt then has its own
// reservation, it is the sponsorship policy's count of the principal's rows that
// holds a principal to one sponsored account per network, and its budget that
// holds the day to its limit.

import { Asset, Keypair, xdr } from '@stellar/stellar-base';

import {
  InvalidInputError,
  SignedPayloadMismatchError,
  SigningRequestExpiredError,
  SponsorDeniedError,
  SponsorUnfundedError,
  SubmissionRejectedError,
  SubmissionUnknownError,
  isChainAdapterError,
} from '../errors.js';
import type {
  FundingAccountFlow,
  FundingAccountRecord,
  FundingAccountStore,
} from '../funding-account.js';
import { reservationIdOf } from '../sponsorship/policy.js';
import type {
  AdapterPorts,
  CallOptions,
  NativeAmount,
  SubmissionRef,
  TenantScope,
  UnixSeconds,
} from '../types.js';
import type { StellarNetworkId } from '../networks.js';

import { sendAndRecord } from './executor.js';
import {
  buildForwarderCreation,
  checkForwarder,
  checkForwarderCreation,
  confirmForwarder,
  parseForwarderRequest,
  stellarFundingView,
} from './forwarder.js';
import type { ForwarderAsset, ForwarderFault, ForwarderPorts } from './forwarder.js';
import { FUNDING_ACCOUNT_RESERVES_STROOPS } from './lifecycle.js';
import type { SigningRequestStore, StoredSigningRequest } from './requests.js';
import type { RpcLedgerEntry, StellarRpc } from './rpc.js';
import {
  INCLUSION_FEE,
  accountKey,
  accountSequence,
  attach,
  parseEnvelope,
  signedBy,
  txHash,
  waitForTransaction,
} from './tx.js';
import type { WaitOptions } from './tx.js';

const OPERATIONS = 4n;
// The signer refuses a sandwich valid for longer, so a signed one that is not
// sent soon is worth nothing.
const VALIDITY_SECONDS = 300n;
const TESTNET: StellarNetworkId = 'stellar:testnet';

export interface FundingAccountFlowOptions {
  readonly network: StellarNetworkId;
  readonly rpc: StellarRpc;
  readonly ports: AdapterPorts;
  readonly requests: SigningRequestStore;
  readonly accounts: FundingAccountStore;
  /** Raised for a human to look at. Names the tenant and the faults, never a key. */
  readonly flags: {
    flag(event: {
      readonly principalId: string;
      readonly projectId: string;
      readonly network: StellarNetworkId;
      readonly faults: readonly ForwarderFault[];
    }): void;
  };
  readonly wait: WaitOptions;
  readonly submitTimeoutMs: number;
  readonly newRequestId: () => string;
}

function stroops(network: StellarNetworkId, amount: bigint): NativeAmount {
  return { network, asset: 'XLM', amount, scale: 7 };
}

function trustlineKey(address: string, asset: Asset): string {
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      asset: asset.toTrustLineXDRObject(),
    }),
  ).toXDR('base64');
}

// RPC gives an entry's data and its extension apart, and the sponsor is in the
// extension. A node that leaves it out reads as no sponsor, which the
// verification refuses, so what cannot be seen is never taken as good.
function ledgerEntryOf(entry: RpcLedgerEntry): string {
  return new xdr.LedgerEntry({
    lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq,
    data: xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64'),
    ext:
      entry.extXdr === undefined
        ? new xdr.LedgerEntryExt(0)
        : xdr.LedgerEntryExt.fromXDR(entry.extXdr, 'base64'),
  }).toXDR('base64');
}

/** The flow over one network. */
export function createFundingAccountFlow(options: FundingAccountFlowOptions): FundingAccountFlow {
  const { network, rpc, ports, requests, accounts, flags, wait } = options;
  const config = () => {
    const found = ports.config()[network];
    if (found === undefined)
      throw new InvalidInputError({ network, issues: ['network (invalid)'] });
    return found;
  };
  const sponsorOf = (): string => config().feeSponsor.key.address;
  const usdc = () => ({ code: 'USDC', issuer: config().assets.USDC.issuer });
  const fundingRequest = async (
    scope: TenantScope,
    requestId: string,
  ): Promise<NonNullable<Awaited<ReturnType<SigningRequestStore['load']>>>> => {
    const loaded = await requests.load(scope, requestId);
    if (loaded?.request.op !== 'create_funding_account') {
      throw new InvalidInputError({ network, issues: ['requestId (not_found)'] });
    }
    return loaded;
  };
  const reservationOf = (signed: string): string => {
    const tx = parseEnvelope(signed, network);
    return reservationIdOf(network, tx.hash());
  };
  // The principal's one account stays with the project that made it. Another
  // project may learn it cannot make a second, but is not given this one to use:
  // a deposit there would have to be attributed to a project that holds nothing.
  const ownAccount = async (scope: TenantScope): Promise<FundingAccountRecord | null> => {
    const known = await accounts.forPrincipal(scope, network);
    return known?.projectId === scope.projectId ? known : null;
  };

  const readerFor = (opts: CallOptions, asset: ForwarderAsset): ForwarderPorts['reader'] => ({
    async readEntries(entry, signal) {
      const accountId = accountKey(entry.address);
      const lineId = trustlineKey(entry.address, new Asset(asset.code, asset.issuer));
      const { entries } = await rpc.getLedgerEntries([accountId, lineId], {
        signal,
        correlationId: opts.correlationId,
      });
      const pick = (key: string): string | null => {
        const found = entries.find((e) => e.key === key);
        return found === undefined ? null : ledgerEntryOf(found);
      };
      return { account: pick(accountId), trustline: pick(lineId) };
    },
  });

  return {
    async prepare(req, opts) {
      const { publicKey } = parseForwarderRequest({ network, publicKey: req.publicKey });
      const { scope } = req;
      if (!req.businessVerified && network !== TESTNET) {
        throw new SponsorDeniedError({ network });
      }
      if ((await accounts.forPrincipal(scope, network)) !== null) {
        throw new SponsorDeniedError({ network });
      }
      if ((await accountSequence(rpc, publicKey, opts)) !== null) {
        throw new InvalidInputError({ network, issues: ['publicKey (account_exists)'] });
      }
      const sponsor = sponsorOf();
      const sequence = await accountSequence(rpc, sponsor, opts);
      if (sequence === null) throw new SponsorUnfundedError({ network });
      const validUntil = (ports.clock.nowSeconds() + VALIDITY_SECONDS) as UnixSeconds;
      const payload = buildForwarderCreation({
        network,
        sponsor,
        sponsorSequence: sequence,
        forwarder: publicKey,
        asset: usdc(),
        feePerOperation: INCLUSION_FEE,
        timeBounds: { minTime: 0n, maxTime: validUntil },
      });
      const summary = { action: 'create_funding_account', feePaidBy: 'ujira' } as const;
      const requestId = options.newRequestId();
      const stored: StoredSigningRequest = {
        requestId,
        scope,
        network,
        op: 'create_funding_account',
        mandate: null,
        payoutId: null,
        signer: publicKey,
        kind: 'stellar_transaction',
        payload,
        hostFunction: null,
        sequence: sequence + 1n,
        fee: FUNDING_ACCOUNT_RESERVES_STROOPS + INCLUSION_FEE * OPERATIONS,
        validUntil,
        summary,
      };
      await requests.save(stored);
      return {
        kind: 'stellar_transaction',
        network,
        xdr: payload,
        signer: { network, value: publicKey },
        validUntil,
        sponsored: true,
        summary,
        requestId,
      };
    },

    async submit(req, opts) {
      const loaded = await fundingRequest(req.scope, req.requestId);
      const answer = (use: NonNullable<typeof loaded.use>): SubmissionRef => {
        if (use.signed !== req.signed) throw new SignedPayloadMismatchError({ network });
        if (use.txHash === null) throw new SubmissionUnknownError({ network });
        return { network, txHash: use.txHash, finality: 'none' };
      };
      if (loaded.use !== null) return answer(loaded.use);
      const { request } = loaded;
      if (ports.clock.nowSeconds() > request.validUntil) {
        throw new SigningRequestExpiredError({ network });
      }
      const tx = parseEnvelope(req.signed, network);
      const built = parseEnvelope(request.payload, network);
      if (
        'innerTransaction' in tx ||
        'innerTransaction' in built ||
        tx.tx.toXdr('base64') !== built.tx.toXdr('base64') ||
        !signedBy(tx, request.signer)
      ) {
        throw new SignedPayloadMismatchError({ network });
      }
      const sponsor = sponsorOf();
      // The sponsor's signature spends its reserves on whatever this says, and
      // the config may have moved since it was built.
      checkForwarderCreation(req.signed, {
        network,
        sponsor,
        forwarder: request.signer,
        asset: usdc(),
      });
      // Read before the claim, because a failed read must leave nothing behind.
      // Any ledger from before the send proves the same thing to reconciliation.
      const submittedAtLedger = BigInt((await rpc.getLatestLedger(opts)).sequence);
      const earlier = await requests.claim(req.scope, request.requestId, req.signed);
      if (earlier !== null) return answer(earlier);
      const reservationId = reservationIdOf(network, tx.hash());
      await ports.sponsorship.reserve({
        scope: request.scope,
        network,
        reservationId,
        intent: 'create_funding_account',
        maxFee: stroops(network, request.fee),
      });
      try {
        const signature = await ports.signer.sign(
          { kind: 'fee_sponsor', network },
          { kind: 'stellar_reserve_sandwich', network, xdr: tx.toXdr() },
          opts,
        );
        attach(tx, sponsor, signature);
        const hash = txHash(tx);
        await requests.setTxHash(request.scope, request.requestId, hash);
        await ports.store.recordSubmission({
          scope: request.scope,
          network,
          txHash: hash,
          op: 'create_funding_account',
          mandate: null,
          payoutId: null,
          attempt: null,
          signerAddress: sponsor,
          sequenceOrNonce: BigInt(tx.sequence),
          maxTime: request.validUntil,
          state: 'built',
          landedAtHeight: null,
          errorCode: null,
          specCode: null,
          replacesTxHash: null,
          submittedAtLedger,
          reservationId,
          correlationId: req.correlationId,
          createdAt: ports.clock.nowSeconds(),
        });
        await sendAndRecord(
          { network, rpc, ports, wait, submitTimeoutMs: options.submitTimeoutMs },
          request.scope,
          hash,
          tx.toXdr(),
          request.validUntil,
          opts,
        );
        return { network, txHash: hash, finality: 'none' };
      } catch (error) {
        // Only an outcome that certainly sent nothing gives the slot back. One
        // that may have landed keeps it, or a principal could get two accounts.
        if (isChainAdapterError(error) && error.landed === 'no') {
          await ports.sponsorship.release({ scope: request.scope, reservationId });
        }
        throw error;
      }
    },

    async confirm(req, opts) {
      const { scope } = req;
      const { request, use } = await fundingRequest(scope, req.requestId);
      const known = await accounts.forPrincipal(scope, network);
      if (known !== null) return known;
      if (use?.txHash === null || use === null) {
        throw new InvalidInputError({ network, issues: ['requestId (not_submitted)'] });
      }
      const hash = use.txHash;
      const reservationId = reservationOf(use.signed);
      const landed = await waitForTransaction(rpc, network, hash, wait, opts);
      // The submission's state is left to reconciliation, which also picks up a
      // crash here. It may already have moved the record, and the store refuses a
      // second move, so writing it here too would fail a confirmation that is fine.
      if (landed.status !== 'SUCCESS') {
        // No account exists, so the principal may try again. The fee it burned
        // is too small to be worth a slot.
        await ports.sponsorship.release({ scope, reservationId });
        throw new SubmissionRejectedError({ network, landed: 'yes' });
      }
      const asset = usdc();
      const row = await confirmForwarder(
        {
          scope,
          network,
          sponsor: sponsorOf(),
          forwarder: request.signer,
          asset,
          sponsorTxHash: hash,
          timeoutMs: options.submitTimeoutMs,
        },
        { reader: readerFor(opts, asset), store: accounts, flags },
      );
      // Reserves are locked rather than burned, but the budget is for what the
      // sponsor gives up, so they are booked with the fee.
      await ports.sponsorship.settle({
        scope,
        reservationId,
        actualFee: stroops(network, request.fee),
      });
      return row;
    },

    async recheck(scope, opts) {
      const own = await ownAccount(scope);
      if (own === null || own.status === 'rejected') return own;
      const asset = usdc();
      const faults = await checkForwarder(
        {
          scope,
          network,
          sponsor: own.sponsor,
          forwarder: own.address,
          asset,
          sponsorTxHash: own.sponsorTxHash,
          timeoutMs: options.submitTimeoutMs,
        },
        { reader: readerFor(opts, asset) },
      );
      const status = faults.length === 0 ? 'active' : 'changed';
      if (status === own.status && faults.join() === own.faults.join()) return own;
      const row: FundingAccountRecord = { ...own, status, faults };
      // Raised before the write. If a crash falls between them the next read raises
      // it again, where the other order could lose it for good.
      if (faults.length > 0) {
        flags.flag({
          principalId: own.principalId,
          projectId: own.projectId,
          network,
          faults,
        });
      }
      await accounts.recordCheck(row);
      return row;
    },

    account: ownAccount,

    async fundingOptions({ scope, mandate }) {
      const own = await ownAccount(scope);
      return stellarFundingView({
        network,
        mandate,
        forwarder: own?.status === 'active' ? own.address : null,
      });
    },
  };
}
