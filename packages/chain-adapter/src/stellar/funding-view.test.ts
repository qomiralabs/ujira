// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Exchanges cannot send to a contract address, so what a principal gives an
// exchange is the forwarding account. The mandate's own address is offered
// only for funding from a wallet, and labeled so.

import { describe, expect, it } from 'vitest';

import { STRKEY_VERSION, encodeStrkey } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';

import { CONTRACT_ADDRESS_LABEL, stellarFundingView } from './forwarder.js';

const NETWORK = 'stellar:testnet' as const;
const MANDATE = encodeStrkey(STRKEY_VERSION.contract, new Uint8Array(32).fill(1));
const FORWARDER = encodeStrkey(STRKEY_VERSION.account, new Uint8Array(32).fill(2));

describe('funding-view.test.ts', () => {
  it('Stellar exchange deposit address is the forwarder, not the mandate', () => {
    const view = stellarFundingView({ network: NETWORK, mandate: MANDATE, forwarder: FORWARDER });
    expect(view.exchangeDeposit).toEqual({ network: NETWORK, value: FORWARDER });
    expect(view.exchangeDeposit?.value).not.toBe(MANDATE);
    expect(view.walletFunding).toEqual({
      address: { network: NETWORK, value: MANDATE },
      label: 'Stellar contract address, fund from your wallet',
    });
    expect(view.walletFunding.label).toBe(CONTRACT_ADDRESS_LABEL);
    expect(Object.isFrozen(view)).toBe(true);
  });

  it('offers no exchange address until a forwarder exists, never the mandate instead', () => {
    const view = stellarFundingView({ network: NETWORK, mandate: MANDATE, forwarder: null });
    expect(view.exchangeDeposit).toBeNull();
    expect(view.walletFunding.address.value).toBe(MANDATE);
  });

  it('refuses a mandate as the forwarder, and addresses of the wrong kind', () => {
    for (const bad of [
      { network: NETWORK, mandate: MANDATE, forwarder: MANDATE },
      { network: NETWORK, mandate: FORWARDER, forwarder: FORWARDER },
      { network: 'stellar:mainnet', mandate: MANDATE, forwarder: FORWARDER },
    ]) {
      expect(() => stellarFundingView(bad as never)).toThrow(InvalidInputError);
    }
  });
});
