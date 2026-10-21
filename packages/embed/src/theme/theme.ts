// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Turns the generated theme defaults into CSS. Every colour, radius, font and
// curve the widget draws with is a custom property, so an integrator restyles
// the widget from their own page without reaching into the shadow root.

import { css, unsafeCSS, type CSSResult } from 'lit';

import { themeBase, themeModes, themeType } from './defaults.generated.js';

export type ThemeStep = keyof typeof themeType;

const PROPERTY_NAME = /^--ujira-embed-[a-z-]+$/;
// Anything that could end a declaration or open a comment or a tag. The
// values come from the generated defaults, and this keeps it that way.
const UNSAFE_VALUE = /[;{}<>]|\/\*/;

/** The property declarations for a set of custom properties. */
export function declarations(properties: Readonly<Record<string, string>>): CSSResult {
  const lines = Object.entries(properties).map(([name, value]) => {
    if (!PROPERTY_NAME.test(name)) throw new Error(`${name} is not an embed custom property`);
    if (UNSAFE_VALUE.test(value)) throw new Error(`${name} has a value CSS cannot take: ${value}`);
    return `${name}: ${value};`;
  });
  return unsafeCSS(lines.join('\n  '));
}

/**
 * One step of the type scale, with the family, size, line height and weight.
 * Guarded like declarations(): both read the same generated module and both
 * end in the same unsafe call, so both check what they are handed.
 */
export function typeStep(step: ThemeStep): CSSResult {
  const { family, size, lineHeight, tracking, weight } = themeType[step];
  for (const [part, value] of Object.entries(themeType[step])) {
    if (UNSAFE_VALUE.test(value)) {
      throw new Error(`${step} ${part} has a value CSS cannot take: ${value}`);
    }
  }
  return unsafeCSS(
    [
      `font-family: ${family};`,
      `font-size: ${size};`,
      `line-height: ${lineHeight};`,
      `letter-spacing: ${tracking};`,
      `font-weight: ${weight};`,
    ].join('\n  '),
  );
}

/**
 * The three focus lengths, typed.
 *
 * Without this a value CSS cannot parse as a length, which includes the
 * unitless zero anyone would reach for first, makes the whole declaration
 * invalid at computed value time. The longhands then fall back to their
 * initial values, and the initial value of outline includes a style of
 * none, so the clamps in the rule are bypassed and the focus indicator
 * disappears entirely rather than being held at its floor.
 *
 * Registering a syntax moves the rejection earlier, to declaration time,
 * where a bad value is dropped and the previous good one stands. The same
 * treatment would make the colours reject nonsense rather than silently
 * blanking the rule they are spent in, which is worth doing separately.
 */
const LENGTHS = [
  '--ujira-embed-focus-width',
  '--ujira-embed-focus-offset',
  '--ujira-embed-focus-inner-width',
] as const;

interface PropertyRegistry {
  registerProperty?: (definition: {
    name: string;
    syntax: string;
    inherits: boolean;
    initialValue: string;
  }) => void;
}

/**
 * Registers the three. It has to happen through the API rather than an
 * at-rule in our own stylesheet, because an at-rule inside a shadow root
 * does not register: measured, the same rule in the document works and in
 * the shadow root does nothing. Registration is global to the page, which
 * is why every name here is prefixed.
 *
 * Already registered throws, which happens when a page loads the widget
 * twice, and is nothing to do about.
 */
export function registerLengths(registry: PropertyRegistry = CSS): void {
  for (const name of LENGTHS) {
    const initialValue = themeBase[name];
    try {
      registry.registerProperty?.({ name, syntax: '<length>', inherits: true, initialValue });
    } catch {
      // Registered already, by another copy of the widget on this page.
    }
  }
}

/**
 * Defaults on the host element. Rules on the integrator's page beat these, so
 * setting any of the properties on the element, or on an ancestor of it,
 * changes the widget.
 */
export const hostTheme = css`
  :host {
    ${declarations(themeBase)}
    ${declarations(themeModes.light)}
    color-scheme: light;
    display: block;
    max-width: 30rem;
    color: var(--ujira-embed-text);
    font-family: var(--ujira-embed-font);
    text-align: start;
  }

  :host([mode='dark']) {
    ${declarations(themeModes.dark)}
    color-scheme: dark;
  }

  @media (prefers-color-scheme: dark) {
    :host([mode='system']) {
      ${declarations(themeModes.dark)}
      color-scheme: dark;
    }
  }

  :host([hidden]) {
    display: none;
  }
`;
