// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { UnknownCurrencyError } from './errors.js';

export type FiatCurrencyCode =
  'USD' | 'NGN' | 'KES' | 'GHS' | 'ZAR' | 'PHP' | 'INR' | 'BRL' | 'COP' | 'MXN' | 'EUR' | 'GBP';

export type TokenAsset = 'USDC' | 'USDm';

export type Chain = 'celo' | 'stellar';

export type CurrencyCode = FiatCurrencyCode | TokenAsset;

export interface FiatCurrency {
  readonly code: FiatCurrencyCode;
  /** ISO 4217 minor units, the scale amounts are shown and quoted at. */
  readonly minorUnits: number;
}

export interface SettlementToken {
  readonly asset: TokenAsset;
  readonly chain: Chain;
  /** Decimals the token uses on chain. Amounts settle at this scale. */
  readonly tokenScale: number;
  /** Decimals shown to people. Never used for on chain amounts. */
  readonly displayScale: number;
}

const fiat = (code: FiatCurrencyCode, minorUnits: number): FiatCurrency =>
  Object.freeze({ code, minorUnits });

export const FIAT_CURRENCIES: readonly FiatCurrency[] = Object.freeze([
  fiat('USD', 2),
  fiat('NGN', 2),
  fiat('KES', 2),
  fiat('GHS', 2),
  fiat('ZAR', 2),
  fiat('PHP', 2),
  fiat('INR', 2),
  fiat('BRL', 2),
  fiat('COP', 2),
  fiat('MXN', 2),
  fiat('EUR', 2),
  fiat('GBP', 2),
]);

const token = (asset: TokenAsset, chain: Chain, tokenScale: number): SettlementToken =>
  Object.freeze({ asset, chain, tokenScale, displayScale: 2 });

// The same asset can carry different decimals per chain (Stellar assets are
// always 7), so the key is the asset and chain pair, never the asset alone.
export const SETTLEMENT_TOKENS: readonly SettlementToken[] = Object.freeze([
  token('USDC', 'celo', 6),
  token('USDC', 'stellar', 7),
  token('USDm', 'celo', 18),
]);

// A Set rather than an object map, so names like "constructor" or
// "__proto__" can never resolve through the prototype chain.
const CURRENCY_CODES: ReadonlySet<unknown> = new Set<unknown>([
  ...FIAT_CURRENCIES.map((c) => c.code),
  ...SETTLEMENT_TOKENS.map((t) => t.asset),
]);

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return CURRENCY_CODES.has(value);
}

export function fiatCurrency(code: string): FiatCurrency {
  const found = FIAT_CURRENCIES.find((c) => c.code === code);
  if (found === undefined) {
    throw new UnknownCurrencyError('unknown fiat currency code');
  }
  return found;
}

export function settlementToken(asset: string, chain: string): SettlementToken {
  const found = SETTLEMENT_TOKENS.find((t) => t.asset === asset && t.chain === chain);
  if (found === undefined) {
    throw new UnknownCurrencyError('unknown settlement asset and chain pair');
  }
  return found;
}
