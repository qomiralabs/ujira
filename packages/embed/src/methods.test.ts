// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { en } from './i18n/en.js';
import { methodById, METHOD_IDS, openMethods, PAYOUT_METHODS } from './methods.js';

describe('payout methods', () => {
  it('opens one method at the testnet launch and keeps the others built', () => {
    expect(openMethods().map((method) => method.id)).toEqual(['wallet']);
    expect(PAYOUT_METHODS.map((method) => method.id)).toEqual([...METHOD_IDS]);
  });

  it('names every method and its line from the catalogue', () => {
    for (const method of PAYOUT_METHODS) {
      expect(en[method.name]).toBeTypeOf('string');
      expect(en[method.line]).toBeTypeOf('string');
      for (const key of Object.values(method.destination)) {
        if (typeof key === 'string' && key.includes('.')) {
          expect(en[key as keyof typeof en]).toBeTypeOf('string');
        }
      }
    }
  });

  it('finds a method by id and nothing by a name we do not use', () => {
    expect(methodById('wallet')?.open).toBe(true);
    expect(methodById('cheque')).toBeUndefined();
  });

  it('checks the shape of a wallet address before anything is saved', () => {
    const shape = methodById('wallet')?.destination.shape;
    expect(shape?.test(`G${'A'.repeat(55)}`)).toBe(true);
    expect(shape?.test('GABC')).toBe(false);
    expect(shape?.test(`g${'A'.repeat(55)}`)).toBe(false);
    expect(shape?.test(`G${'A'.repeat(54)}1`)).toBe(false);
  });

  it('checks the shape of an account number and a phone number', () => {
    expect(methodById('bank')?.destination.shape.test('0123456789')).toBe(true);
    expect(methodById('bank')?.destination.shape.test('12345')).toBe(false);
    expect(methodById('mobile')?.destination.shape.test('+2348012345678')).toBe(true);
    expect(methodById('mobile')?.destination.shape.test('0801')).toBe(false);
    expect(methodById('cash')?.destination.shape.test('0712345678')).toBe(true);
  });
});
