// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buttonClass } from './button';
import { EmptyState } from './empty-state';
import { ErrorState } from './error-state';
import { PageHeader } from './page-header';
import { PageSkeleton, Skeleton } from './skeleton';

describe('patterns', () => {
  it('keeps saffron for the primary button only', () => {
    expect(buttonClass('primary')).toContain('bg-accent-fill');
    expect(buttonClass('secondary')).not.toContain('accent');
    expect(buttonClass('ghost', 'w-full')).toMatch(/ w-full$/);
  });

  it('gives a page one heading and its summary', () => {
    render(<PageHeader title="Payouts" summary="Every payout." action={<button>Act</button>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Payouts' })).toBeTruthy();
    expect(screen.getByText('Every payout.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Act' })).toBeTruthy();
  });

  it('labels an empty state by its title', () => {
    render(
      <EmptyState icon={{ brand: 'receipt' }} title="No receipts yet" action={<a href="/x">Go</a>}>
        Receipts appear here.
      </EmptyState>,
    );
    expect(screen.getByRole('region', { name: 'No receipts yet' })).toBeTruthy();
    expect(screen.getByText('Receipts appear here.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go' })).toBeTruthy();
  });

  it('announces an error with a reference to quote, when there is one', () => {
    const { rerender } = render(
      <ErrorState title="Did not load" reference="abc123" actions={<button>Try again</button>}>
        Try again.
      </ErrorState>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Reference abc123');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    rerender(<ErrorState title="Did not load">Try again.</ErrorState>);
    expect(screen.getByRole('alert').textContent).not.toContain('Reference');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a loading status with skeleton blocks hidden from assistive technology', () => {
    const { container } = render(<PageSkeleton />);
    expect(screen.getByRole('status').textContent).toBe('Loading');
    const blocks = container.querySelectorAll('[data-skeleton]');
    expect(blocks.length).toBeGreaterThan(3);
    for (const block of blocks) expect(block.getAttribute('aria-hidden')).toBe('true');
    render(<Skeleton className="h-4 w-8" />);
  });
});
