// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { Slot, Slottable } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { FOCUS_RING } from './focus-ring.js';

export const buttonVariants = cva(
  [
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap select-none',
    'rounded-control border font-sans font-medium',
    'transition-[color,background-color,border-color] duration-150 ease-out motion-reduce:transition-none',
    'disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-wait',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    FOCUS_RING,
  ].join(' '),
  {
    variants: {
      variant: {
        // The one thing to do on a view. Use it once per view. Hover lifts
        // the coin to the lighter brand saffron, which keeps teal ink legible.
        primary: 'border-transparent bg-accent-fill text-teal-ink hover:bg-(--ujira-saffron-lift)',
        secondary: 'border-text-subtle bg-surface text-text hover:bg-rule',
        ghost: 'border-transparent bg-transparent text-text hover:bg-rule',
        // Pause, revoke and delete. Ask for confirmation before acting.
        danger: 'border-blocked bg-surface text-blocked hover:bg-bg',
      },
      size: {
        sm: 'h-8 px-3 text-body-s',
        md: 'h-10 px-4 text-body-s',
        lg: 'h-12 px-6 text-body',
        icon: 'size-10',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Render the single child element, such as a link, with the button styles. */
  asChild?: boolean;
  /**
   * Shows a busy icon before the label and blocks clicks. The label stays, so
   * the button keeps its size and its accessible name.
   */
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  type,
  onClick,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  // A loading button stays focusable, so a keyboard user who just pressed it
  // keeps their place. It is marked busy and disabled, and ignores clicks.
  const handleClick: ButtonProps['onClick'] = loading
    ? (event) => {
        event.preventDefault();
      }
    : onClick;
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...(asChild ? {} : { type: type ?? 'button', disabled })}
      {...(loading ? { 'aria-busy': true, 'aria-disabled': true } : {})}
      {...props}
      onClick={handleClick}
    >
      {loading ? (
        <LoaderCircle
          data-loading=""
          aria-hidden="true"
          strokeWidth={1.5}
          className="motion-safe:animate-spin"
        />
      ) : null}
      <Slottable>{children}</Slottable>
    </Comp>
  );
}
