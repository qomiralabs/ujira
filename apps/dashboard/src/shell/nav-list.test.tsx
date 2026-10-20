// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NavList } from './nav-list';

const pathname = vi.hoisted(() => {
  const state: { current: string | null } = { current: '/approvals' };
  return state;
});
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

describe('NavList', () => {
  it('links every primary section and marks the current one', () => {
    render(<NavList project="labelling" group="primary" />);
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Overview',
      'Payouts',
      'Approvals',
      'Mandates',
      'Recipients',
      'Receipts',
      'Funding',
      'Corridors',
    ]);
    expect(screen.getByRole('link', { name: 'Approvals' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'Payouts' }).getAttribute('aria-current')).toBeNull();
    // The default project adds nothing to the URL.
    expect(screen.getByRole('link', { name: 'Payouts' }).getAttribute('href')).toBe('/payouts');
  });

  it('keeps the selected project in every link', () => {
    pathname.current = null;
    render(<NavList project="bounties" group="secondary" />);
    expect(screen.getByRole('link', { name: 'Developers' }).getAttribute('href')).toBe(
      '/developers?project=bounties',
    );
    expect(screen.queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('shows the label as a tooltip when collapsed and reports navigation', () => {
    const onNavigate = vi.fn();
    render(<NavList project="labelling" group="secondary" collapsed onNavigate={onNavigate} />);
    const settings = screen.getByRole('link', { name: 'Settings' });
    expect(settings.getAttribute('title')).toBe('Settings');
    fireEvent.click(settings);
    expect(onNavigate).toHaveBeenCalledOnce();
  });
});
