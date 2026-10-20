// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, buttonVariants } from './button.js';
import { FOCUS_RING } from './focus-ring.js';

afterEach(cleanup);

function classesOf(element: HTMLElement): string[] {
  return element.className.split(/\s+/).filter(Boolean);
}

describe('Button', () => {
  it('variants map to the brand tokens', () => {
    const expected = {
      // Saffron is the one thing to do on a view, with teal ink on it.
      primary: ['bg-accent-fill', 'text-teal-ink'],
      secondary: ['bg-surface', 'text-text', 'border-text-subtle'],
      ghost: ['bg-transparent', 'text-text'],
      // A destructive action is not a payment, so it takes no payment status
      // colour. It is marked by the strongest border of the four, and by the
      // icon the caller gives it.
      danger: ['bg-surface', 'text-text', 'border-text', 'border-2'],
    } as const;
    for (const [variant, tokens] of Object.entries(expected)) {
      const classes = buttonVariants({ variant: variant as keyof typeof expected }).split(' ');
      for (const token of tokens) expect(classes, variant).toContain(token);
    }
    // Only the primary variant uses the saffron fill.
    for (const variant of ['secondary', 'ghost', 'danger'] as const) {
      expect(buttonVariants({ variant })).not.toContain('accent-fill');
    }
  });

  it('tells danger apart from secondary by build, not by colour', () => {
    const danger = buttonVariants({ variant: 'danger' }).split(' ');
    const secondary = buttonVariants({ variant: 'secondary' }).split(' ');
    // Same ground and same text colour, so the difference has to be
    // structural: a double weight border, and the ruled cap the component
    // draws around the required icon.
    expect(danger).toContain('bg-surface');
    expect(secondary).toContain('bg-surface');
    expect(danger).toContain('border-2');
    expect(secondary).not.toContain('border-2');

    render(
      <>
        <Button variant="danger" icon={<span data-testid="icon" />}>
          Pause mandate
        </Button>
        <Button variant="secondary">Export CSV</Button>
      </>,
    );
    const dangerButton = screen.getByRole('button', { name: 'Pause mandate' });
    const cap = dangerButton.querySelector('[data-button-cap]');
    expect(cap).not.toBeNull();
    expect(cap?.getAttribute('aria-hidden')).toBe('true');
    expect(cap?.className).toContain('border-r-2');
    expect(cap?.querySelector('[data-testid="icon"]')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Export CSV' }).querySelector('[data-button-cap]'),
    ).toBeNull();
  });

  it('does not compile a danger button without an icon', () => {
    // The icon is what says "destructive" once the colour is gone, so it is
    // part of the variant rather than a convention someone can forget.
    // @ts-expect-error variant="danger" requires an icon
    const missing = <Button variant="danger">Pause mandate</Button>;
    expect(missing).toBeTruthy();
  });

  it('puts the busy mark in the cap, so a danger button keeps its shape', () => {
    render(
      <Button variant="danger" loading icon={<span data-testid="icon" />}>
        Pausing
      </Button>,
    );
    const cap = screen.getByRole('button').querySelector('[data-button-cap]');
    expect(cap?.querySelector('svg[data-loading]')).not.toBeNull();
    expect(cap?.querySelector('[data-testid="icon"]')).toBeNull();
  });

  it('keeps the payment status colours off every variant', () => {
    // Paid, waiting and blocked describe a payment. An action never borrows
    // one, so a button can never be mistaken for a status.
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const classes = buttonVariants({ variant });
      for (const status of ['paid', 'waiting', 'blocked']) {
        expect(classes, `${variant} ${status}`).not.toContain(status);
      }
    }
  });

  it('defaults to the secondary variant at the medium size', () => {
    render(<Button>Export CSV</Button>);
    const button = screen.getByRole('button', { name: 'Export CSV' });
    expect(classesOf(button)).toEqual(expect.arrayContaining(['bg-surface', 'h-10']));
    expect(button.getAttribute('type')).toBe('button');
  });

  it('uses the 6px control radius, no shadow and the saffron focus ring', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const classes = buttonVariants({ variant }).split(' ');
      expect(classes).toContain('rounded-control');
      expect(classes.filter((c) => c.startsWith('shadow'))).toEqual([]);
      for (const ring of FOCUS_RING.split(' ')) expect(classes).toContain(ring);
    }
  });

  it.each([
    ['sm', 'h-8'],
    ['md', 'h-10'],
    ['lg', 'h-12'],
    ['icon', 'size-10'],
  ] as const)('size %s sets %s', (size, height) => {
    expect(buttonVariants({ size }).split(' ')).toContain(height);
  });

  it('keeps the label, shows a busy state and blocks clicks while loading', () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" loading onClick={onClick}>
        Approve payout
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Approve payout' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.querySelector('svg[data-loading]')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps focus on a loading button, so a keyboard press is not lost', () => {
    render(<Button loading>Approving</Button>);
    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled')).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('does not let a loading click reach the row it sits in', () => {
    const onRowClick = vi.fn();
    const onClick = vi.fn();
    render(
      <div
        onClick={() => {
          onRowClick();
        }}
      >
        <Button loading onClick={onClick}>
          Approving
        </Button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('does not submit a form while loading', () => {
    const onSubmit = vi.fn((event: Event) => {
      event.preventDefault();
    });
    render(
      <form
        onSubmit={(event) => {
          onSubmit(event.nativeEvent);
        }}
      >
        <Button type="submit" loading>
          Create mandate
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('never animates the focus ring', () => {
    const classes = buttonVariants().split(' ');
    expect(classes).not.toContain('transition-colors');
    expect(classes).not.toContain('transition-all');
  });

  it('renders a leading icon from the icon prop', () => {
    render(<Button icon={<span data-testid="icon" />}>Export CSV</Button>);
    expect(screen.getByTestId('icon')).toBeTruthy();
  });

  it('draws the loading icon with the brand stroke', () => {
    render(<Button loading>Saving</Button>);
    const icon = screen.getByRole('button').querySelector('svg[data-loading]');
    expect(icon?.getAttribute('stroke-width')).toBe('1.5');
  });

  it('swaps the spinner for a still mark under reduced motion', () => {
    render(<Button loading>Saving</Button>);
    const button = screen.getByRole('button');
    const spinner = button.querySelector('svg[data-loading=""]');
    const still = button.querySelector('svg[data-loading="static"]');
    // A frozen spinner reads as broken, so only one of the two is ever shown.
    expect(spinner?.getAttribute('class')).toContain('motion-reduce:hidden');
    expect(still?.getAttribute('class')).toContain('hidden');
    expect(still?.getAttribute('class')).toContain('motion-reduce:block');
    expect(still?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is disabled when asked', () => {
    render(<Button disabled>Pause mandate</Button>);
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  });

  it('renders its child instead of a button with asChild', () => {
    render(
      <Button asChild variant="ghost">
        <a href="/receipts">Receipts</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Receipts' });
    expect(classesOf(link)).toContain('rounded-control');
    expect(link.hasAttribute('type')).toBe(false);
  });

  it('lets a caller class override a variant class', () => {
    render(<Button className="w-full">Continue</Button>);
    expect(classesOf(screen.getByRole('button'))).toContain('w-full');
  });
});
