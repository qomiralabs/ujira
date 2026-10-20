// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectSwitcher } from './project-switcher';

function open(): void {
  fireEvent.keyDown(screen.getByRole('button', { name: /Choose a different project/ }), {
    key: 'Enter',
  });
}

describe('ProjectSwitcher', () => {
  it('names the current project on the trigger', () => {
    render(<ProjectSwitcher project="grants" onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', {
      name: 'Project: Community grants. Choose a different project',
    });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.textContent).toContain('CG');
  });

  it('lists every project with the current one checked, and switches', () => {
    const onChange = vi.fn();
    render(<ProjectSwitcher project="labelling" onChange={onChange} />);
    open();
    const items = screen.getAllByRole('menuitemradio');
    // A project is named by the principal, so the name is the whole content.
    expect(items.map((item) => item.textContent)).toEqual([
      'Labelling payouts',
      'Bug bounties',
      'Community grants',
    ]);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Bug bounties/ }));
    expect(onChange).toHaveBeenCalledWith('bounties');
  });

  it('marks the chosen project with the brand stroke in the text colour, never saffron', () => {
    const { container } = render(<ProjectSwitcher project="bounties" onChange={vi.fn()} />);
    open();
    const chosen = screen.getByRole('menuitemradio', { name: /Bug bounties/ });
    const marker = chosen.querySelector('svg');
    expect(marker).not.toBeNull();
    // The brand grid: a 1.5px stroke that does not thin when drawn small.
    expect(marker?.getAttribute('stroke-width')).toBe('1.5');
    expect(marker?.querySelector('path')?.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    expect(marker?.getAttribute('stroke')).toBe('currentColor');
    // Saffron is the coin, the amount, the one primary action and the focus
    // ring. A selection marker is none of those, so it never wears saffron.
    // The indicator wrapper sets the colour, which the stroke inherits.
    // The indicator wrapper sets the colour, which the stroke inherits.
    const indicator = marker?.parentElement;
    expect(indicator?.classList.contains('text-text')).toBe(true);
    for (const element of container.querySelectorAll('[class]')) {
      expect(element.getAttribute('class')).not.toMatch(/accent|saffron/);
    }
  });

  it('gives the chosen row a raised ground, so selection never rests on colour alone', () => {
    render(<ProjectSwitcher project="bounties" onChange={vi.fn()} />);
    open();
    const chosen = screen.getByRole('menuitemradio', { name: /Bug bounties/ });
    const other = screen.getByRole('menuitemradio', { name: /Community grants/ });
    expect(chosen.className).toContain('data-[state=checked]:bg-bg');
    // The mark is carried as well as the ground, not instead of it.
    expect(chosen.querySelector('svg')).not.toBeNull();
    expect(other.querySelector('svg')).toBeNull();
    expect(chosen.getAttribute('aria-checked')).toBe('true');
    expect(other.getAttribute('aria-checked')).toBe('false');
  });

  it('carries no colour mode of its own, so it follows the dashboard theme', () => {
    render(<ProjectSwitcher project="labelling" onChange={vi.fn()} />);
    open();
    const menu = screen.getByRole('menu');
    // A fixed data-theme here would pin the panel to one mode and ignore the
    // dashboard setting, which is what the tokens are for.
    expect(menu.closest('[data-theme]')).toBeNull();
    for (const element of [menu, ...menu.querySelectorAll('*')]) {
      expect(element.getAttribute('data-theme')).toBeNull();
      // No fixed colour: every colour comes from a token class.
      expect(element.getAttribute('style') ?? '').not.toMatch(/#[0-9a-f]{3,8}|rgb|hsl/i);
    }
  });

  it('sizes the panel to the control that opens it', () => {
    render(<ProjectSwitcher project="labelling" onChange={vi.fn()} />);
    open();
    expect(screen.getByRole('menu').className).toContain('w-(--radix-dropdown-menu-trigger-width)');
  });

  it('renders the menu in place when asked, for use inside a modal dialog', () => {
    const { container } = render(<ProjectSwitcher project="labelling" onChange={vi.fn()} inline />);
    open();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });
});
