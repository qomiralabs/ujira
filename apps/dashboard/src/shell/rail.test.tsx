// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Rail } from './rail';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

describe('Rail', () => {
  it('sits on the dark tokens in both modes and holds the main navigation', () => {
    const { container } = render(<Rail project="labelling" onProjectChange={vi.fn()} />);
    const aside = container.querySelector('aside');
    expect(aside?.dataset['theme']).toBe('dark');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.getAllByRole('img', { name: 'UJIRA' })).toHaveLength(2);
  });

  it('collapses to icons and expands again, remembering the choice', () => {
    render(<Rail project="labelling" onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    expect(document.documentElement.dataset['rail']).toBe('collapsed');
    expect(screen.getByRole('link', { name: 'Payouts' }).getAttribute('title')).toBe('Payouts');
    fireEvent.click(screen.getByRole('button', { name: 'Expand navigation' }));
    expect(document.documentElement.dataset['rail']).toBeUndefined();
  });
});
