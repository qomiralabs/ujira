// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A payout as the published contract shows it, from what the store read. The
// response schemas check every rule between the fields, so a stored payout these
// cannot describe truthfully fails as a 500 rather than reaching a client wrong.
//
// Until the fee tables are in, the take is the sum of the live attempt's leg
// fees, and the rate is the one the mandate agreed. Until approvals record the
// quorum on the attempt, the required count reads 0.

import { NetworkId, RAIL_IDS, toWireMoney, toWireToken } from '@ujira/api-schema';
import type {
  LegStatus,
  PayoutAccepted,
  PayoutDetail,
  PayoutListItem,
  PayoutMethod,
  PayoutStatus,
} from '@ujira/api-schema';
import { add, fiatCurrency, money, sum, tokenAmount } from '@ujira/core';
import type { Money, TokenAmount } from '@ujira/core';
import type { Payout, PayoutLeg, PayoutListing, PayoutView } from '@ujira/db';

import type { Tenant } from './auth.js';
import { ApiError } from './errors.js';

type WireLeg = PayoutDetail['legs'][number];
type WireNetwork = NetworkId;

/** What a paid payout's receipt is known by. */
export interface PayoutReceiptLink {
  readonly id: string;
  readonly receiptNumber: string;
  readonly receiptRef: string;
}

// Statuses reached only after the mandate executed the payout, as the contract
// lists them.
const EXECUTED: ReadonlySet<string> = new Set([
  'settling',
  'delivering',
  'partly_paid',
  'paid',
  'needs_attention',
]);

const QUEUED_REASONS: ReadonlySet<string> = new Set(['awaiting_funding', 'network_unavailable']);

const SETTLED_LEG: ReadonlySet<string> = new Set(['settled', 'delivering', 'delivered']);

// No leg records why it failed yet. A wallet leg cannot fail on its own, since
// all of an attempt's legs settle in one transaction or none do.
const UNRECORDED_FAILURE = 'not_recorded';

function iso(date: Date): string {
  return date.toISOString();
}

function isoOrNull(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function wireNetwork(network: string): WireNetwork {
  return NetworkId.parse(network);
}

/**
 * What the principal asked to pay, as money. A project whose recipients bear the
 * cost asks in US dollars and holds them as the dollar token at par, so the
 * token amount is always a whole number of cents.
 */
export function requestedMoney(requested: Money | TokenAmount): Money {
  if (requested.kind === 'fiat') return requested;
  const cents = fiatCurrency('USD').minorUnits;
  if (requested.scale < cents) throw new ApiError('INTERNAL');
  const shift = 10n ** BigInt(requested.scale - cents);
  if (requested.amount % shift !== 0n) throw new ApiError('INTERNAL');
  return money(requested.amount / shift, 'USD');
}

/** A destination shown without the middle, enough to recognise and no more. */
export function maskDestination(address: string): string {
  return address.length <= 11 ? address : `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// The rail the leg's chain carries its method by, read from the contract's own list.
function railOf(leg: PayoutLeg): WireLeg['rail'] {
  const wallet = leg.method === 'stellar_wallet';
  const rail = RAIL_IDS.find(
    (id) => id.startsWith(`${leg.amount.chain}.`) && id.endsWith('.wallet') === wallet,
  );
  if (rail === undefined) throw new ApiError('INTERNAL');
  return rail;
}

function wireLeg(leg: PayoutLeg, network: WireNetwork, payout: Payout): WireLeg {
  // Legs record no times of their own yet. All of an attempt's legs settle in the
  // one transaction that executes the payout, and a wallet leg is delivered when
  // it settles, so the payout's times are each leg's.
  const settledAt = SETTLED_LEG.has(leg.status) ? isoOrNull(payout.settledAt) : null;
  return {
    id: leg.id,
    index: leg.index,
    method: leg.method as PayoutMethod,
    rail: railOf(leg),
    status: leg.status as LegStatus,
    amount: toWireToken(leg.amount, network),
    received: null,
    maskedDestination: maskDestination(leg.destinationAddress),
    anchorName: null,
    cashOut: null,
    txHash: leg.chainTxHash,
    anchorTransactionId: null,
    failureReason: leg.status === 'failed' ? UNRECORDED_FAILURE : null,
    replacesLegId: null,
    settledAt,
    deliveredAt:
      leg.status === 'delivered' ? isoOrNull(payout.deliveredAt ?? payout.settledAt) : null,
  };
}

function chargesOf(
  total: TokenAmount,
  legs: readonly PayoutLeg[],
  agreedFeeBps: number | null,
  network: WireNetwork,
): NonNullable<PayoutDetail['charges']> {
  // A mandate made through the API always has its terms, so a routed payout
  // without them is a gap in our data, not a client's.
  if (agreedFeeBps === null) throw new ApiError('INTERNAL');
  const take =
    legs.length === 0 ? tokenAmount(0n, total.asset, total.chain) : sum(legs.map((leg) => leg.fee));
  return {
    settlement: toWireToken(total, network),
    take: toWireToken(take, network),
    takeBps: agreedFeeBps,
    charged: toWireToken(add(total, take), network),
  };
}

export function toPayoutAccepted(tenant: Tenant, payout: Payout): PayoutAccepted {
  return {
    principalId: tenant.principalId,
    projectId: tenant.projectId,
    id: payout.id,
    status: payout.publicStatus as PayoutStatus,
    mandateId: payout.mandateId,
    recipientId: payout.recipientId,
    requested: toWireMoney(requestedMoney(payout.requested)),
    method: payout.method as PayoutMethod,
    taskId: payout.taskId,
    createdAt: iso(payout.createdAt),
  };
}

export function toPayoutListItem(
  tenant: Tenant,
  listing: PayoutListing,
  displayName: string,
): PayoutListItem {
  const { payout, attempt } = listing;
  const network = attempt === null ? null : wireNetwork(attempt.network);
  // The contract has them come together, and a total is known once routed.
  const settlement =
    payout.total === null || network === null ? null : toWireToken(payout.total, network);
  const status = payout.publicStatus as PayoutStatus;
  return {
    principalId: tenant.principalId,
    projectId: tenant.projectId,
    id: payout.id,
    recipient: { id: payout.recipientId, displayName, country: listing.recipientCountry },
    mandate: { id: payout.mandateId, name: listing.mandateName },
    requested: toWireMoney(requestedMoney(payout.requested)),
    received: null,
    settlement,
    status,
    queuedReason:
      payout.status === 'received' &&
      payout.statusReason !== null &&
      QUEUED_REASONS.has(payout.statusReason)
        ? (payout.statusReason as PayoutListItem['queuedReason'])
        : null,
    blockedBy: payout.blockedBy,
    corridor: listing.recipientCountry,
    method: (attempt?.firstMethod ?? payout.method) as PayoutMethod,
    legCount: attempt?.legCount ?? 0,
    network: settlement === null ? null : network,
    createdAt: iso(payout.createdAt),
    settledAt: EXECUTED.has(status) ? isoOrNull(payout.settledAt) : null,
  };
}

export function toPayoutDetail(
  tenant: Tenant,
  view: PayoutView,
  displayName: string,
  receipt: PayoutReceiptLink | null,
): PayoutDetail {
  const item = toPayoutListItem(tenant, view, displayName);
  const { payout, attempt } = view;
  const attemptNetwork = attempt === null ? null : wireNetwork(attempt.network);
  const legs =
    attemptNetwork === null ? [] : view.legs.map((leg) => wireLeg(leg, attemptNetwork, payout));
  return {
    ...item,
    taskId: payout.taskId,
    legs,
    charges:
      payout.total === null || item.network === null
        ? null
        : chargesOf(payout.total, view.legs, view.agreedFeeBps, item.network),
    cashOutBearer: payout.cashoutCostBearer as PayoutDetail['cashOutBearer'],
    timeline: [
      { step: 'requested', at: iso(payout.createdAt) },
      { step: 'approved', at: isoOrNull(payout.approvedAt) },
      { step: 'quoted', at: null },
      { step: 'settled', at: isoOrNull(payout.settledAt) },
      { step: 'delivered', at: isoOrNull(payout.deliveredAt) },
    ],
    allowedBy: payout.allowedBy,
    approvals: { given: view.approvalsGiven, required: 0 },
    receipt,
    updatedAt: iso(payout.updatedAt),
  };
}
