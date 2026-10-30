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
 * Every property the focus ring is drawn from, typed.
 *
 * Unregistered, a value CSS cannot use, such as a unitless zero for a width
 * or a var() naming a token the page never defined for a colour, makes the
 * whole declaration it is spent in invalid at computed value time. The
 * longhands then fall back to their initial values, and the initial value of
 * outline includes a style of none, so the clamps in the rule are bypassed
 * and the focus indicator disappears entirely.
 *
 * Registered, a value that does not match the syntax, whether a literal or a
 * var() that cannot resolve, makes the custom property itself invalid at
 * computed value time instead of the rule that spends it. The property then
 * behaves as unset, and since it inherits it takes its parent's value: one an
 * ancestor set, or failing that the initial value given here, which is the
 * generated default. Either way the focus rule always receives something it
 * can draw with. A valid colour still paints, transparent included: an
 * invisible ring the integrator asked for is their choice, not a value we
 * failed to parse.
 *
 * Where the browser cannot register properties at all, the colours are
 * unprotected, which is why the focus rule keeps outline-style in a
 * declaration of its own that no custom property can invalidate.
 */
const FOCUS_SYNTAX = {
  '--ujira-embed-focus-width': '<length>',
  '--ujira-embed-focus-offset': '<length>',
  '--ujira-embed-focus-inner-width': '<length>',
  '--ujira-embed-focus': '<color>',
  '--ujira-embed-focus-inner': '<color>',
} as const;

interface PropertyRegistry {
  registerProperty?: (definition: {
    name: string;
    syntax: string;
    inherits: boolean;
    initialValue: string;
  }) => void;
}

/**
 * Registers the five. It has to happen through the API rather than an
 * at-rule in our own stylesheet, because an at-rule inside a shadow root
 * does not register: measured, the same rule in the document works and in
 * the shadow root does nothing. Registration is global to the page, which
 * is why every name here is prefixed.
 *
 * Already registered throws InvalidModificationError, which happens when a
 * page loads the widget twice, or registers one of these names itself first,
 * and is nothing to do about. Anything else is a bug in what we passed, such
 * as an initial value the syntax rejects, and is rethrown.
 */
export function registerFocusProperties(registry: PropertyRegistry = CSS): void {
  for (const [name, syntax] of Object.entries(FOCUS_SYNTAX)) {
    const initialValue = themeBase[name as keyof typeof FOCUS_SYNTAX];
    try {
      registry.registerProperty?.({ name, syntax, inherits: true, initialValue });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'InvalidModificationError')) {
        throw error;
      }
    }
  }
}

/**
 * Defaults on the host element. A rule on the integrator's page that targets
 * the element beats these, so the element is where a property is set. A value
 * on an ancestor does not reach the widget: these defaults sit on the element
 * itself, and a value declared on an element always wins over an inherited
 * one. The one place an ancestor shows through is the focus colours' fallback,
 * when the value on the element cannot be used.
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
