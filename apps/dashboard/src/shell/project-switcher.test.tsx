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
