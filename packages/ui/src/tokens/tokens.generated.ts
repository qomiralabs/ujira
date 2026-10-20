// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generated from the brand colour tokens, tokens/system.json and the brand icon sprite.
// Do not edit by hand. Run `pnpm --filter @ujira/ui tokens` to regenerate.

/** Brand core and neutral colours, the same in both modes. */
export const palette = {
  teal: '#0F4C5C',
  'teal-night': '#0A3540',
  'teal-raised': '#155C6E',
  'teal-ink': '#0B2A33',
  cream: '#FBF7F0',
  white: '#FFFFFF',
  saffron: '#F4A300',
  'saffron-deep': '#8F5A00',
  'saffron-lift': '#FFC14D',
  'sand-200': '#E8E0D2',
  'sand-300': '#D9CFBF',
  'stone-500': '#6B6358',
  'slate-600': '#4A5A60',
  'mist-300': '#A9BCC1',
} as const;

/** Payment status colours. Payments only, always with a word and an icon. */
export const status = {
  paid: {
    fill: '#16A34A',
    text: '#15803D',
    dark: '#4ADE80',
  },
  waiting: {
    fill: '#F59E0B',
    text: '#B45309',
    dark: '#FBBF24',
  },
  blocked: {
    fill: '#DC2626',
    text: '#DC2626',
    dark: '#F87171',
    'dark-text': '#FCA5A5',
  },
} as const;

/** Semantic tokens per colour mode, with keys identical in light and dark. */
export const modes = {
  light: {
    bg: '#FBF7F0',
    surface: '#FFFFFF',
    rule: '#E8E0D2',
    'rule-strong': '#D9CFBF',
    text: '#0B2A33',
    'text-secondary': '#4A5A60',
    'text-subtle': '#6B6358',
    accent: '#F4A300',
    'accent-text': '#8F5A00',
    paid: '#15803D',
    waiting: '#B45309',
    blocked: '#DC2626',
    logo: 'default',
    'paid-fill': '#16A34A',
    'waiting-fill': '#F59E0B',
    'blocked-fill': '#DC2626',
  },
  dark: {
    bg: '#0A3540',
    surface: '#0F4C5C',
    rule: '#155C6E',
    'rule-strong': '#1F6E82',
    text: '#FBF7F0',
    'text-secondary': '#A9BCC1',
    'text-subtle': '#A9BCC1',
    accent: '#F4A300',
    'accent-text': '#FFC14D',
    paid: '#4ADE80',
    waiting: '#FBBF24',
    blocked: '#FCA5A5',
    logo: 'default-reverse',
    'paid-fill': '#4ADE80',
    'waiting-fill': '#FBBF24',
    'blocked-fill': '#F87171',
  },
} as const;

/** Data visualisation colours per mode, resolved to hex for chart themes. */
export const viz = {
  light: {
    categorical: ['#0F4C5C', '#5C8F9A', '#5B574F', '#8B7E6A'],
    sequential: ['#5C8F9A', '#427785', '#2C606F', '#0F4C5C', '#0B2A33'],
    highlight: '#F4A300',
    'highlight-stroke': '#8F5A00',
    paid: '#16A34A',
    waiting: '#F59E0B',
    'waiting-stroke': '#B45309',
    blocked: '#DC2626',
    grid: '#E8E0D2',
    axis: '#4A5A60',
    tooltip: '#FFFFFF',
    'tooltip-rule': '#E8E0D2',
    'tooltip-text': '#0B2A33',
  },
  dark: {
    categorical: ['#FBF7F0', '#A9BCC1', '#9A9992', '#C9C0B0'],
    sequential: ['#729BA6', '#8FB1B9', '#AFC6CC', '#D1DDDE', '#FBF7F0'],
    highlight: '#F4A300',
    'highlight-stroke': '#F4A300',
    paid: '#4ADE80',
    waiting: '#FBBF24',
    'waiting-stroke': '#FBBF24',
    blocked: '#F87171',
    grid: '#155C6E',
    axis: '#A9BCC1',
    tooltip: '#0F4C5C',
    'tooltip-rule': '#155C6E',
    'tooltip-text': '#FBF7F0',
  },
} as const;

/** Corner radius: controls, cards, and dialogs, sheets and receipts. */
export const radius = {
  control: '6px',
  card: '10px',
  overlay: '14px',
} as const;

/** Table row height for the default and the compact density. */
export const density = {
  row: '44px',
  'row-compact': '36px',
} as const;

/** Focus ring on every interactive element, in both modes. */
export const focus = {
  width: '2px',
  offset: '2px',
  color: '#F4A300',
  inner: '#0B2A33',
} as const;

/** The one shadow level, for overlays only. Cards use a rule instead. */
export const shadow = {
  overlay: '0px 8px 24px rgb(11 42 51 / 0.16)',
} as const;

/** Brand easing curves and the payment arrival duration. */
export const motion = {
  'ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'ease-settle': 'cubic-bezier(0.34, 1.3, 0.64, 1)',
  arrive: '400ms',
} as const;

/** Font roles. The variable is filled by next/font in each app. */
export const fonts = {
  display: {
    face: 'Nunito',
    variable: '--ujira-font-nunito',
    fallback: ['ui-rounded', 'system-ui', 'sans-serif'],
    stack: "var(--ujira-font-nunito, 'Nunito'), ui-rounded, system-ui, sans-serif",
  },
  sans: {
    face: 'Inter',
    variable: '--ujira-font-inter',
    fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
    stack: "var(--ujira-font-inter, 'Inter'), ui-sans-serif, system-ui, sans-serif",
  },
  mono: {
    face: 'JetBrains Mono',
    variable: '--ujira-font-jetbrains-mono',
    fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
    signs: {
      face: 'Noto Sans Mono',
      file: 'noto-sans-mono-currency-signs.woff2',
      weight: '100 900',
      unicodeRange: ['U+20A6', 'U+20B1', 'U+20B5', 'U+20B9'],
    },
    stack:
      "var(--ujira-font-jetbrains-mono, 'JetBrains Mono'), 'Noto Sans Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  },
} as const;

/** Type scale in px with unitless line heights. */
export const typeScale = {
  'display-xl': {
    family: 'display',
    size: 80,
    lineHeight: 1,
    tracking: '-0.03em',
    weight: 800,
  },
  'display-l': {
    family: 'display',
    size: 56,
    lineHeight: 1.05,
    tracking: '-0.025em',
    weight: 800,
  },
  'display-m': {
    family: 'display',
    size: 40,
    lineHeight: 1.1,
    tracking: '-0.02em',
    weight: 800,
  },
  'display-s': {
    family: 'display',
    size: 28,
    lineHeight: 1.2,
    tracking: '-0.01em',
    weight: 800,
  },
  title: {
    family: 'sans',
    size: 20,
    lineHeight: 1.3,
    tracking: '-0.01em',
    weight: 600,
  },
  'body-l': {
    family: 'sans',
    size: 18,
    lineHeight: 1.6,
    tracking: '0em',
    weight: 400,
  },
  body: {
    family: 'sans',
    size: 16,
    lineHeight: 1.6,
    tracking: '0em',
    weight: 400,
  },
  'body-s': {
    family: 'sans',
    size: 14,
    lineHeight: 1.55,
    tracking: '0em',
    weight: 400,
  },
  'amount-xl': {
    family: 'mono',
    size: 40,
    lineHeight: 1.1,
    tracking: '-0.01em',
    weight: 500,
  },
  data: {
    family: 'mono',
    size: 14,
    lineHeight: 1.4,
    tracking: '0em',
    weight: 400,
  },
  label: {
    family: 'mono',
    size: 12,
    lineHeight: 1.2,
    tracking: '0.14em',
    weight: 500,
  },
} as const;
