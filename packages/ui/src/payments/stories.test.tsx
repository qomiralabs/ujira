// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { composeStories } from '@storybook/react-vite';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as mandateMeter from '../../stories/payments/mandate-meter.stories.tsx';
import * as payoutCard from '../../stories/payments/payout-card.stories.tsx';
import * as statusBadge from '../../stories/payments/status-badge.stories.tsx';
import { BADGE_STATUSES } from './status-badge.js';

afterEach(cleanup);

const CATALOGUE = {
  'Payments/StatusBadge': {
    module: statusBadge,
    required: ['Default', 'EveryStatus', 'Greyscale'],
  },
  'Payments/PayoutCard': {
    module: payoutCard,
    required: ['Default', 'WithAction', 'Failed', 'LongName', 'List'],
  },
  'Payments/MandateMeter': {
    module: mandateMeter,
    required: ['Default', 'CommittedAboveRemaining', 'ZeroBudget', 'Overrun'],
  },
} as const;

describe('payments stories', () => {
  for (const [title, { module, required }] of Object.entries(CATALOGUE)) {
    it(`${title} covers its cases`, () => {
      expect(module.default.title).toBe(title);
      expect(Object.keys(module)).toEqual(expect.arrayContaining([...required]));
    });

    for (const [name, Story] of Object.entries(composeStories(module))) {
      it(`${title} ${name} renders`, () => {
        const { container } = render(<Story />);
        expect(container.firstElementChild).not.toBeNull();
      });
    }
  }

  it('the greyscale story shows every state', () => {
    const { Greyscale } = composeStories(statusBadge);
    const { container } = render(<Greyscale />);
    expect(container.querySelectorAll('[data-slot="status-badge"]')).toHaveLength(
      BADGE_STATUSES.length,
    );
  });
});
