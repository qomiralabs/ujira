// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import type { Bytes32 } from '../types.js';
import { mandateAddressOf } from './mandate-address.js';

const FACTORY = 'CAAVOGDGGM7JOLDS3CIQNPGSJOYFI54CJSAQQEFQKW7CES5UYIAZOYUQ';

// Each answer is what the factory deployed on testnet returned when its create
// was simulated with these inputs, so these pin the derivation to the chain
// and not to this code's reading of it.
const ANSWERED_BY_THE_FACTORY = [
  {
    principal: 'GARLTWQ6UJA764DYR4J6GK3UEBEH4YWRWWABXT7AJDSFWO7AW3PITDON',
    salt: '0x8e7a8ff927a46974eab27d415fb4c763a871d53b816d2906604554fbd09780ee',
    mandate: 'CCEST4HX3NN7ZJX2SZHAV7PD2ORWGF2WDDTF4YRGCRXOC33SS74QPQOU',
  },
  {
    principal: 'CDHAK46P6AECDNJ3BQHUHQJVYFQU54KFUWB3NEV3CV5OWXKNQQ2T33BO',
    salt: '0x0255a39c80734de3291e4b99260e0a726c910cb859fb2c0d39ea0678f36472ef',
    mandate: 'CDOLXVD4OQULPR2GX2BYTVLCWVUN6T624BCIADZ6NHGEFDDVFAOCFKMB',
  },
] as const;

describe('mandateAddressOf', () => {
  it.each(ANSWERED_BY_THE_FACTORY)(
    'gives the address the factory answers for principal $principal',
    ({ principal, salt, mandate }) => {
      expect(mandateAddressOf('stellar:testnet', FACTORY, principal, salt as Bytes32)).toBe(
        mandate,
      );
    },
  );

  it('differs by network, principal and salt', () => {
    const [{ principal, salt, mandate }, other] = ANSWERED_BY_THE_FACTORY;
    expect(mandateAddressOf('stellar:pubnet', FACTORY, principal, salt as Bytes32)).not.toBe(
      mandate,
    );
    expect(mandateAddressOf('stellar:testnet', FACTORY, other.principal, salt as Bytes32)).not.toBe(
      mandate,
    );
    expect(mandateAddressOf('stellar:testnet', FACTORY, principal, other.salt as Bytes32)).not.toBe(
      mandate,
    );
  });

  it('refuses a malformed salt, principal or factory', () => {
    const [{ principal, salt }] = ANSWERED_BY_THE_FACTORY;
    expect(() =>
      mandateAddressOf('stellar:testnet', FACTORY, principal, '0x12' as Bytes32),
    ).toThrow(InvalidInputError);
    expect(() => mandateAddressOf('stellar:testnet', FACTORY, 'Gnope', salt as Bytes32)).toThrow(
      InvalidInputError,
    );
    expect(() => mandateAddressOf('stellar:testnet', 'Cnope', principal, salt as Bytes32)).toThrow(
      InvalidInputError,
    );
  });
});
