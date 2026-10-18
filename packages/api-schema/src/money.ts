// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Money on the wire is an integer count of minor units carried as a string,
// next to its currency and scale. JSON numbers are binary floats, so a number
// is refused outright, and so is any decimal point: the wire never needs
// separator or rounding rules. Range and scale checks are delegated to the
// core money model so the API can never accept a value the ledger would not.

import {
  FIAT_CURRENCIES,
  MoneyError,
  SETTLEMENT_TOKENS,
  add,
  equals,
  fiatCurrency,
  money,
  parseRate,
  tokenAmount,
} from '@ujira/core';
import type {
  FiatCurrencyCode,
  Money as CoreMoney,
  SettlementToken,
  TokenAmount as CoreTokenAmount,
  TokenAsset,
} from '@ujira/core';
import { z } from 'zod';

import { NetworkId } from './common.js';
import { WireFormatError } from './errors.js';

const INTEGER_TEXT = /^(0|[1-9][0-9]*)$/;
// i128 has at most 39 digits; the bound keeps the regex and BigInt off
// hostile input before the exact range check runs.
const MAX_AMOUNT_DIGITS = 39;

export const MinorUnits = z
  .string()
  .max(MAX_AMOUNT_DIGITS)
  .regex(INTEGER_TEXT, 'an integer count of minor units, as a string');

const FIAT_CODES = FIAT_CURRENCIES.map((c) => c.code) as [FiatCurrencyCode, ...FiatCurrencyCode[]];
const TOKEN_ASSETS = [...new Set(SETTLEMENT_TOKENS.map((t) => t.asset))] as [
  TokenAsset,
  ...TokenAsset[],
];

export const FiatCurrency = z.enum(FIAT_CODES);
export const TokenAssetCode = z.enum(TOKEN_ASSETS);

// The CAIP-2 namespace of a network is the chain it settles on. Read as
// data, so nothing here compares against a particular chain.
function tokenFor(asset: string, network: string): SettlementToken | undefined {
  const namespace = network.slice(0, network.indexOf(':'));
  return SETTLEMENT_TOKENS.find((t) => t.asset === asset && t.chain === namespace);
}

function inRange(build: () => unknown): boolean {
  try {
    build();
    return true;
  } catch (error) {
    if (error instanceof MoneyError) return false;
    throw error;
  }
}

export const Money = z
  .strictObject({
    amount: MinorUnits,
    currency: FiatCurrency,
    scale: z.number().int().min(0).max(18),
  })
  .superRefine((value, ctx) => {
    const minor = fiatCurrency(value.currency).minorUnits;
    if (value.scale !== minor) {
      ctx.addIssue({
        code: 'custom',
        path: ['scale'],
        message: `scale must be ${String(minor)} for ${value.currency}`,
      });
      return;
    }
    if (!inRange(() => money(value.amount, value.currency))) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'amount is out of range' });
    }
  });
export type Money = z.infer<typeof Money>;

export const TokenAmount = z
  .strictObject({
    amount: MinorUnits,
    asset: TokenAssetCode,
    network: NetworkId,
    scale: z.number().int().min(0).max(18),
  })
  .superRefine((value, ctx) => {
    const token = tokenFor(value.asset, value.network);
    if (token === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['asset'],
        message: 'asset does not settle on network',
      });
      return;
    }
    if (value.scale !== token.tokenScale) {
      ctx.addIssue({
        code: 'custom',
        path: ['scale'],
        message: `scale must be ${String(token.tokenScale)} for ${value.asset}`,
      });
      return;
    }
    if (!inRange(() => tokenAmount(value.amount, token.asset, token.chain))) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'amount is out of range' });
    }
  });
export type TokenAmount = z.infer<typeof TokenAmount>;

/**
 * An exchange rate as the anchor quoted it, in major units of `quote` per
 * major unit of `base`. Decimal text keeps the quote exact; clients that
 * compute with it turn it into an exact rational with the core parser.
 */
export const Rate = z
  .strictObject({
    rate: z
      .string()
      .max(74)
      .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'a plain positive decimal'),
    base: z.union([TokenAssetCode, FiatCurrency]),
    quote: FiatCurrency,
  })
  .superRefine((value, ctx) => {
    if (!inRange(() => parseRate(value.rate, { base: value.base, quote: value.quote }))) {
      ctx.addIssue({
        code: 'custom',
        path: ['rate'],
        message: 'rate must be positive, 36 digits at most',
      });
    }
  });
export type Rate = z.infer<typeof Rate>;

/** The wire form of a core fiat value. Only minor-unit values travel. */
export function toWireMoney(value: CoreMoney): Money {
  const minor = fiatCurrency(value.currency).minorUnits;
  if (value.scale !== minor) {
    throw new WireFormatError(
      `convert to minor units before sending, ${value.currency} uses ${String(minor)}`,
    );
  }
  return { amount: value.amount.toString(), currency: value.currency, scale: value.scale };
}

export function fromWireMoney(value: Money): CoreMoney {
  const parsed = Money.parse(value);
  return money(parsed.amount, parsed.currency);
}

/** The wire form of a core token value, pinned to the network it sits on. */
export function toWireToken(value: CoreTokenAmount, network: NetworkId): TokenAmount {
  const token = tokenFor(value.asset, network);
  if (token?.chain !== value.chain) {
    throw new WireFormatError('the token amount does not belong to that network');
  }
  return { amount: value.amount.toString(), asset: value.asset, network, scale: value.scale };
}

export function fromWireToken(value: TokenAmount): CoreTokenAmount {
  const parsed = TokenAmount.parse(value);
  const token = tokenFor(parsed.asset, parsed.network);
  if (token === undefined) {
    throw new WireFormatError('the asset does not settle on that network');
  }
  return tokenAmount(parsed.amount, token.asset, token.chain);
}

function parsedToken(value: unknown): TokenAmount | undefined {
  const parsed = TokenAmount.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Exact sum check for the schemas that carry totals. Any part that is not
 * a valid token amount, or a mix of tokens, makes it false rather than
 * throwing, because it runs inside a parse that reports its own issues.
 */
export function tokenSumEquals(parts: readonly unknown[], total: unknown): boolean {
  const wireParts = parts.map(parsedToken);
  const wireTotal = parsedToken(total);
  if (wireTotal === undefined || wireParts.length === 0) return false;
  // The core value has a chain but no network, so the network is checked
  // here: testnet and pubnet USDC are different money.
  const values: CoreTokenAmount[] = [];
  for (const part of wireParts) {
    if (part?.network !== wireTotal.network) return false;
    values.push(fromWireToken(part));
  }
  const [first, ...rest] = values;
  if (first === undefined) return false;
  try {
    return equals(
      rest.reduce((acc, part) => add(acc, part), first),
      fromWireToken(wireTotal),
    );
  } catch (error) {
    if (error instanceof MoneyError) return false;
    throw error;
  }
}
