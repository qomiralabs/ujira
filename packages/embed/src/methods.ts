// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The payout methods the widget can offer, and the one field each of them
// needs from a recipient.
//
// Two things decide whether a method is offered, and both must say yes:
//   - `open` here: the widget's path for that method is finished. Only the
//     wallet is, at the testnet launch. Bank, mobile money and cash pickup
//     are built behind the same step and stay closed until their anchor
//     hand-off is, so opening one is a flag change, not new UI.
//   - the corridor: UJIRA's session lists the methods a signed partner pays
//     out in the recipient's country. With no session, as when the page
//     saves the answers itself, every open method counts.
// The method step renders a single offered method as a plain statement
// rather than a choice of one.

import type { ApiMethod } from './api/contract.js';
import type { MessageKey } from './i18n/catalogue.js';

export const METHOD_IDS = ['wallet', 'bank', 'mobile', 'cash'] as const;

export type MethodId = (typeof METHOD_IDS)[number];

/** The one question the method needs answered, and how to check the answer. */
export interface MethodDestination {
  heading: MessageKey;
  label: MessageKey;
  hint: MessageKey;
  action: MessageKey;
  missing: MessageKey;
  invalid: MessageKey;
  /** Keyboard a phone should offer for the field. */
  inputMode: 'text' | 'numeric' | 'tel';
  autocomplete: string;
  /**
   * A shape check, so an obvious typo is caught before anything is saved.
   * The wallet method has none: it reads the address in full; see destination.ts.
   */
  shape?: RegExp;
}

export interface PayoutMethod {
  id: MethodId;
  /** The name the API knows the method by. */
  api: ApiMethod;
  /** The widget's path for this method is finished. */
  open: boolean;
  name: MessageKey;
  line: MessageKey;
  destination: MethodDestination;
}

export const PAYOUT_METHODS: readonly PayoutMethod[] = [
  {
    id: 'wallet',
    api: 'stellar_wallet',
    open: true,
    name: 'method.wallet.name',
    line: 'method.wallet.line',
    destination: {
      heading: 'destination.wallet.heading',
      label: 'destination.wallet.label',
      hint: 'destination.wallet.hint',
      action: 'destination.wallet.action',
      missing: 'destination.wallet.missing',
      invalid: 'destination.wallet.invalid',
      inputMode: 'text',
      autocomplete: 'off',
    },
  },
  {
    id: 'bank',
    api: 'bank',
    open: false,
    name: 'method.bank.name',
    line: 'method.bank.line',
    destination: {
      heading: 'destination.bank.heading',
      label: 'destination.bank.label',
      hint: 'destination.bank.hint',
      action: 'destination.bank.action',
      missing: 'destination.bank.missing',
      invalid: 'destination.bank.invalid',
      inputMode: 'numeric',
      autocomplete: 'off',
      shape: /^\d{6,20}$/,
    },
  },
  {
    id: 'mobile',
    api: 'mobile_money',
    open: false,
    name: 'method.mobile.name',
    line: 'method.mobile.line',
    destination: {
      heading: 'destination.mobile.heading',
      label: 'destination.mobile.label',
      hint: 'destination.mobile.hint',
      action: 'destination.mobile.action',
      missing: 'destination.mobile.missing',
      invalid: 'destination.mobile.invalid',
      inputMode: 'tel',
      autocomplete: 'tel',
      shape: /^\+?\d{7,15}$/,
    },
  },
  {
    id: 'cash',
    api: 'cash_pickup',
    open: false,
    name: 'method.cash.name',
    line: 'method.cash.line',
    destination: {
      heading: 'destination.cash.heading',
      label: 'destination.cash.label',
      hint: 'destination.cash.hint',
      action: 'destination.cash.action',
      missing: 'destination.cash.missing',
      invalid: 'destination.cash.invalid',
      inputMode: 'tel',
      autocomplete: 'tel',
      shape: /^\+?\d{7,15}$/,
    },
  },
];

/**
 * The methods to offer: open in the widget and, when a corridor is known,
 * paid out there. `corridor` is the session's list, or undefined without one.
 */
export function openMethods(
  methods: readonly PayoutMethod[] = PAYOUT_METHODS,
  corridor?: readonly ApiMethod[],
): readonly PayoutMethod[] {
  return methods.filter(
    (method) => method.open && (corridor === undefined || corridor.includes(method.api)),
  );
}

export function methodById(
  id: string,
  methods: readonly PayoutMethod[] = PAYOUT_METHODS,
): PayoutMethod | undefined {
  return methods.find((method) => method.id === id);
}
