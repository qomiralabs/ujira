// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generated from the @ujira/ui design tokens and the brand mark in assets/brand.
// Do not edit by hand. Run `pnpm --filter @ujira/embed brand` to regenerate.

/** Custom properties that are the same in every colour mode. */
export const themeBase = {
  '--ujira-embed-font': "var(--ujira-font-inter, 'Inter'), ui-sans-serif, system-ui, sans-serif",
  '--ujira-embed-font-mono':
    "'Noto Sans Mono', var(--ujira-font-jetbrains-mono, 'JetBrains Mono'), ui-monospace, SFMono-Regular, Menlo, monospace",
  '--ujira-embed-radius-control': '6px',
  '--ujira-embed-radius-card': '10px',
  '--ujira-embed-focus-width': '2px',
  '--ujira-embed-focus-offset': '2px',
  '--ujira-embed-focus': '#F4A300',
  '--ujira-embed-focus-inner': '#0B2A33',
  '--ujira-embed-ease': 'cubic-bezier(0.16, 1, 0.3, 1)',
} as const;

/** Colour properties per mode. The light mode is the default. */
export const themeModes = {
  light: {
    '--ujira-embed-surface': '#FFFFFF',
    '--ujira-embed-rule': '#E8E0D2',
    '--ujira-embed-field-border': '#6B6358',
    '--ujira-embed-text': '#0B2A33',
    '--ujira-embed-text-secondary': '#4A5A60',
    '--ujira-embed-accent': '#F4A300',
    '--ujira-embed-accent-hover': '#FFC14D',
    '--ujira-embed-link': '#0B2A33',
    '--ujira-embed-on-accent': '#0B2A33',
    '--ujira-embed-error': '#DC2626',
  },
  dark: {
    '--ujira-embed-surface': '#0F4C5C',
    '--ujira-embed-rule': '#155C6E',
    '--ujira-embed-field-border': '#A9BCC1',
    '--ujira-embed-text': '#FBF7F0',
    '--ujira-embed-text-secondary': '#A9BCC1',
    '--ujira-embed-accent': '#F4A300',
    '--ujira-embed-accent-hover': '#FFC14D',
    '--ujira-embed-link': '#FBF7F0',
    '--ujira-embed-on-accent': '#0B2A33',
    '--ujira-embed-error': '#FCA5A5',
  },
} as const;

/** A colour mode the widget can render in. */
export type ThemeMode = keyof typeof themeModes;

/** Type steps, with the family already pointing at the themed font property. */
export const themeType = {
  title: {
    family: 'var(--ujira-embed-font)',
    size: '20px',
    lineHeight: '1.3',
    tracking: '-0.01em',
    weight: '600',
  },
  body: {
    family: 'var(--ujira-embed-font)',
    size: '16px',
    lineHeight: '1.6',
    tracking: '0em',
    weight: '400',
  },
  'body-s': {
    family: 'var(--ujira-embed-font)',
    size: '14px',
    lineHeight: '1.55',
    tracking: '0em',
    weight: '400',
  },
  data: {
    family: 'var(--ujira-embed-font-mono)',
    size: '14px',
    lineHeight: '1.4',
    tracking: '0em',
    weight: '400',
  },
  label: {
    family: 'var(--ujira-embed-font-mono)',
    size: '12px',
    lineHeight: '1.2',
    tracking: '0.14em',
    weight: '500',
  },
} as const;
