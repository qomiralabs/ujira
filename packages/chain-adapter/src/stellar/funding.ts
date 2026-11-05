// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Where a principal funds a mandate, and which deposits count, for whom. Anyone
// can emit an event shaped like a transfer, and anyone can send a token to any
// address, so nothing an event says about itself decides whose money it is. The
// asset is the contract the ledger recorded as its source, and the tenant comes
// only from looking up the address the transfer went to. That lookup is then
// checked against the chain: a contract counts as a mandate only by its
// registration, and only for the tenant its tag was computed for. A deposit that
// fails this is credited to no one and raises an alert, because a wrong credit
// here is money shown to the wrong principal.

import { scValToNative, xdr } from '@stellar/stellar-sdk/base';
import { tokenAmount } from '@ujira/core';

import type { StellarNetworkConfig } from '../config.js';
import { ChainUnavailableError, InvalidInputError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type {
  AdapterPorts,
  CallOptions,
  ChainAddress,
  Deposit,
  DepositScanPage,
  DepositScanRequest,
  ForwardingRoute,
  FundingInstructions,
  MandateRef,
  PrepareFundingRequest,
  SigningRequest,
  TenantScope,
  UnixSeconds,
  WatchedMandate,
} from '../types.js';
import type { Invocation } from './calls.js';
import { eventPositionOf, stellarTenantTag } from './events.js';
import type { RpcEvent, StellarRpc } from './rpc.js';
import { address, asAddress, i128, sym } from './scval.js';
import type { MandateInstance } from './trust.js';

const LABEL = 'Stellar contract address, fund from your wallet';
const CURSOR_PREFIX = 'stellar:v1:';
const MAX_LIMIT = 1000;
const TOKEN_SCALE = 7;

export interface FundingContext {
  readonly network: StellarNetworkId;
  readonly rpc: StellarRpc;
  readonly ports: AdapterPorts;
  readonly config: () => StellarNetworkConfig;
  readonly verify: (
    scope: TenantScope,
    mandate: MandateRef,
    opts: CallOptions,
  ) => Promise<MandateInstance>;
  readonly prepare: (
    call: {
      readonly scope: TenantScope;
      readonly mandate: MandateRef;
      readonly op: 'fund';
      readonly inv: Invocation;
      readonly signer: string;
      readonly target: string;
      readonly payoutId: null;
      readonly amount: PrepareFundingRequest['amount'];
    },
    opts: CallOptions,
  ) => Promise<SigningRequest>;
}

interface Transfer {
  readonly raw: RpcEvent;
  readonly from: string | null;
  readonly to: string;
  readonly amount: bigint;
}

function addressOr(value: xdr.ScVal): string | null {
  try {
    return asAddress(value);
  } catch {
    return null;
  }
}

/**
 * The amount from a transfer's data: a bare i128, or a map holding it with the
 * destination's muxed id beside it. Taken through the SDK, so nothing a token
 * writes here can reach a float.
 */
function amountOf(value: xdr.ScVal): bigint | null {
  const native: unknown = scValToNative(value);
  if (typeof native === 'bigint') return native;
  if (native !== null && typeof native === 'object' && 'amount' in native) {
    return typeof native.amount === 'bigint' ? native.amount : null;
  }
  return null;
}

/**
 * A transfer from a successful contract event, or null for anything else. A
 * token can write what it likes, so a bad event only ever skips itself.
 */
function transferOf(raw: RpcEvent): Transfer | null {
  if (raw.type !== 'contract' || !raw.inSuccessfulContractCall) return null;
  try {
    const [name, from, to] = raw.topic.map((topic) => xdr.ScVal.fromXdr(topic, 'base64'));
    if (name?.type !== 'scvSymbol' || name.sym.toString() !== 'transfer') return null;
    if (from === undefined || to === undefined) return null;
    const recipient = addressOr(to);
    const amount = amountOf(xdr.ScVal.fromXdr(raw.value, 'base64'));
    if (recipient === null || amount === null || amount <= 0n) return null;
    return { raw, from: addressOr(from), to: recipient, amount };
  } catch {
    return null;
  }
}

export class StellarFunding {
  readonly #c: FundingContext;

  constructor(context: FundingContext) {
    this.#c = context;
  }

  async fundingInstructions(
    req: { readonly scope: TenantScope; readonly mandate: MandateRef },
    opts: CallOptions,
  ): Promise<FundingInstructions> {
    const { network } = this.#c;
    const config = this.#c.config();
    const instance = await this.#c.verify(req.scope, req.mandate, opts);
    return {
      mandate: req.mandate,
      address: { network, value: instance.address },
      asset: 'USDC',
      assetContract: config.assets.USDC.sac,
      assetIssuer: config.assets.USDC.issuer,
      label: LABEL,
      memoRequired: false,
      warnings: [
        'other_assets_not_credited',
        'wrong_network_lost',
        'exchange_contract_address_support',
      ],
      availableAt: config.deposits.availableAt,
    };
  }

  /** A transfer into the mandate that the principal signs and UJIRA's sponsor pays for. */
  async prepareFunding(req: PrepareFundingRequest, opts: CallOptions): Promise<SigningRequest> {
    const { network } = this.#c;
    const config = this.#c.config();
    const instance = await this.#c.verify(req.scope, req.mandate, opts);
    if (req.from.network !== network) {
      throw new InvalidInputError({ network, issues: ['from.network (mismatch)'] });
    }
    if (req.amount.amount < 1n) {
      throw new InvalidInputError({ network, issues: ['amount (not_positive)'] });
    }
    const inv: Invocation = {
      contract: config.assets.USDC.sac,
      fn: 'transfer',
      args: [
        address('from', req.from.value),
        address('to', instance.address),
        i128('amount', req.amount.amount),
      ],
    };
    return this.#c.prepare(
      {
        scope: req.scope,
        mandate: req.mandate,
        op: 'fund',
        inv,
        signer: req.from.value,
        target: instance.address,
        payoutId: null,
        amount: req.amount,
      },
      opts,
    );
  }

  async scanDeposits(req: DepositScanRequest, opts: CallOptions): Promise<DepositScanPage> {
    const { network, rpc } = this.#c;
    if (!Number.isSafeInteger(req.limit) || req.limit < 1 || req.limit > MAX_LIMIT) {
      throw new InvalidInputError({ network, issues: ['limit (invalid)'] });
    }
    const position = this.#position(req.cursor);
    const page = await rpc.getEvents(
      {
        ...position,
        limit: req.limit,
        filter: { topics: [[sym('transfer').toXdr('base64'), '*', '*', '**']] },
      },
      opts,
    );
    const deposits: Deposit[] = [];
    const seen = new Set<string>();
    // One lookup per address on a page, however many transfers it received.
    const lookups = new Map<string, Promise<Attribution | null>>();
    for (const raw of page.events) {
      const transfer = transferOf(raw);
      if (transfer === null || seen.has(raw.id)) continue;
      seen.add(raw.id);
      let lookup = lookups.get(transfer.to);
      if (lookup === undefined) {
        lookup = this.#attribute(req, transfer.to, opts);
        lookups.set(transfer.to, lookup);
      }
      const attribution = await lookup;
      if (attribution !== null) deposits.push(this.#deposit(transfer, attribution));
    }
    const head = BigInt(page.latestLedger);
    return {
      deposits,
      // With no cursor from the node this stays where it was. Reading a range again
      // only repeats deposits, which the unique key drops. Moving on could lose one.
      nextCursor:
        page.cursor === null ? this.#cursorText(position) : `${CURSOR_PREFIX}cursor:${page.cursor}`,
      // A closed ledger is final on this network, so nothing is ever reorganized.
      head: { ledgerOrBlock: head, safe: head, final: head },
      reorged: [],
    };
  }

  #position(cursor: string | null): { startLedger: number } | { cursor: string } {
    const { network } = this.#c;
    if (cursor === null) return { startLedger: this.#c.config().deposits.startLedger };
    const rest = cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : null;
    if (rest?.startsWith('cursor:') === true && rest.length > 'cursor:'.length) {
      return { cursor: rest.slice('cursor:'.length) };
    }
    const ledger = rest?.startsWith('ledger:') === true ? rest.slice('ledger:'.length) : '';
    if (!/^\d{1,15}$/.test(ledger)) {
      throw new InvalidInputError({ network, issues: ['cursor (invalid)'] });
    }
    return { startLedger: Number(ledger) };
  }

  #cursorText(position: { startLedger: number } | { cursor: string }): string {
    return 'cursor' in position
      ? `${CURSOR_PREFIX}cursor:${position.cursor}`
      : `${CURSOR_PREFIX}ledger:${String(position.startLedger)}`;
  }

  /**
   * Whose this address is, once the chain agrees. The lookup names a tenant, and
   * its answer is believed only for the address asked about and only when the
   * mandate it names is registered, unflagged and tagged for that very tenant.
   */
  async #attribute(
    req: DepositScanRequest,
    to: string,
    opts: CallOptions,
  ): Promise<Attribution | null> {
    const { network, ports } = this.#c;
    const asked: ChainAddress = { network, value: to };
    const watched = await req.isWatched(asked);
    if (watched === null) return null;
    const mandate = watched.mandate.address.value;
    const forwarding = watched.forwarding ?? null;
    const claimsAddress =
      forwarding === null
        ? mandate === to
        : forwarding.forwarder === to && forwarding.mandate === mandate;
    const registration = await ports.registry.registered(network, mandate, opts);
    const factories: readonly string[] = this.#c.config().trustedFactories['1'];
    if (
      claimsAddress &&
      watched.mandate.network === network &&
      registration !== null &&
      !registration.flagged &&
      factories.includes(registration.factory) &&
      registration.tenantTag === stellarTenantTag(watched.scope, mandate)
    ) {
      return { watched, forwarding };
    }
    ports.alerts.divergence({
      network,
      kind: 'balance',
      detail: 'deposit_not_attributed',
      correlationId: opts.correlationId,
    });
    return null;
  }

  #deposit(transfer: Transfer, { watched, forwarding }: Attribution): Deposit {
    const { network } = this.#c;
    const { raw } = transfer;
    const config = this.#c.config();
    const usdc = raw.contractId === config.assets.USDC.sac;
    const { operationId, eventIndex } = eventPositionOf(network, raw);
    const closedAt = Date.parse(raw.ledgerClosedAt);
    if (Number.isNaN(closedAt)) throw new ChainUnavailableError({ network });
    const amount = usdc
      ? tokenAmount(transfer.amount, 'USDC', 'stellar')
      : { amount: transfer.amount, scale: TOKEN_SCALE };
    return {
      scope: watched.scope,
      mandate: watched.mandate,
      txHash: raw.txHash,
      eventIndex: Number(eventIndex),
      from: transfer.from === null ? null : { network, value: transfer.from },
      asset: usdc ? 'USDC' : 'other',
      tokenContract: raw.contractId,
      amount,
      ledgerOrBlock: BigInt(raw.ledger),
      blockHash: null,
      closedAt: BigInt(Math.floor(closedAt / 1000)) as UnixSeconds,
      finality: 'final',
      operationId,
      // Only USDC is swept. Anything else on a forwarding account stays reported
      // as other, for the principal to recover.
      ...(forwarding === null || !usdc ? {} : { forwarding }),
    };
  }
}

interface Attribution {
  readonly watched: WatchedMandate;
  readonly forwarding: ForwardingRoute | null;
}
