// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { formatMoney as coreFormatMoney, formatTokenAmount, money, tokenAmount } from '@ujira/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmountProvider, useAmountSettings } from './amount-context.js';
import { Amount } from './amount.js';
import { formatMoney, localeDirection } from './format.js';
import { TokenAmount } from './token-amount.js';

afterEach(cleanup);

/** The text of every amount on the page, in document order. */
function amounts(): string[] {
  return [...document.querySelectorAll('[data-slot="amount-value"]')].map(
    (node) => node.textContent,
  );
}

describe('formatMoney', () => {
  it('builds Money from minor units and hands it to the core formatter', () => {
    expect(formatMoney(2_000_000n, 'NGN', 'en')).toBe('₦20,000.00');
    expect(formatMoney('150000', 'KES', 'en')).toBe('KSh\u00a01,500.00');
    expect(formatMoney('-9600', 'USD', 'en')).toBe(
      coreFormatMoney(money('-9600', 'USD'), { locale: 'en' }),
    );
  });

  it('passes the dollar code display through', () => {
    expect(formatMoney(9600n, 'USD', 'en', { currencyCode: 'whenAmbiguous' })).toBe(
      '$96.00\u00a0USD',
    );
    expect(formatMoney(9600n, 'USD', 'en', { currencyCode: 'never' })).toBe('$96.00');
  });

  it('refuses a decimal string, so a major unit amount cannot pass for minor units', () => {
    expect(() => formatMoney('96.00', 'USD', 'en')).toThrow();
  });
});

describe('localeDirection', () => {
  it.each([
    ['en', 'ltr'],
    ['fr-FR', 'ltr'],
    ['yo-NG', 'ltr'],
    ['ar', 'rtl'],
    ['ar-EG', 'rtl'],
    ['he', 'rtl'],
  ] as const)('%s is %s', (locale, direction) => {
    expect(localeDirection(locale)).toBe(direction);
  });

  // Engines differ: some have getTextInfo, some only the older textInfo
  // accessor, some neither. Each is replaced on the prototype for one call.
  function withTextInfo(
    method: PropertyDescriptor,
    accessor: PropertyDescriptor,
    run: () => void,
  ): void {
    const proto = Intl.Locale.prototype;
    const saved = ['getTextInfo', 'textInfo'].map(
      (key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const,
    );
    Object.defineProperty(proto, 'getTextInfo', { ...method, configurable: true });
    Object.defineProperty(proto, 'textInfo', { ...accessor, configurable: true });
    try {
      run();
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor === undefined) Reflect.deleteProperty(proto, key);
        else Object.defineProperty(proto, key, descriptor);
      }
    }
  }

  const throwing = () => {
    throw new Error('no text info');
  };

  it('falls back to the likely script on an engine without text info', () => {
    withTextInfo({ value: throwing }, { get: throwing }, () => {
      expect(localeDirection('ar')).toBe('rtl');
      expect(localeDirection('he')).toBe('rtl');
      expect(localeDirection('en')).toBe('ltr');
    });
  });

  it('reads the older text info accessor when the method is missing', () => {
    withTextInfo({ value: undefined }, { get: () => ({ direction: 'rtl' }) }, () => {
      expect(localeDirection('en')).toBe('rtl');
    });
  });
});

describe('Amount', () => {
  it('sets every amount in the mono face with tabular figures, on one line', () => {
    render(<Amount minor={2_000_000n} currency="NGN" />);
    const value = screen.getByText('₦20,000.00');
    expect(value.className).toContain('font-mono');
    expect(value.className).toContain('tabular-nums');
    expect(value.className).toContain('whitespace-nowrap');
  });

  it('takes a Money or minor units and a currency, with the same result', () => {
    render(
      <>
        <Amount value={money('150000', 'KES')} />
        <Amount minor="150000" currency="KES" />
      </>,
    );
    expect(amounts()).toEqual(['KSh\u00a01,500.00', 'KSh\u00a01,500.00']);
  });

  it('principal view with USD and COP corridors shows the ISO code on every dollar amount', () => {
    render(
      <AmountProvider locale="en" corridorCurrencies={['USD', 'COP', 'NGN']}>
        <Amount minor="9600" currency="USD" />
        <Amount minor="150000" currency="COP" />
        <Amount minor="2000000" currency="NGN" />
      </AmountProvider>,
    );
    // Every dollar amount carries its code, and a currency with a sign of its
    // own is left as it is.
    expect(amounts()).toEqual(['$96.00\u00a0USD', '$1,500.00\u00a0COP', '₦20,000.00']);
  });

  it('a principal view with one dollar currency keeps the plain sign', () => {
    render(
      <AmountProvider locale="en" corridorCurrencies={['USD', 'NGN', 'USDC']}>
        <Amount minor="9600" currency="USD" />
      </AmountProvider>,
    );
    expect(amounts()).toEqual(['$96.00']);
  });

  it('recipient surface keeps the plain dollar sign', () => {
    // A recipient surface never sets the corridors, so even a provider that
    // only sets the locale leaves the sign alone.
    render(
      <>
        <Amount minor="9600" currency="USD" />
        <AmountProvider locale="en">
          <Amount minor="150000" currency="COP" />
        </AmountProvider>
      </>,
    );
    expect(amounts()).toEqual(['$96.00', '$1,500.00']);
  });

  it('negative and positive amounts lay out the same in ar', () => {
    render(
      <AmountProvider locale="ar" corridorCurrencies={['USD', 'MXN']}>
        <Amount minor="123456" currency="USD" />
        <Amount minor="-123456" currency="USD" />
      </AmountProvider>,
    );
    const [positive, negative] = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="amount-value"]'),
    ];
    if (positive === undefined || negative === undefined) throw new Error('two amounts expected');
    // Both are their own right to left run, isolated from the text around
    // them, so a neighbouring word cannot pull the sign or the code across.
    expect(positive.getAttribute('dir')).toBe('rtl');
    expect(negative.getAttribute('dir')).toBe('rtl');
    expect(positive.textContent).toBe(
      coreFormatMoney(money('123456', 'USD'), { locale: 'ar', currencyCode: 'whenAmbiguous' }),
    );
    // The negative is the positive with the sign added in front of the
    // digits and nothing else moved: the digits, the symbol and the isolated
    // code stay in the same order.
    expect(negative.textContent.replace('\u200e\u2212', '')).toBe(positive.textContent);
  });

  it('marks a left to right locale as left to right, so a right to left page cannot reorder it', () => {
    render(<Amount minor="-9600" currency="USD" />);
    expect(screen.getByText('\u2212$96.00').getAttribute('dir')).toBe('ltr');
  });

  it('shows a secondary amount second, smaller and announced as an equivalent', () => {
    render(
      <Amount
        minor="2000000"
        currency="NGN"
        secondary={tokenAmount('125000000', 'USDC', 'stellar')}
      />,
    );
    expect(amounts()).toEqual(['₦20,000.00', '12.50\u00a0USDC']);
    const secondary = document.querySelector('[data-slot="amount-secondary"]');
    expect(secondary?.className).toContain('text-text-secondary');
    // The word that ties the two together is for screen readers only.
    expect(secondary?.textContent).toBe('equal to 12.50\u00a0USDC');
    expect(secondary?.querySelector('.sr-only')?.textContent).toBe('equal to');
  });

  it('takes a fiat secondary amount and its own label', () => {
    render(
      <Amount
        minor="2000000"
        currency="NGN"
        secondary={money('1250', 'USD')}
        secondaryLabel="about"
      />,
    );
    expect(document.querySelector('[data-slot="amount-secondary"]')?.textContent).toBe(
      'about $12.50',
    );
  });

  it('shows the sign as asked', () => {
    render(
      <>
        <Amount minor="9600" currency="USD" signDisplay="exceptZero" />
        <Amount minor="-9600" currency="USD" signDisplay="exceptZero" />
        <Amount minor="0" currency="USD" signDisplay="exceptZero" />
        <Amount minor="-9600" currency="USD" signDisplay="never" />
        <Amount minor="9600" currency="USD" signDisplay="never" />
      </>,
    );
    expect(amounts()).toEqual(['+$96.00', '\u2212$96.00', '$0.00', '$96.00', '$96.00']);
  });

  it('puts a plus sign where the locale puts its minus sign', () => {
    render(
      <AmountProvider locale="ar">
        <Amount minor="9600" currency="NGN" signDisplay="exceptZero" />
      </AmountProvider>,
    );
    const negative = coreFormatMoney(money('-9600', 'NGN'), { locale: 'ar' });
    expect(amounts()).toEqual([negative.replace('\u2212', '+')]);
  });

  it.each([
    ['data', 'text-data'],
    ['large', 'text-amount-l'],
    ['hero', 'sm:text-amount-xl'],
  ] as const)('size %s sets %s', (size, step) => {
    render(<Amount minor="9600" currency="USD" size={size} />);
    expect(screen.getByText('$96.00').className).toContain(step);
  });

  it('keeps the hero amount on one line by stepping down on a narrow screen', () => {
    render(<Amount minor="9600" currency="USD" size="hero" />);
    const classes = screen.getByText('$96.00').className.split(' ');
    expect(classes).toContain('text-amount-l');
    expect(classes).toContain('sm:text-amount-xl');
  });

  it('throws for an untyped caller that passes nothing to show', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // @ts-expect-error an amount needs a value, or minor units and a currency
    expect(() => render(<Amount minor="9600" />)).toThrow('minor units and a currency');
    quiet.mockRestore();
  });

  it('inherits the size around it by default', () => {
    render(<Amount minor="9600" currency="USD" />);
    expect(screen.getByText('$96.00').className).not.toMatch(/\btext-(data|amount)/);
  });
});

describe('TokenAmount', () => {
  it('shows USDC with the core token formatter and the locale from the provider', () => {
    const value = tokenAmount('12345678', 'USDC', 'stellar');
    render(
      <>
        <TokenAmount value={value} />
        <AmountProvider locale="fr-FR">
          <TokenAmount value={tokenAmount('12345678900', 'USDC', 'stellar')} />
        </AmountProvider>
      </>,
    );
    expect(amounts()).toEqual([
      formatTokenAmount(value, { locale: 'en' }),
      formatTokenAmount(tokenAmount('12345678900', 'USDC', 'stellar'), { locale: 'fr-FR' }),
    ]);
    expect(amounts()[0]).toBe('1.23\u00a0USDC');
  });

  it('is set like every other amount', () => {
    render(<TokenAmount value={tokenAmount('12345678', 'USDC', 'stellar')} size="data" />);
    // getByText collapses the no-break space in the page text to a plain one.
    const node = screen.getByText('1.23 USDC');
    expect(node.className).toContain('font-mono');
    expect(node.className).toContain('tabular-nums');
    expect(node.className).toContain('text-data');
  });
});

describe('AmountProvider', () => {
  function Settings() {
    const { locale, currencyCode } = useAmountSettings();
    return <output>{`${locale} ${currencyCode}`}</output>;
  }

  it('defaults to English with the plain dollar sign', () => {
    render(<Settings />);
    expect(screen.getByRole('status').textContent).toBe('en never');
  });

  it('decides the dollar code once from the corridors', () => {
    render(
      <AmountProvider locale="pt-BR" corridorCurrencies={['BRL', 'MXN', 'USD']}>
        <Settings />
      </AmountProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('pt-BR whenAmbiguous');
  });

  it('refuses a corridor currency the money model does not know', () => {
    // React reports the thrown render on the console before rethrowing it.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        // @ts-expect-error CAD is not a corridor currency yet
        <AmountProvider locale="en" corridorCurrencies={['USD', 'CAD']}>
          <Settings />
        </AmountProvider>,
      ),
    ).toThrow();
    quiet.mockRestore();
  });
});
