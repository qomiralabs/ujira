// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import {
  ZERO_ACCOUNT_ADDRESS,
  ZERO_CONTRACT_ADDRESS,
  decodeAccountAddress,
  encodeMuxedAddress,
} from './codecs/strkey.js';
import { isUnpayableAddress, settlementAddressesOf } from './unpayable.js';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ACCOUNT = 'GA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQHES5';
const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const ASSET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

describe('isUnpayableAddress', () => {
  it('finds an address on the list', () => {
    expect(isUnpayableAddress(ISSUER, [ISSUER])).toBe(true);
    expect(isUnpayableAddress(FACTORY, [ISSUER, FACTORY])).toBe(true);
  });

  // A tag only tells the account's owner who a payment is for. The money still lands
  // on the account, so on the issuer it still burns.
  it('looks through an M address to the account it pays', () => {
    const muxed = encodeMuxedAddress(decodeAccountAddress(ISSUER), 7n);
    expect(isUnpayableAddress(muxed, [ISSUER])).toBe(true);
  });

  it('always refuses an all-zero address, whatever the list says', () => {
    expect(isUnpayableAddress(ZERO_ACCOUNT_ADDRESS, [])).toBe(true);
    expect(isUnpayableAddress(ZERO_CONTRACT_ADDRESS, [])).toBe(true);
  });

  it('passes anything else', () => {
    expect(isUnpayableAddress(ACCOUNT, [ISSUER, FACTORY, ASSET])).toBe(false);
    const muxed = encodeMuxedAddress(decodeAccountAddress(ACCOUNT), 7n);
    expect(isUnpayableAddress(muxed, [ISSUER])).toBe(false);
  });
});

describe('settlementAddressesOf', () => {
  it('names every trusted factory, the asset contract and its issuer', () => {
    expect(
      settlementAddressesOf({
        trustedFactories: { '1': [FACTORY] },
        assets: { USDC: { sac: ASSET, issuer: ISSUER } },
      }),
    ).toEqual([FACTORY, ASSET, ISSUER]);
  });
});
