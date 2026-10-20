// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const BASE =
  'inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-control px-4 text-body-s font-medium whitespace-nowrap transition-[background-color,color,filter] duration-150 ease-out';

// Saffron marks the one thing to do on a view, so only one primary per view.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent-fill text-teal-ink hover:brightness-95',
  secondary: 'border border-rule-strong bg-surface text-text hover:bg-bg',
  ghost: 'text-text-secondary hover:bg-rule/50 hover:text-text',
};

export function buttonClass(variant: ButtonVariant, extra = ''): string {
  return [BASE, VARIANTS[variant], extra].filter(Boolean).join(' ');
}
