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
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const ASSET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const NEVER_PAYABLE = [FACTORY, ASSET, ISSUER];

describe('a destination that can never pay out', () => {
  // A transfer to an asset's issuer is burned. The mandate does not check for it, and
  // in allowlist mode no attester looks either, so this is where it has to be caught.
  it.each([
    ['the settlement asset issuer', { address: ISSUER }],
    ['the issuer under an id memo', { address: ISSUER, memoType: 'id' as const, memo: '7' }],
    ['the settlement asset contract', { address: ASSET }],
    ['a trusted factory', { address: FACTORY }],
  ])('is refused at onboarding: %s', (_label, input) => {
    let refused: unknown;
    try {
      captureDestination(NETWORK, NEVER_PAYABLE, input);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(InvalidInputError);
    expect(refused).toMatchObject({ reason: 'UNPAYABLE_ADDRESS' });
  });

  it('is refused from a provider too, whose instructions are not ours to trust', () => {
    expect(() =>
      captureProviderDestination(NETWORK, NEVER_PAYABLE, { account_id: ISSUER }),
    ).toThrow(InvalidInputError);
  });

  it('leaves an ordinary destination alone', () => {
    expect(captureDestination(NETWORK, NEVER_PAYABLE, { address: ACCOUNT }).address).toBe(ACCOUNT);
    expect(
      captureProviderDestination(NETWORK, NEVER_PAYABLE, { account_id: ACCOUNT }).address,
    ).toBe(ACCOUNT);
  });
});

describe('captureDestination', () => {
  it('stores a G address with an id memo as its M address, with the tag as text', () => {
    const captured = captureDestination(NETWORK, NEVER_PAYABLE, {
      address: ACCOUNT,
      memoType: 'id',
      memo: '123456',
    });
    expect(captured).toEqual({ network: NETWORK, address: MUXED_123456, tag: '123456' });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captureDestination(NETWORK, NEVER_PAYABLE, { address: ACCOUNT })).toEqual({
      network: NETWORK,
      address: ACCOUNT,
      tag: null,
    });
  });

  it('rejects text and hash memo destinations with the typed error', () => {
    for (const memoType of ['text', 'hash'] as const) {
      expect(() =>
        captureDestination(NETWORK, NEVER_PAYABLE, { address: ACCOUNT, memoType, memo: 'x' }),
      ).toThrow(UnsupportedMemoDestinationError);
    }
  });

  it('rejects a provider instruction that needs a text memo, and reads an id one', () => {
    expect(() =>
      captureProviderDestination(NETWORK, NEVER_PAYABLE, {
        account_id: ACCOUNT,
        memo_type: 'text',
        memo: 'x',
      }),
    ).toThrow(UnsupportedMemoDestinationError);
    expect(
      captureProviderDestination(NETWORK, NEVER_PAYABLE, {
        account_id: ACCOUNT,
        memo_type: 'id',
        memo: '123456',
      }).address,
    ).toBe(MUXED_123456);
  });

  it('passes any other refusal on as the adapter typed it', () => {
    expect(() => captureDestination(NETWORK, NEVER_PAYABLE, { address: 'G123' })).toThrow(
      InvalidInputError,
    );
  });

  it('is exported from the package root', () => {
    const root = index as Record<string, unknown>;
    expect(root['captureDestination']).toBe(captureDestination);
    expect(root['captureProviderDestination']).toBe(captureProviderDestination);
  });
});
