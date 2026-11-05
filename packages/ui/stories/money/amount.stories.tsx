// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { FIAT_CURRENCIES, I128_MAX, I128_MIN, money, tokenAmount } from '@ujira/core';
import type { FiatCurrencyCode } from '@ujira/core';
import { AmountProvider } from '../../src/money/amount-context.js';
import { Amount } from '../../src/money/amount.js';
import { TokenAmount } from '../../src/money/token-amount.js';

const meta = {
  title: 'Money/Amount',
  component: Amount,
  args: { minor: '2000000', currency: 'NGN' },
} satisfies Meta<typeof Amount>;

export default meta;
type Story = StoryObj<typeof meta>;

const CURRENCY_NAMES: Readonly<Record<FiatCurrencyCode, string>> = {
  USD: 'US dollar',
  NGN: 'Nigerian naira',
  KES: 'Kenyan shilling',
  GHS: 'Ghanaian cedi',
  ZAR: 'South African rand',
  PHP: 'Philippine peso',
  INR: 'Indian rupee',
  BRL: 'Brazilian real',
  COP: 'Colombian peso',
  MXN: 'Mexican peso',
  EUR: 'Euro',
  GBP: 'Pound sterling',
};

const TABLE = 'w-full max-w-md border-collapse text-body-s';
const HEAD = 'border-b border-rule py-2 font-medium text-text-secondary';
const CELL = 'border-b border-rule py-2';

export const Default: Story = {};

/** Every currency the money model knows, and the settlement token, at one amount. */
export const EveryCurrency: Story = {
  render: () => (
    <table className={TABLE}>
      <caption className="pb-2 text-start text-body-s text-text-secondary">
        1,234.56 in every currency UJIRA formats
      </caption>
      <thead>
        <tr>
          <th scope="col" className={`${HEAD} text-start`}>
            Currency
          </th>
          <th scope="col" className={`${HEAD} text-end`}>
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {FIAT_CURRENCIES.map(({ code }) => (
          <tr key={code}>
            <td className={CELL}>{CURRENCY_NAMES[code]}</td>
            <td className={`${CELL} text-end`}>
              <Amount minor="123456" currency={code} size="data" />
            </td>
          </tr>
        ))}
        <tr>
          <td className={CELL}>USDC</td>
          <td className={`${CELL} text-end`}>
            <TokenAmount value={tokenAmount('12345600000', 'USDC', 'stellar')} size="data" />
          </td>
        </tr>
      </tbody>
    </table>
  ),
};

/**
 * The four signs the brand mono face does not draw, at the hero size. Each
 * comes from the second mono face at the same advance, so the digits after
 * it sit on the same grid as a dollar amount.
 */
export const LaunchSigns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-3">
      {(['NGN', 'GHS', 'PHP', 'INR', 'USD'] as const).map((code) => (
        <Amount key={code} minor="2000000" currency={code} size="hero" className="text-text" />
      ))}
    </div>
  ),
};

/** Right aligned in a column, with tabular figures, the digits line up whatever the sign. */
export const Alignment: Story = {
  render: () => (
    <table className={TABLE}>
      <caption className="pb-2 text-start text-body-s text-text-secondary">
        Payouts this week
      </caption>
      <thead>
        <tr>
          <th scope="col" className={`${HEAD} text-start`}>
            Recipient
          </th>
          <th scope="col" className={`${HEAD} text-end`}>
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {(
          [
            ['Amara Okafor', '2000000', 'NGN', '1250'],
            ['Kwame Mensah', '45000', 'GHS', '3850'],
            ['Maria Santos', '1250000', 'PHP', '21900'],
            ['Wanjiru Kamau', '150000', 'KES', '1160'],
            ['Priya Nair', '-75000', 'INR', '-900'],
          ] as const
        ).map(([name, minor, currency, usd]) => (
          <tr key={name}>
            <td className={`${CELL} align-top`}>{name}</td>
            <td className={`${CELL} text-end`}>
              <Amount
                minor={minor}
                currency={currency}
                size="data"
                secondary={money(usd, 'USD')}
                className="text-text"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  ),
};

/** The three sign displays: a negative amount, a change shown with its sign, and a bare figure. */
export const Negative: Story = {
  render: () => (
    <dl className="grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-body-s">
      <dt className="text-text-secondary">Refunded</dt>
      <dd className="text-end">
        <Amount minor="-2000000" currency="NGN" />
      </dd>
      <dt className="text-text-secondary">Balance change</dt>
      <dd className="text-end">
        <Amount minor="150000" currency="KES" signDisplay="exceptZero" />
      </dd>
      <dt className="text-text-secondary">Balance change</dt>
      <dd className="text-end">
        <Amount minor="-150000" currency="KES" signDisplay="exceptZero" />
      </dd>
      <dt className="text-text-secondary">Fee returned</dt>
      <dd className="text-end">
        <Amount minor="-125" currency="USD" signDisplay="never" />
      </dd>
    </dl>
  ),
};

/** The largest and smallest amounts the model holds, exact to the last digit, never in exponent form. */
export const VeryLarge: Story = {
  render: () => (
    <div className="flex flex-col items-end gap-2">
      <Amount minor={I128_MAX} currency="USD" size="data" />
      <Amount minor={I128_MIN} currency="NGN" size="data" />
      <Amount minor="99999999999999999" currency="INR" size="data" />
    </div>
  ),
};

/**
 * Arabic and Hebrew. Each amount is its own right to left run, so the
 * negative amount is the positive one with a sign, and nothing else moves.
 */
export const RightToLeft: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {(['ar', 'he'] as const).map((locale) => (
        <div key={locale} lang={locale} dir="rtl" className="flex flex-col items-start gap-1">
          <AmountProvider locale={locale} corridorCurrencies={['USD', 'MXN']}>
            <Amount minor="123456" currency="USD" />
            <Amount minor="-123456" currency="USD" />
            <Amount minor="2000000" currency="NGN" />
            <Amount minor="-2000000" currency="NGN" />
          </AmountProvider>
        </div>
      ))}
    </div>
  ),
};

/**
 * A principal whose corridors include two dollar currencies sees the code on
 * every dollar amount. A recipient never does.
 */
export const AmbiguousDollar: Story = {
  render: () => (
    <div className="grid max-w-md gap-6 sm:grid-cols-2">
      <section className="flex flex-col gap-1">
        <h3 className="text-body-s font-medium text-text-secondary">Principal, US and Colombia</h3>
        <AmountProvider locale="en" corridorCurrencies={['USD', 'COP', 'NGN']}>
          <Amount minor="9600" currency="USD" />
          <Amount minor="150000" currency="COP" />
          <Amount minor="2000000" currency="NGN" />
        </AmountProvider>
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="text-body-s font-medium text-text-secondary">Recipient</h3>
        <Amount minor="9600" currency="USD" />
        <Amount minor="150000" currency="COP" />
      </section>
    </div>
  ),
};

/** The hero amount on a payout: local currency first, the USDC that settled it under it. */
export const Hero: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-1">
      <span className="text-body-s text-text-secondary">Wanjiru Kamau receives</span>
      <Amount
        minor="1250000"
        currency="KES"
        size="hero"
        secondary={tokenAmount('966000000', 'USDC', 'stellar')}
        className="items-start text-text"
      />
    </div>
  ),
};
