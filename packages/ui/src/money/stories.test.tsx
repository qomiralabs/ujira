// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { composeStories } from '@storybook/react-vite';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as amount from '../../stories/money/amount.stories.tsx';

afterEach(cleanup);

// The cases the money stories exist to show: every currency, the four signs
// from the second mono face, alignment, negative and very large amounts,
// right to left locales and the ambiguous dollar.
const REQUIRED = [
  'Default',
  'EveryCurrency',
  'LaunchSigns',
  'Alignment',
  'Negative',
  'VeryLarge',
  'RightToLeft',
  'AmbiguousDollar',
  'Hero',
];

describe('money stories', () => {
  it('covers every case', () => {
    const names = Object.keys(amount).filter((key) => key !== 'default');
    expect(names).toEqual(expect.arrayContaining(REQUIRED));
    expect(amount.default.title).toBe('Money/Amount');
  });

  for (const [name, Story] of Object.entries(composeStories(amount))) {
    it(`${name} renders amounts`, () => {
      const { container } = render(<Story />);
      expect(container.querySelector('[data-slot="amount-value"]')).not.toBeNull();
    });
  }

  it('lists every fiat currency and the settlement token', () => {
    const { EveryCurrency } = composeStories(amount);
    const { container } = render(<EveryCurrency />);
    // Twelve fiat currencies and USDC.
    expect(container.querySelectorAll('[data-slot="amount-value"]')).toHaveLength(13);
  });
});
