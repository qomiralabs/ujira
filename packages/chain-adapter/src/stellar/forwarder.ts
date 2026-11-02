// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A forwarding account: a classic Stellar account the principal alone
// controls, for exchanges and on-ramps that cannot send to a contract. UJIRA
// pays its reserves and is never a signer, because a classic signer cannot
// be limited by destination and would amount to custody. So only a public
// key ever enters this flow, the secret stays in the principal's wallet, and
// the account is read back from the chain after creation: any shape but the
// one expected is refused and flagged.

import { Account, Asset, Operation, TransactionBuilder, xdr } from '@stellar/stellar-base';
import type { Transaction } from '@stellar/stellar-base';
import { z } from 'zod';

import { checkNetwork, networkPassphrase } from '../codecs/network.js';
import {
  STRKEY_VERSION,
  encodeStrkey,
  isAccountAddress,
  isContractAddress,
} from '../codecs/strkey.js';
import { bytes, readXdr } from '../codecs/xdr.js';
import {
  ChainUnavailableError,
  InvalidInputError,
  RpcTimeoutError,
  SignedPayloadMismatchError,
  isChainAdapterError,
} from '../errors.js';
import { NETWORK_IDS } from '../networks.js';
import type { StellarNetworkId } from '../networks.js';
import type { ChainAddress, TenantScope } from '../types.js';

/** Shown beside the mandate address, which an exchange cannot send to. */
export const CONTRACT_ADDRESS_LABEL = 'Stellar contract address, fund from your wallet';

const U32_MAX = 4_294_967_295n;
const U64_MAX = (1n << 64n) - 1n;
// The built transaction takes the next sequence number, which must still fit.
const MAX_SEQUENCE = (1n << 63n) - 2n;
const MIN_FEE_PER_OPERATION = 100n;
const OPERATIONS = 4n;
const MAX_ISSUES = 10;
const MAX_CONFIRM_TIMEOUT_MS = 120_000;
const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;
const TX_HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const networkSchema = z.enum(NETWORK_IDS);
const accountSchema = z.string().refine(isAccountAddress);
const assetSchema = z.strictObject({
  code: z.string().regex(ASSET_CODE),
  issuer: accountSchema,
});

export interface ForwarderAsset {
  readonly code: string;
  readonly issuer: string;
}

const requestSchema = z.strictObject({ network: networkSchema, publicKey: accountSchema });

export type ForwarderRequest = z.infer<typeof requestSchema>;

const creationSchema = z
  .strictObject({
    network: networkSchema,
    sponsor: accountSchema,
    sponsorSequence: z.bigint().min(0n).max(MAX_SEQUENCE),
    forwarder: accountSchema,
    asset: assetSchema,
    feePerOperation: z
      .bigint()
      .min(MIN_FEE_PER_OPERATION)
      .max(U32_MAX / OPERATIONS),
    timeBounds: z
      .strictObject({
        minTime: z.bigint().min(0n).max(U64_MAX),
        maxTime: z.bigint().min(1n).max(U64_MAX),
      })
      .refine((bounds) => bounds.minTime <= bounds.maxTime),
  })
  .refine((input) => input.sponsor !== input.forwarder, { path: ['forwarder'] });

/** What the creation transaction is built from. A public key, never a secret. */
export interface ForwarderCreationInput {
  readonly network: StellarNetworkId;
  /** UJIRA's sponsor account: the transaction source, which pays. */
  readonly sponsor: string;
  /** The sponsor's current sequence number; the transaction uses the next one. */
  readonly sponsorSequence: bigint;
  /** The public key the principal's wallet generated, the new account. */
  readonly forwarder: string;
  /** The settlement asset the account gets a trustline to. */
  readonly asset: ForwarderAsset;
  readonly feePerOperation: bigint;
  /** Unix seconds. Always has an upper bound. */
  readonly timeBounds: { readonly minTime: bigint; readonly maxTime: bigint };
}

export interface ForwarderExpectation {
  readonly sponsor: string;
  readonly forwarder: string;
  readonly asset: ForwarderAsset;
}

// zod messages can quote what they were given, and a secret pasted into the
// wrong field is exactly what this refuses, so only paths and codes are kept.
function parsed<T>(schema: z.ZodType<T>, value: unknown, root: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new InvalidInputError({
    issues: result.error.issues
      .slice(0, MAX_ISSUES)
      .map((issue) => `${[root, ...issue.path.map(String)].join('.')} (${issue.code})`),
  });
}

/**
 * Validates a request to set up a forwarding account. It takes the wallet's
 * public key and nothing else, so no secret has a way in.
 */
export function parseForwarderRequest(body: unknown): ForwarderRequest {
  return Object.freeze(parsed(requestSchema, body, 'request'));
}

/**
 * The one transaction that creates the account, as unsigned base64 XDR:
 * begin sponsoring, create the account with no balance, trust the asset, end
 * sponsoring. Signed by UJIRA's sponsor and by the new account, so the
 * principal needs no XLM.
 */
export function buildForwarderCreation(input: ForwarderCreationInput): string {
  const read = parsed(creationSchema, input, 'input');
  const tx = new TransactionBuilder(new Account(read.sponsor, read.sponsorSequence.toString()), {
    fee: read.feePerOperation.toString(),
    networkPassphrase: networkPassphrase(read.network),
    timebounds: {
      minTime: read.timeBounds.minTime.toString(),
      maxTime: read.timeBounds.maxTime.toString(),
    },
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        source: read.sponsor,
        sponsoredId: read.forwarder,
      }),
    )
    .addOperation(
      Operation.createAccount({
        source: read.sponsor,
        destination: read.forwarder,
        startingBalance: '0',
      }),
    )
    .addOperation(
      Operation.changeTrust({
        source: read.forwarder,
        asset: new Asset(read.asset.code, read.asset.issuer),
      }),
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: read.forwarder }))
    .build();
  const text = tx.toEnvelope().toXDR('base64');
  checkForwarderCreation(text, { ...read });
  return text;
}

function mismatch(network: StellarNetworkId): SignedPayloadMismatchError {
  return new SignedPayloadMismatchError({ network });
}

function isExactCreation(tx: Transaction, want: ForwarderExpectation): boolean {
  if (tx.source !== want.sponsor || tx.operations.length !== 4) return false;
  const [begin, create, trust, end] = tx.operations;
  if (begin?.type !== 'beginSponsoringFutureReserves') return false;
  if (begin.source !== want.sponsor || begin.sponsoredId !== want.forwarder) return false;
  if (create?.type !== 'createAccount') return false;
  if (create.source !== want.sponsor || create.destination !== want.forwarder) return false;
  if (Number(create.startingBalance) !== 0) return false;
  if (trust?.type !== 'changeTrust' || trust.source !== want.forwarder) return false;
  const line = trust.line;
  if (!(line instanceof Asset)) return false;
  if (line.getCode() !== want.asset.code || line.getIssuer() !== want.asset.issuer) return false;
  return end?.type === 'endSponsoringFutureReserves' && end.source === want.forwarder;
}

/**
 * Run before the sponsor signs, on the envelope as it came back from the
 * wallet. The sponsor's signature spends UJIRA's reserves on whatever the
 * envelope says, so it must be exactly the four operations for this account
 * and asset. An operation adding a signer, or any other extra, throws
 * SignedPayloadMismatchError.
 */
export function checkForwarderCreation(
  envelopeXdr: string,
  expected: ForwarderExpectation & { readonly network: StellarNetworkId },
): void {
  const network = checkNetwork(expected.network) as StellarNetworkId;
  const envelope = readXdr(envelopeXdr, 'xdr', (input) =>
    xdr.TransactionEnvelope.fromXDR(input, 'base64'),
  );
  if (envelope.switch().name !== 'envelopeTypeTx') throw mismatch(network);
  const tx = TransactionBuilder.fromXDR(envelope, networkPassphrase(network)) as Transaction;
  if (!isExactCreation(tx, expected)) throw mismatch(network);
}

/** An account and its trustline as the chain holds them, as plain data. */
export interface ForwarderAccountView {
  readonly account: string;
  readonly masterWeight: number;
  readonly thresholds: { readonly low: number; readonly medium: number; readonly high: number };
  /** Signers other than the master key. */
  readonly extraSigners: number;
  /** The account paying this entry's reserve, or null when it pays its own. */
  readonly sponsor: string | null;
  readonly trustline: {
    readonly account: string;
    /** Null for a line that is not a credit asset. */
    readonly asset: ForwarderAsset | null;
    readonly sponsor: string | null;
  } | null;
}

function publicKeyText(key: xdr.PublicKey): string {
  return encodeStrkey(STRKEY_VERSION.account, bytes(key.ed25519()));
}

function sponsorOf(entry: xdr.LedgerEntry): string | null {
  const ext = entry.ext();
  if (ext.switch() !== 1) return null;
  // An absent optional reads as null or undefined, whatever the declarations say.
  const id = ext.v1().sponsoringId() as unknown as xdr.PublicKey | null | undefined;
  return id === null || id === undefined ? null : publicKeyText(id);
}

function readEntry(text: string, field: string): xdr.LedgerEntry {
  return readXdr(text, field, (input) => xdr.LedgerEntry.fromXDR(input, 'base64'));
}

function wrongEntry(field: string): InvalidInputError {
  return new InvalidInputError({ issues: [`${field} (wrong_entry)`] });
}

function assetOf(line: xdr.TrustLineAsset): ForwarderAsset | null {
  const kind = line.switch().name;
  if (kind !== 'assetTypeCreditAlphanum4' && kind !== 'assetTypeCreditAlphanum12') return null;
  const credit = kind === 'assetTypeCreditAlphanum4' ? line.alphaNum4() : line.alphaNum12();
  return {
    code: credit.assetCode().toString('latin1').replace(/\0+$/, ''),
    issuer: publicKeyText(credit.issuer()),
  };
}

/**
 * Reads the account's and the trustline's LedgerEntry, as base64 XDR, into
 * plain data. Throws InvalidInputError for text that is not that entry.
 */
export function readForwarderAccount(
  accountEntryXdr: string,
  trustlineEntryXdr: string | null,
): ForwarderAccountView {
  const entry = readEntry(accountEntryXdr, 'account');
  const data = entry.data();
  if (data.switch().name !== 'account') throw wrongEntry('account');
  const account = data.account();
  const thresholds = account.thresholds();
  let trustline: ForwarderAccountView['trustline'] = null;
  if (trustlineEntryXdr !== null) {
    const lineEntry = readEntry(trustlineEntryXdr, 'trustline');
    const lineData = lineEntry.data();
    if (lineData.switch().name !== 'trustline') throw wrongEntry('trustline');
    const line = lineData.trustLine();
    trustline = {
      account: publicKeyText(line.accountId()),
      asset: assetOf(line.asset()),
      sponsor: sponsorOf(lineEntry),
    };
  }
  return Object.freeze({
    account: publicKeyText(account.accountId()),
    masterWeight: thresholds[0] ?? 0,
    thresholds: {
      low: thresholds[1] ?? 0,
      medium: thresholds[2] ?? 0,
      high: thresholds[3] ?? 0,
    },
    extraSigners: account.signers().length,
    sponsor: sponsorOf(entry),
    trustline,
  });
}

export type ForwarderFault =
  | 'wrong_account'
  | 'master_weight'
  | 'thresholds'
  | 'extra_signer'
  | 'account_sponsor'
  | 'trustline_missing'
  | 'trustline_asset'
  | 'trustline_sponsor';

/**
 * Everything wrong with an account, or nothing for the one good shape: the
 * principal's key alone at weight 1, default thresholds, no other signer,
 * and UJIRA's sponsor paying the reserves of the account and its trustline.
 * Any extra signer is a fault whoever it is. UJIRA's own would be custody.
 */
export function forwarderFaults(
  view: ForwarderAccountView,
  expected: ForwarderExpectation,
): readonly ForwarderFault[] {
  const faults: ForwarderFault[] = [];
  if (view.account !== expected.forwarder) faults.push('wrong_account');
  if (view.masterWeight !== 1) faults.push('master_weight');
  const { low, medium, high } = view.thresholds;
  if (low !== 0 || medium !== 0 || high !== 0) faults.push('thresholds');
  if (view.extraSigners !== 0) faults.push('extra_signer');
  if (view.sponsor !== expected.sponsor) faults.push('account_sponsor');
  const line = view.trustline;
  if (line === null) {
    faults.push('trustline_missing');
    return faults;
  }
  if (
    line.account !== expected.forwarder ||
    line.asset?.code !== expected.asset.code ||
    line.asset.issuer !== expected.asset.issuer
  ) {
    faults.push('trustline_asset');
  }
  if (line.sponsor !== expected.sponsor) faults.push('trustline_sponsor');
  return faults;
}

/** One forwarding account as stored. Tenant on the row. */
export interface ForwarderRecord {
  readonly principalId: string;
  readonly projectId: string;
  readonly network: StellarNetworkId;
  readonly address: string;
  readonly sponsor: string;
  readonly sponsorTxHash: string;
  readonly status: 'active' | 'rejected';
  readonly faults: readonly ForwarderFault[];
}

export interface ForwarderPorts {
  /** Reads the LedgerEntry XDR of the account and its trustline; null where there is none. */
  readonly reader: {
    readEntries(
      req: {
        readonly network: StellarNetworkId;
        readonly address: string;
        readonly asset: ForwarderAsset;
      },
      signal: AbortSignal,
    ): Promise<{ readonly account: string | null; readonly trustline: string | null }>;
  };
  /** Keeps one row per principal, project and network. */
  readonly store: { record(row: ForwarderRecord): Promise<void> };
  /** Raised for a human to look at. Names the tenant and the faults, never a key. */
  readonly flags: {
    flag(event: {
      readonly principalId: string;
      readonly projectId: string;
      readonly network: StellarNetworkId;
      readonly faults: readonly ForwarderFault[];
    }): void;
  };
}

const confirmSchema = z.strictObject({
  scope: z.strictObject({ principalId: z.string().regex(UUID), projectId: z.string().regex(UUID) }),
  network: networkSchema,
  sponsor: accountSchema,
  forwarder: accountSchema,
  asset: assetSchema,
  sponsorTxHash: z.string().regex(TX_HASH),
  timeoutMs: z.int().min(1).max(MAX_CONFIRM_TIMEOUT_MS),
});

export interface ConfirmForwarderRequest extends ForwarderExpectation {
  readonly scope: TenantScope;
  readonly network: StellarNetworkId;
  /** The transaction that created the account. */
  readonly sponsorTxHash: string;
  /** How long to wait for the read, in whole milliseconds. */
  readonly timeoutMs: number;
}

async function readWithDeadline(
  read: z.infer<typeof confirmSchema>,
  ports: ForwarderPorts,
): Promise<{ readonly account: string | null; readonly trustline: string | null }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RpcTimeoutError({ network: read.network, landed: 'no' }));
    }, read.timeoutMs);
  });
  try {
    return await Promise.race([
      ports.reader.readEntries(
        { network: read.network, address: read.forwarder, asset: read.asset },
        controller.signal,
      ),
      deadline,
    ]);
  } catch (err) {
    if (isChainAdapterError(err)) throw err;
    throw new ChainUnavailableError({ network: read.network, cause: err });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * After creation, reads the account back and records what it found. A good
 * account is recorded active. Any other shape is recorded rejected and
 * flagged, and comes back so the caller can refuse to offer it. An account
 * the chain does not hold throws InvalidInputError with nothing recorded,
 * since nothing was created to judge.
 */
export async function confirmForwarder(
  req: ConfirmForwarderRequest,
  ports: ForwarderPorts,
): Promise<ForwarderRecord> {
  const read = parsed(confirmSchema, req, 'request');
  const entries = await readWithDeadline(read, ports);
  if (entries.account === null) {
    throw new InvalidInputError({ network: read.network, issues: ['forwarder (not_found)'] });
  }
  const faults = forwarderFaults(readForwarderAccount(entries.account, entries.trustline), read);
  const { principalId, projectId } = read.scope;
  const row: ForwarderRecord = Object.freeze({
    principalId,
    projectId,
    network: read.network,
    address: read.forwarder,
    sponsor: read.sponsor,
    sponsorTxHash: read.sponsorTxHash,
    status: faults.length === 0 ? 'active' : 'rejected',
    faults,
  });
  await ports.store.record(row);
  if (faults.length > 0) {
    ports.flags.flag({ principalId, projectId, network: read.network, faults });
  }
  return row;
}

const viewSchema = z.strictObject({
  network: networkSchema,
  mandate: z.string().refine(isContractAddress),
  forwarder: accountSchema.nullable(),
});

export interface StellarFundingView {
  /** What to give an exchange or on-ramp. Null until a forwarding account exists. */
  readonly exchangeDeposit: ChainAddress | null;
  /** The mandate itself, only ever for funding from a wallet. */
  readonly walletFunding: { readonly address: ChainAddress; readonly label: string };
}

/**
 * The addresses to show a principal. An exchange cannot send to a contract,
 * so the mandate is never the exchange address, even when no forwarding
 * account exists yet: then there simply is none to offer.
 */
export function stellarFundingView(input: {
  readonly network: StellarNetworkId;
  readonly mandate: string;
  readonly forwarder: string | null;
}): StellarFundingView {
  const { network, mandate, forwarder } = parsed(viewSchema, input, 'view');
  return Object.freeze({
    exchangeDeposit: forwarder === null ? null : { network, value: forwarder },
    walletFunding: {
      address: { network, value: mandate },
      label: CONTRACT_ADDRESS_LABEL,
    },
  });
}
