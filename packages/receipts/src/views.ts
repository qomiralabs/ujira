// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Two readings of the same receipt. The principal's has every commercial
// term and every reference. The recipient's follows the method they chose:
// someone paid to their own wallet sees the token, the network and the
// transaction; someone paid to a bank, mobile money or cash pickup sees only
// their own currency, because that is the payment they asked for and the
// rail underneath is not their concern.
//
// Network names and explorer links come from configuration through
// NetworkPresentation, so nothing here knows which chain a receipt is on.

import { formatMoney, formatTokenAmount, sum } from '@ujira/core';
import type { Money } from '@ujira/core';
import { parseReceiptRef } from '@ujira/chain-adapter';
import type { NetworkId, ReceiptRef } from '@ujira/chain-adapter';
import { z } from 'zod';

import { documentSha256 } from './document.js';
import { ReceiptPresentationInvalidError } from './errors.js';
import { isWalletLeg } from './model.js';
import type {
  LocalPayoutMethod,
  PayoutMethod,
  Receipt,
  ReceiptLeg,
  ReceiptRevisionRef,
  WalletPayoutMethod,
} from './model.js';

/** How a network is shown to people, read from configuration. */
export interface NetworkPresentation {
  /** The name people know the network by. */
  name(network: NetworkId): string;
  /** A public explorer page for one transaction on the network. */
  transactionUrl(network: NetworkId, txHash: string): string;
}

export interface ViewOptions {
  /** BCP 47 locale for numbers and currency symbols. */
  readonly locale: string;
  readonly networks: NetworkPresentation;
}

export interface PrincipalLegView {
  readonly index: number;
  readonly method: PayoutMethod;
  readonly label: string;
  readonly destination: string;
  /** The destination tag or memo, which only the principal sees. */
  readonly destinationTag: string | null;
  readonly amount: string;
  readonly received: string | null;
  readonly railFee: string;
  readonly transactionHash: string;
  readonly transactionUrl: string;
}

export interface PrincipalReceiptView {
  readonly view: 'principal';
  readonly principalId: string;
  readonly projectId: string;
  readonly receiptNumber: string;
  readonly revision: number;
  readonly supersedes: ReceiptRevisionRef | null;
  readonly issuedAt: string;
  readonly payoutId: string;
  readonly taskId: string | null;
  readonly mandate: { readonly id: string; readonly name: string };
  readonly recipientRef: string;
  readonly network: { readonly id: NetworkId; readonly name: string };
  readonly receiptRef: ReceiptRef;
  readonly requested: string;
  readonly total: string;
  readonly fee: { readonly amount: string; readonly bps: number; readonly rate: string };
  readonly charged: string;
  readonly feeRefunds: readonly {
    readonly amount: string;
    readonly transactionHash: string;
    readonly transactionUrl: string;
  }[];
  readonly legs: readonly PrincipalLegView[];
  readonly documentSha256: string;
}

export interface RecipientWalletLegView {
  readonly method: WalletPayoutMethod;
  readonly label: string;
  readonly received: string;
  readonly destination: string;
  readonly network: string;
  readonly transactionHash: string;
  readonly transactionUrl: string;
}

/** Only the local amount and where it went: no token, network or transaction. */
export interface RecipientLocalLegView {
  readonly method: LocalPayoutMethod;
  readonly label: string;
  readonly received: string;
  readonly destination: string;
}

export type RecipientLegView = RecipientWalletLegView | RecipientLocalLegView;

export interface RecipientReceiptView {
  readonly view: 'recipient';
  readonly receiptNumber: string;
  readonly revision: number;
  /** The receipt number a correction replaced, never an internal ID. */
  readonly supersedes: string | null;
  readonly issuedAt: string;
  readonly total: string;
  /** One line, for example "₦480,000.00 paid: ₦336,000.00 to bank, 96.00 USDC to your Stellar wallet". */
  readonly summary: string;
  readonly legs: readonly RecipientLegView[];
}

const LOCAL_LABELS: Readonly<Record<LocalPayoutMethod, string>> = Object.freeze({
  bank: 'to bank',
  mobile_money: 'to mobile money',
  cash_pickup: 'for cash pickup',
});

const NetworkName = z
  .string()
  .min(1)
  .max(64)
  .refine((text) => text.isWellFormed());
const ExplorerUrl = z.url({ protocol: /^https$/ });

interface Presented {
  readonly name: string;
  readonly transactionHash: string;
  readonly transactionUrl: string;
}

// Configuration is outside data as far as a receipt is concerned, so what
// it returns is checked before it is shown to anyone.
function present(networks: NetworkPresentation, ref: ReceiptRef): Presented {
  const { network, txHash } = parseReceiptRef(ref);
  const name = NetworkName.safeParse(networks.name(network));
  if (!name.success) {
    throw new ReceiptPresentationInvalidError('the network name from configuration is not usable');
  }
  const url = ExplorerUrl.safeParse(networks.transactionUrl(network, txHash));
  if (!url.success) {
    throw new ReceiptPresentationInvalidError('the explorer link from configuration is not https');
  }
  return { name: name.data, transactionHash: txHash, transactionUrl: url.data };
}

function rate(bps: number): string {
  const whole = (bps - (bps % 100)) / 100;
  return `${String(whole)}.${String(bps % 100).padStart(2, '0')}%`;
}

export function principalView(receipt: Receipt, options: ViewOptions): PrincipalReceiptView {
  const { locale, networks } = options;
  const network = present(networks, receipt.receiptRef);
  return {
    view: 'principal',
    principalId: receipt.principalId,
    projectId: receipt.projectId,
    receiptNumber: receipt.receiptNumber,
    revision: receipt.revision,
    supersedes: receipt.supersedes,
    issuedAt: receipt.issuedAt,
    payoutId: receipt.payoutId,
    taskId: receipt.taskId,
    mandate: receipt.mandate,
    recipientRef: receipt.recipientRef,
    network: { id: receipt.network, name: network.name },
    receiptRef: receipt.receiptRef,
    requested: formatMoney(receipt.requested, { locale }),
    total: formatTokenAmount(receipt.total, { locale }),
    fee: {
      amount: formatTokenAmount(receipt.fee.amount, { locale }),
      bps: receipt.fee.bps,
      rate: rate(receipt.fee.bps),
    },
    charged: formatTokenAmount(receipt.charged, { locale }),
    feeRefunds: receipt.feeRefunds.map((refund) => {
      const shown = present(networks, refund.receiptRef);
      return {
        amount: formatTokenAmount(refund.amount, { locale }),
        transactionHash: shown.transactionHash,
        transactionUrl: shown.transactionUrl,
      };
    }),
    legs: receipt.legs.map((leg) => {
      const shown = present(networks, leg.receiptRef);
      return {
        index: leg.index,
        method: leg.method,
        label: isWalletLeg(leg)
          ? `to the recipient's ${shown.name} wallet`
          : LOCAL_LABELS[leg.method],
        destination: leg.destination.masked,
        destinationTag: leg.destination.tag === null ? null : leg.destination.tag.toString(),
        amount: formatTokenAmount(leg.amount, { locale }),
        received: leg.received === null ? null : formatMoney(leg.received, { locale }),
        railFee: formatTokenAmount(leg.railFee, { locale }),
        transactionHash: shown.transactionHash,
        transactionUrl: shown.transactionUrl,
      };
    }),
    documentSha256: documentSha256(receipt),
  };
}

function recipientLeg(leg: ReceiptLeg, options: ViewOptions): RecipientLegView {
  const { locale, networks } = options;
  if (!isWalletLeg(leg)) {
    return {
      method: leg.method,
      label: LOCAL_LABELS[leg.method],
      received: formatMoney(leg.received, { locale }),
      destination: leg.destination.masked,
    };
  }
  const shown = present(networks, leg.receiptRef);
  return {
    method: leg.method,
    label: `to your ${shown.name} wallet`,
    received: formatTokenAmount(leg.amount, { locale }),
    destination: leg.destination.masked,
    network: shown.name,
    transactionHash: shown.transactionHash,
    transactionUrl: shown.transactionUrl,
  };
}

/**
 * The headline amount in the recipient's own terms: the sum of what they
 * received when every leg landed in one currency, or in the token when every
 * leg went to a wallet. A payout split across a local currency and a wallet
 * has no single unit the legs share, so it shows what the principal asked
 * to pay, which is what the recipient was told to expect.
 */
function recipientTotal(receipt: Receipt, locale: string): string {
  const local = receipt.legs.flatMap((leg) => (leg.received === null ? [] : [leg.received]));
  if (local.length === 0) return formatTokenAmount(receipt.total, { locale });
  const [first] = local as [Money, ...Money[]];
  const oneCurrency = local.every((value) => value.currency === first.currency);
  if (local.length === receipt.legs.length && oneCurrency) {
    return formatMoney(sum(local), { locale });
  }
  return formatMoney(receipt.requested, { locale });
}

export function recipientView(receipt: Receipt, options: ViewOptions): RecipientReceiptView {
  const legs = receipt.legs.map((leg) => recipientLeg(leg, options));
  const total = recipientTotal(receipt, options.locale);
  const [only] = legs;
  const summary =
    only !== undefined && legs.length === 1
      ? `${total} paid ${only.label}`
      : `${total} paid: ${legs.map((leg) => `${leg.received} ${leg.label}`).join(', ')}`;
  return {
    view: 'recipient',
    receiptNumber: receipt.receiptNumber,
    revision: receipt.revision,
    supersedes: receipt.supersedes === null ? null : receipt.supersedes.receiptNumber,
    issuedAt: receipt.issuedAt,
    total,
    summary,
    legs,
  };
}
