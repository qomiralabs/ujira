// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Runs in the connected host page, never in the widget. It hands the widget
// the fake UJIRA API for the scenario named in the address, and a page
// wallet that signs whatever it is given when the address asks for one:
//
//   /connected.html?scenario=activation&wallet=1

import { fakeClient, type FakeScenario } from '../src/api/fake.js';
import type { UjiraOnboarding } from '../src/onboarding-element.js';
import type { WalletConnector } from '../src/wallet.js';

export const SCENARIOS: Readonly<Record<string, Partial<FakeScenario>>> = {
  /** A Kenyan recipient where no anchor is signed: the wallet only. */
  'ke-wallet': { country: 'KE', methods: ['stellar_wallet'] },
  /** A signed mobile money partner in Kenya, alongside the wallet. */
  'ke-mobile': { country: 'KE', methods: ['stellar_wallet', 'mobile_money'] },
  /** A wallet recipient in a mode that needs Self before the address is saved. */
  'self-wallet': {
    verifications: [{ method: 'stellar_wallet', provider: 'self', status: null }],
  },
  /** A wallet with no account yet, where UJIRA offers to activate it. */
  activation: { activationOffered: true, receivability: 'ACCOUNT_NOT_FOUND' },
};

const PAGE_WALLET: WalletConnector = {
  signMessage: () => Promise.resolve({ signature: 'c2lnbmVkIGJ5IHRoZSBmYWtl' }),
  signTransaction: (transaction) => Promise.resolve(`${transaction}-signed`),
};

/** Signs on behalf of the page and counts what it was asked to sign. */
export interface Recorded {
  messages: number;
  transactions: number;
}

declare global {
  interface Window {
    walletSigned?: Recorded;
  }
}

async function connect(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const scenario = SCENARIOS[params.get('scenario') ?? 'ke-wallet'] ?? {};
  await customElements.whenDefined('ujira-onboarding');
  const widget = document.querySelector<UjiraOnboarding>('ujira-onboarding');
  if (widget === null) return;
  if (params.get('wallet') === '1') {
    const recorded: Recorded = { messages: 0, transactions: 0 };
    window.walletSigned = recorded;
    widget.wallet = {
      signMessage: (message, address) => {
        recorded.messages += 1;
        return PAGE_WALLET.signMessage(message, address);
      },
      signTransaction: (transaction, options) => {
        recorded.transactions += 1;
        return PAGE_WALLET.signTransaction?.(transaction, options) ?? Promise.resolve('');
      },
    };
  }
  widget.client = fakeClient(scenario);
}

void connect();
