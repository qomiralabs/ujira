// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './dropdown-menu.js';

afterEach(cleanup);

function Switcher(props: { inline?: boolean } = {}) {
  return (
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>Annotation team</DropdownMenuTrigger>
      <DropdownMenuContent {...props}>
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        <DropdownMenuRadioGroup value="annotation">
          <DropdownMenuRadioItem value="annotation">Annotation team</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="bounties">Bounties</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe('DropdownMenu', () => {
  it('renders in a portal by default and in place when asked', () => {
    const { container, rerender } = render(<Switcher />);
    expect(container.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
    expect(screen.getByRole('menu')).toBeTruthy();

    // A menu inside a modal dialog cannot be portalled: the dialog makes
    // everything outside it inert, so the menu would open unusable.
    rerender(<Switcher inline />);
    expect(container.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull();
  });

  it('marks the chosen row with a ground as well as a check, never colour alone', () => {
    render(<Switcher />);
    const chosen = screen.getByRole('menuitemradio', { name: /Annotation team/ });
    expect(chosen.getAttribute('aria-checked')).toBe('true');
    expect(chosen.className).toContain('data-[state=checked]:bg-bg');
    expect(chosen.querySelector('svg')).not.toBeNull();
  });

  it('keeps saffron off the selection marker, which is not the one thing to do', () => {
    render(<Switcher />);
    const chosen = screen.getByRole('menuitemradio', { name: /Annotation team/ });
    expect(chosen.className).not.toContain('accent');
    expect(chosen.querySelector('svg')?.getAttribute('stroke-width')).toBe('1.5');
  });

  it('sets the item height from the density token, so compact mode reaches it', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Export CSV</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.getByRole('menuitem', { name: 'Export CSV' }).className).toContain('h-9');
  });

  it('uses the overlay radius and the one overlay shadow', () => {
    render(<Switcher />);
    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('rounded-overlay');
    expect(menu.className).toContain('shadow-overlay');
  });

  it('lets a caller set the width, so a panel can match its trigger', () => {
    // The menu does not impose a width: an actions menu sizes to its rows. A
    // switcher panel asks for its trigger's width, and that must survive the
    // class merge rather than lose to the default minimum.
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Annotation team</DropdownMenuTrigger>
        <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
          <DropdownMenuItem>Annotation team</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const classes = screen.getByRole('menu').className;
    expect(classes).toContain('w-(--radix-dropdown-menu-trigger-width)');
    expect(classes).toContain('min-w-56');
    expect(classes).not.toContain('min-w-48');
  });

  it('marks a danger item with the blocked token and a word', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem variant="danger">Revoke mandate</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.getByRole('menuitem', { name: 'Revoke mandate' }).className).toContain(
      'text-blocked',
    );
  });
});
