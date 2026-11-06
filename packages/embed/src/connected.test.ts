// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

// The widget saving through UJIRA itself, against the fake API: the corridor
// decides the methods, a refused destination comes back in plain words, the
// wallet confirms the address, and free activation is offered first when it
// can fix what stops the wallet receiving.

import { afterEach, describe, expect, it } from 'vitest';

import { fakeClient, FAKE_ISSUER, WRONG_SIGNATURE, type FakeScenario } from './api/fake.js';
import { encodeAccountAddress } from './destination.js';
import { en } from './i18n/en.js';
import { TAG_NAME } from './index.js';
import { COMPLETE_EVENT, type CompleteDetail, type UjiraOnboarding } from './onboarding-element.js';
import type { WalletConnector } from './wallet.js';

const WALLET = encodeAccountAddress(new Uint8Array(32).fill(7));

let widget: UjiraOnboarding;

function root(): ShadowRoot {
  const shadow = widget.shadowRoot;
  if (shadow === null) throw new Error('the widget has no shadow root');
  return shadow;
}

function text(): string {
  return root().textContent;
}

function find(selector: string): HTMLElement {
  const found = root().querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}

function field(selector: string): HTMLInputElement {
  const found = find(selector);
  if (!(found instanceof HTMLInputElement)) throw new Error(`${selector} is not an input`);
  return found;
}

/** Lets every pending promise and the render after it settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await widget.updateComplete;
  }
}

async function type(selector: string, value: string): Promise<void> {
  const input = field(selector);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await widget.updateComplete;
}

async function submit(): Promise<void> {
  const form = find('form');
  if (!(form instanceof HTMLFormElement)) throw new Error('that is not a form');
  form.requestSubmit();
  await settle();
}

interface Signing {
  messages: string[];
  transactions: string[];
}

function pageWallet(options: { transactions?: boolean; refuse?: boolean } = {}): {
  wallet: WalletConnector;
  signed: Signing;
} {
  const signed: Signing = { messages: [], transactions: [] };
  const wallet: WalletConnector = {
    signMessage: (message) => {
      if (options.refuse === true) return Promise.reject(new Error('the person said no'));
      signed.messages.push(message);
      return Promise.resolve({ signature: 'c2lnbmVk' });
    },
    ...(options.transactions === false
      ? {}
      : {
          signTransaction: (transaction: string) => {
            signed.transactions.push(transaction);
            return Promise.resolve(`${transaction}-signed`);
          },
        }),
  };
  return { wallet, signed };
}

async function open(
  scenario: Partial<FakeScenario> = {},
  wallet?: WalletConnector,
): Promise<ReturnType<typeof fakeClient>> {
  const client = fakeClient(scenario);
  widget = document.createElement(TAG_NAME);
  widget.client = client;
  if (wallet !== undefined) widget.wallet = wallet;
  document.body.replaceChildren(widget);
  await settle();
  return client;
}

/** Method, destination and review, ending on the wallet step. */
async function answer(address = WALLET, memo = ''): Promise<void> {
  await submit();
  await type('#answer', address);
  if (memo !== '') await type('#memo', memo);
  await submit();
  await submit();
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('connected to UJIRA', () => {
  it('reads the corridor first, and skips the name UJIRA already holds', async () => {
    const client = await open();
    expect(client.calls[0]?.name).toBe('session');
    expect(widget.currentStep).toBe('method');
    expect(find('.progress').textContent.trim()).toBe('Step 1 of 4');
    expect(find('.statement-name').textContent).toBe(en['method.wallet.name']);
  });

  it('with no signed anchor, KE offers only USDC to your Stellar wallet', async () => {
    await open({ country: 'KE', methods: ['stellar_wallet'] });
    expect(root().querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(find('.statement-name').textContent).toBe('USDC to your Stellar wallet');
  });

  it('keeps a method closed that the widget has not finished, even where it is paid out', async () => {
    await open({ country: 'KE', methods: ['stellar_wallet', 'mobile_money'] });
    expect(root().querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(text()).not.toContain(en['method.mobile.name']);
  });

  it('says so when the corridor pays out no method the widget offers', async () => {
    await open({ methods: [] });
    expect(find('.alert').textContent.trim()).toBe(en['method.missing']);
    expect(root().querySelector('.primary')).toBeNull();
  });

  it('refuses a text memo before anything is saved', async () => {
    const client = await open();
    await submit();
    await type('#answer', WALLET);
    await type('#memo', 'invoice 12');
    await submit();
    expect(widget.currentStep).toBe('destination');
    expect(find('.alert').textContent.trim()).toBe(en['destination.memo.unsupported']);
    expect(find('#memo').getAttribute('aria-invalid')).toBe('true');
    expect(client.calls.map((call) => call.name)).not.toContain('addMethod');
  });

  it('refuses the USDC issuer, which a payout would burn', async () => {
    await open();
    await submit();
    await type('#answer', FAKE_ISSUER);
    await submit();
    expect(widget.currentStep).toBe('destination');
    expect(find('.alert').textContent.trim()).toBe(en['destination.wallet.unpayable']);
  });

  it('saves the address and memo, then the page wallet confirms it in one press', async () => {
    const { wallet, signed } = pageWallet();
    const client = await open({}, wallet);
    const seen: CompleteDetail[] = [];
    widget.addEventListener(COMPLETE_EVENT, (event) => {
      seen.push((event as CustomEvent<CompleteDetail>).detail);
    });
    await answer(WALLET, '42');
    expect(widget.currentStep).toBe('prove');
    expect(find('.progress').textContent.trim()).toBe('Step 4 of 4');
    expect(root().querySelector('.text-button')).toBeNull();
    const added = client.calls.find((call) => call.name === 'addMethod');
    expect(added?.args[1]).toEqual({
      method: 'stellar_wallet',
      destination: { network: 'stellar:testnet', address: WALLET, memo: '42' },
    });

    await submit();
    expect(signed.messages).toHaveLength(1);
    expect(widget.currentStep).toBe('done');
    expect(seen).toEqual([
      { name: '', method: 'wallet', destination: WALLET, memo: '42', methodId: 'method-0001' },
    ]);
  });

  it('takes a pasted signature when the page has no wallet', async () => {
    await open();
    await answer();
    expect(find('.sign-text').textContent).toContain('confirm your payout address');
    await submit();
    expect(find('.alert').textContent.trim()).toBe(en['prove.signature.missing']);
    await type('#signature', 'c2lnbmVk');
    await submit();
    expect(widget.currentStep).toBe('done');
  });

  it('asks for a new signature when it did not match, with a fresh message', async () => {
    const client = await open();
    await answer();
    await type('#signature', WRONG_SIGNATURE);
    await submit();
    expect(widget.currentStep).toBe('prove');
    expect(find('.alert').textContent.trim()).toBe(en['prove.invalid']);
    const challenges = client.calls.filter((call) => call.name === 'createWalletChallenge');
    expect(challenges).toHaveLength(2);
    expect(field('#signature').value).toBe('');
  });

  it('says so when the person turns the wallet down', async () => {
    await open({}, pageWallet({ refuse: true }).wallet);
    await answer();
    await submit();
    expect(widget.currentStep).toBe('prove');
    expect(find('.alert').textContent.trim()).toBe(en['prove.declined']);
  });

  it('eligible recipient with no account sees Activate this account for free, and the proof step follows a landed activation', async () => {
    const { wallet, signed } = pageWallet();
    const client = await open(
      { activationOffered: true, receivability: 'ACCOUNT_NOT_FOUND' },
      wallet,
    );
    await answer();
    await submit();
    expect(widget.currentStep).toBe('activate');
    expect(find('.primary').textContent.trim()).toBe('Activate this account for free');
    expect(find('.progress').textContent.trim()).toBe('Step 4 of 4');

    await submit();
    expect(signed.transactions).toEqual(['AAAAAgAAAAB-unsigned-envelope']);
    expect(widget.currentStep).toBe('prove');
    const names = client.calls.map((call) => call.name);
    expect(names.slice(names.indexOf('requestActivation'))).toEqual([
      'requestActivation',
      'submitActivation',
      'createWalletChallenge',
    ]);

    // Activation is never itself the proof: the wallet still signs.
    await submit();
    expect(widget.currentStep).toBe('done');
    expect(signed.messages).toHaveLength(2);
  });

  it('offers activation for a missing USDC line too, and a way to do it yourself', async () => {
    await open({ activationOffered: true, receivability: 'NO_TRUSTLINE' }, pageWallet().wallet);
    await answer();
    await submit();
    expect(widget.currentStep).toBe('activate');
    find('.text-button').click();
    await settle();
    expect(widget.currentStep).toBe('prove');
    expect(find('.alert').textContent.trim()).toBe(en['receive.noTrustline']);
  });

  it('gives the plain words when activation is not on offer', async () => {
    await open({ receivability: 'ACCOUNT_NOT_FOUND' }, pageWallet().wallet);
    await answer();
    await submit();
    expect(widget.currentStep).toBe('prove');
    expect(find('.alert').textContent.trim()).toBe(en['receive.accountNotFound']);
  });

  it('does not offer activation when the page wallet cannot sign a transaction', async () => {
    await open(
      { activationOffered: true, receivability: 'ACCOUNT_NOT_FOUND' },
      pageWallet({ transactions: false }).wallet,
    );
    await answer();
    await submit();
    expect(widget.currentStep).toBe('prove');
    expect(find('.alert').textContent.trim()).toBe(en['receive.accountNotFound']);
  });

  it('explains a key that no longer signs for the account', async () => {
    await open({ signerAuthorized: false }, pageWallet().wallet);
    await answer();
    await submit();
    expect(find('.alert').textContent.trim()).toBe(en['receive.signerNotAuthorized']);
  });

  it('explains the limit and authorisation cases without offering activation', async () => {
    for (const [receivability, key] of [
      ['TRUSTLINE_LIMIT', 'receive.limit'],
      ['TRUSTLINE_NOT_AUTHORIZED', 'receive.notAuthorized'],
    ] as const) {
      await open({ activationOffered: true, receivability }, pageWallet().wallet);
      await answer();
      await submit();
      expect(widget.currentStep).toBe('prove');
      expect(find('.alert').textContent.trim()).toBe(en[key]);
    }
  });
});

describe('when UJIRA cannot be reached', () => {
  it('says so, and tries again when asked', async () => {
    const client = fakeClient();
    let fail = true;
    widget = document.createElement(TAG_NAME);
    widget.client = {
      ...client,
      session: () => (fail ? Promise.reject(new Error('offline')) : client.session()),
    };
    document.body.replaceChildren(widget);
    await settle();
    expect(find('.alert').textContent.trim()).toBe(en['widget.loadFailed']);
    fail = false;
    await submit();
    expect(widget.currentStep).toBe('method');
  });

  it('says the link has expired when the token is refused', async () => {
    const { ApiProblem } = await import('./api/client.js');
    widget = document.createElement(TAG_NAME);
    widget.client = {
      ...fakeClient(),
      session: () => Promise.reject(new ApiProblem({ status: 401, code: 'EMBED_TOKEN_INVALID' })),
    };
    document.body.replaceChildren(widget);
    await settle();
    expect(find('.alert').textContent.trim()).toBe(en['widget.expired']);
    expect(root().querySelector('.primary')).toBeNull();
  });
});
