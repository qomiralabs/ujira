// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Onboarding captures a recipient's destination through the chain adapter's
// reader, so the rule is the one the API and the payout path apply. These
// pin the record it hands to storage and that refusals stay typed.

import { InvalidInputError, UnsupportedMemoDestinationError } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import { captureDestination, captureProviderDestination } from './destination.js';
import * as index from './index.js';

const NETWORK = 'stellar:testnet';
const ACCOUNT = 'GA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQHES5';
const MUXED_123456 = 'MA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAAAAAAAAAPCICBKU';

describe('captureDestination', () => {
  it('stores a G address with an id memo as its M address, with the tag as text', () => {
    const captured = captureDestination(NETWORK, {
      address: ACCOUNT,
      memoType: 'id',
      memo: '123456',
    });
    expect(captured).toEqual({ network: NETWORK, address: MUXED_123456, tag: '123456' });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captureDestination(NETWORK, { address: ACCOUNT })).toEqual({
      network: NETWORK,
      address: ACCOUNT,
      tag: null,
    });
  });

  it('rejects text and hash memo destinations with the typed error', () => {
    for (const memoType of ['text', 'hash'] as const) {
      expect(() => captureDestination(NETWORK, { address: ACCOUNT, memoType, memo: 'x' })).toThrow(
        UnsupportedMemoDestinationError,
      );
    }
  });

  it('rejects a provider instruction that needs a text memo, and reads an id one', () => {
    expect(() =>
      captureProviderDestination(NETWORK, { account_id: ACCOUNT, memo_type: 'text', memo: 'x' }),
    ).toThrow(UnsupportedMemoDestinationError);
    expect(
      captureProviderDestination(NETWORK, { account_id: ACCOUNT, memo_type: 'id', memo: '123456' })
        .address,
    ).toBe(MUXED_123456);
  });

  it('passes any other refusal on as the adapter typed it', () => {
    expect(() => captureDestination(NETWORK, { address: 'G123' })).toThrow(InvalidInputError);
  });

  it('is exported from the package root', () => {
    const root = index as Record<string, unknown>;
    expect(root['captureDestination']).toBe(captureDestination);
    expect(root['captureProviderDestination']).toBe(captureProviderDestination);
  });
});
