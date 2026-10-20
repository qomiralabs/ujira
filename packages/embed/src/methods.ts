// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The payout methods the widget can offer, and the one field each of them
// needs from a recipient.
//
// Only the wallet method is open at the testnet launch (issue #128). The
// three anchor methods are built behind the same step and switched off, so
// turning one on is a flag change, not new UI. The method step renders a
// single open method as a plain statement rather than a choice of one.

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
   * The ledger checks the destination for real when the payout is made.
   */
  shape: RegExp;
}

export interface PayoutMethod {
  id: MethodId;
  /** Open to recipients today. */
  open: boolean;
  name: MessageKey;
  line: MessageKey;
  destination: MethodDestination;
}

export const PAYOUT_METHODS: readonly PayoutMethod[] = [
  {
    id: 'wallet',
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
      shape: /^G[A-Z2-7]{55}$/,
    },
  },
  {
    id: 'bank',
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

export function openMethods(
  methods: readonly PayoutMethod[] = PAYOUT_METHODS,
): readonly PayoutMethod[] {
  return methods.filter((method) => method.open);
}

export function methodById(
  id: string,
  methods: readonly PayoutMethod[] = PAYOUT_METHODS,
): PayoutMethod | undefined {
  return methods.find((method) => method.id === id);
}
