// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { Slot, Slottable } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Circle, LoaderCircle } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
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
        /*
         * Pause, revoke and delete. It takes no payment status colour, because
         * blocked red means a payment was blocked, failed or rejected and an
         * action is not a payment; the red belongs to the confirmation step
         * that follows. So it is told apart from secondary by its build, not
         * its colour: a double weight border, and an icon in a ruled cap on
         * the leading edge. The icon is required by the type, not asked for in
         * a comment.
         */
        danger:
          'border-2 border-text bg-surface text-text hover:bg-bg [&_[data-button-cap]]:border-text',
      },
      size: {
        sm: 'h-8 px-3 text-body-s',
        md: 'h-10 px-4 text-body-s',
        lg: 'h-12 px-6 text-body',
        icon: 'size-10',
      },
      // The cap is drawn inside the padding, so a danger button keeps the
      // height and the label position of every other button its size.
      capped: {
        sm: 'pl-0 [&_[data-button-cap]]:h-8 [&_[data-button-cap]]:w-8',
        md: 'pl-0 [&_[data-button-cap]]:h-10 [&_[data-button-cap]]:w-10',
        lg: 'pl-0 [&_[data-button-cap]]:h-12 [&_[data-button-cap]]:w-12',
        icon: '',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
);

type Variant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
type Size = NonNullable<VariantProps<typeof buttonVariants>['size']>;

interface BaseButtonProps extends ComponentProps<'button'> {
  size?: Size;
  /** Render the single child element, such as a link, with the button styles. */
  asChild?: boolean;
  /**
   * Shows a busy icon before the label and blocks clicks. The label stays, so
   * the button keeps its size and its accessible name.
   */
  loading?: boolean;
  /**
   * An icon before the label, drawn at the brand stroke. Use `<BrandIcon />`
   * for the nine core ideas and Lucide for everything else.
   */
  icon?: ReactNode;
}

/**
 * A destructive action must say so without a colour, so the icon is part of
 * the variant rather than a convention: `variant="danger"` does not compile
 * without one.
 */
export type ButtonProps =
  | (BaseButtonProps & { variant?: Exclude<Variant, 'danger'> | undefined })
  | (BaseButtonProps & { variant: 'danger'; icon: ReactNode });

function BusyMark() {
  return (
    <>
      <LoaderCircle
        data-loading=""
        aria-hidden="true"
        strokeWidth={1.5}
        className="animate-spin motion-reduce:hidden"
      />
      {/*
       * A frozen spinner reads as broken, so under reduced motion the busy
       * mark is a closed circle: a still shape that looks meant.
       */}
      <Circle
        data-loading="static"
        aria-hidden="true"
        strokeWidth={1.5}
        className="hidden motion-reduce:block"
      />
    </>
  );
}

export function Button({
  className,
  variant,
  size = 'md',
  asChild = false,
  loading = false,
  disabled,
  type,
  onClick,
  icon,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  // The cap is what tells a destructive action apart from an ordinary one at
  // a glance, so only the danger variant draws it.
  const capped = variant === 'danger' && size !== 'icon';
  // A loading button stays focusable, so a keyboard user who just pressed it
  // keeps their place. It is marked busy and disabled, and swallows the click
  // rather than only ignoring it: a button inside a clickable table row would
  // otherwise still open the row, which is the thing the loading state exists
  // to prevent.
  const handleClick: ButtonProps['onClick'] = loading
    ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
      }
    : onClick;
  return (
    <Comp
      data-slot="button"
      className={cn(
        buttonVariants({ variant, size, ...(capped ? { capped: size } : {}) }),
        className,
      )}
      {...(asChild ? {} : { type: type ?? 'button', disabled })}
      {...(loading ? { 'aria-busy': true, 'aria-disabled': true } : {})}
      {...props}
      onClick={handleClick}
    >
      {capped ? (
        <span
          data-button-cap=""
          aria-hidden="true"
          className="mr-3 flex shrink-0 items-center justify-center self-stretch border-r-2"
        >
          {loading ? <BusyMark /> : icon}
        </span>
      ) : (
        <>
          {loading ? <BusyMark /> : null}
          {!loading && icon !== undefined ? icon : null}
        </>
      )}
      <Slottable>{children}</Slottable>
    </Comp>
  );
}
