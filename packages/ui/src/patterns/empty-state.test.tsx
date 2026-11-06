// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../primitives/button.js';
import { EmptyState, type EmptyStateProps } from './empty-state.js';

afterEach(cleanup);

describe('EmptyState', { timeout: 30_000 }, () => {
  it('every variant requires a message and an action', () => {
    // The type half: leaving out either one does not compile, in either variant.
    // @ts-expect-error nothing yet needs a message
    const noMessage: EmptyStateProps = { variant: 'nothing-yet', action: <Button>Fund</Button> };
    // @ts-expect-error nothing yet needs an action
    const noAction: EmptyStateProps = { variant: 'nothing-yet', message: 'No payouts yet.' };
    // @ts-expect-error no results needs a message
    const noResultsMessage: EmptyStateProps = {
      variant: 'no-results',
      action: <Button>Clear</Button>,
    };
    // @ts-expect-error no results needs an action
    const noResultsAction: EmptyStateProps = { variant: 'no-results', message: 'None match.' };
    expect([noMessage, noAction, noResultsMessage, noResultsAction]).toHaveLength(4);

    // The render half: each variant shows its message and its one next step.
    for (const variant of ['nothing-yet', 'no-results'] as const) {
      const { unmount } = render(
        <EmptyState
          variant={variant}
          title="No payouts yet"
          message="Payouts appear here the moment a mandate requests one."
          action={<Button variant="primary">Set up a mandate</Button>}
        />,
      );
      const region = screen.getByRole('region', { name: 'No payouts yet' });
      expect(region.textContent).toContain(
        'Payouts appear here the moment a mandate requests one.',
      );
      expect(region.querySelectorAll('button')).toHaveLength(1);
      expect(region.getAttribute('data-variant')).toBe(variant);
      unmount();
    }
  });

  it('draws an icon for each variant, hidden from assistive technology', () => {
    const { container, rerender } = render(
      <EmptyState
        variant="nothing-yet"
        message="No receipts yet."
        action={<Button>Open payouts</Button>}
      />,
    );
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    rerender(
      <EmptyState
        variant="no-results"
        message="No receipts match."
        action={<Button>Clear filters</Button>}
      />,
    );
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is a quiet card: a 1px rule and the card radius, no shadow', () => {
    render(
      <EmptyState variant="nothing-yet" message="No receipts yet." action={<Button>Go</Button>} />,
    );
    const classes = screen.getByRole('region').className.split(' ');
    expect(classes).toEqual(expect.arrayContaining(['border', 'border-rule', 'rounded-card']));
    expect(classes.filter((name) => name.startsWith('shadow'))).toEqual([]);
  });

  it('takes the brand icon the caller names', () => {
    const { container } = render(
      <EmptyState
        variant="nothing-yet"
        icon="mandate"
        message="No mandates yet."
        action={<Button>Set up a mandate</Button>}
      />,
    );
    expect(container.querySelector('svg')?.getAttribute('data-icon')).toBe('mandate');
  });
});
