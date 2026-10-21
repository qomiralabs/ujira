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
