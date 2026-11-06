// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the stylesheet computes to, which is the one artefact the tests in
// src/ cannot reach. They compare the stylesheet with the contract and the
// contract with the README, all of it inside the package; these two cross
// the only boundary an integrator stands on, from their page inward.

import { expect, test, type Page } from '@playwright/test';

import { themeBase, themeModes } from '../src/theme/defaults.generated.js';
import { open, primary, reach, WIDGET } from './flow.ts';

const EVERY_PROPERTY = [
  ...Object.keys(themeBase),
  ...new Set([...Object.keys(themeModes.light), ...Object.keys(themeModes.dark)]),
].sort();

/**
 * A number standing for everything the widget currently computes to. Built
 * from every element in the shadow root and every longhand on it, so no
 * hand kept list of CSS properties decides what counts as a change.
 */
async function rendering(page: Page): Promise<number> {
  return page.evaluate(() => {
    const shadow = document.querySelector('ujira-onboarding')?.shadowRoot;
    let hash = 0;
    for (const element of shadow?.querySelectorAll('*') ?? []) {
      const style = getComputedStyle(element);
      for (let index = 0; index < style.length; index++) {
        const property = style.item(index);
        // Custom properties are enumerated here too, so counting them would
        // make this vacuous: setting one would always move the digest, and
        // the test would pass whether or not anything painted with it.
        if (property.startsWith('--')) continue;
        const text = `${property}:${style.getPropertyValue(property)};`;
        for (const character of text) {
          hash = (hash * 31 + character.charCodeAt(0)) | 0;
        }
      }
    }
    return hash;
  });
}

async function setProperty(page: Page, name: string, value: string): Promise<void> {
  await page.addStyleTag({ content: `#widget { ${name}: ${value}; }` });
}

/**
 * No single state paints everything. The action's fill is covered by its
 * own hover colour while hovered, the field border needs a field, and the
 * easing does nothing in a page that asked for less motion. So the probe
 * visits several, and a property counts as live if it moves the rendering
 * in any of them.
 */
const STATES: Readonly<Record<string, (page: Page) => Promise<void>>> = {
  'the first question': async (page) => {
    await open(page, { width: 420, height: 900 });
  },
  'the review, with a problem and the keyboard on a link': async (page) => {
    await open(page, { width: 420, height: 900 });
    await reach(page, 'review');
    await page.evaluate(() => {
      document.querySelector('ujira-onboarding')?.setAttribute('error', 'Check this over.');
    });
    await page.locator(`${WIDGET} .alert`).waitFor();
    // Tab rather than focus(): :focus-visible matches keyboard focus, so a
    // programmatic one leaves the ring undrawn and its properties look inert.
    await page.keyboard.press('Tab');
  },
  'the action under the pointer': async (page) => {
    await open(page, { width: 420, height: 900 });
    await primary(page).hover();
  },
};

/** Which properties move the rendering in one state. */
async function liveIn(page: Page, names: readonly string[], settleMs = 0): Promise<Set<string>> {
  // One value at a time, removed before the next, because an invalid value
  // on a registered property falls back to its initial and would undo the
  // valid one set before it. Candidates rather than a type map: a property
  // is live if any of them moves the rendering, which keeps the twenty
  // derived rather than described.
  const candidates = ['rgb(1, 2, 3)', '7px', 'Georgia, serif', 'linear'];
  const live = new Set<string>();
  for (const name of names) {
    const before = await rendering(page);
    for (const value of candidates) {
      const tag = await page.addStyleTag({ content: `#widget { ${name}: ${value}; }` });
      if (settleMs > 0) await page.waitForTimeout(settleMs);
      const after = await rendering(page);
      await tag.evaluate((element: Element) => {
        element.remove();
      });
      // A page allowed to animate is still moving when the style is pulled.
      if (settleMs > 0) await page.waitForTimeout(settleMs);
      // Removing it has to put the rendering back, or the next property is
      // being measured against a moved baseline.
      expect(await rendering(page), `${name} did not come back after removal`).toBe(before);
      if (after !== before) {
        live.add(name);
        break;
      }
    }
  }
  return live;
}

test('every property an integrator is offered changes something from their page', async ({
  page,
  browser,
}) => {
  // Twenty properties, several states and a full digest of the rendering for
  // each candidate value: this is slow by design, not stuck. Slow machines
  // took 2.4 to 2.9 minutes, so five gives room without hiding a hang.
  test.setTimeout(5 * 60_000);
  // Declared, spent and documented are all checked inside the package. This
  // is the only check made from where an integrator sits, and a property
  // that silently does nothing is worse than an undocumented one, because
  // they cannot tell a typo from a lie.
  const live = new Set<string>();
  for (const enter of Object.values(STATES)) {
    await enter(page);
    for (const name of await liveIn(page, EVERY_PROPERTY)) live.add(name);
  }

  // The easing only has something to animate on a page that has not asked
  // for less motion, which the rest of this suite deliberately does.
  const moving = await browser.newContext({ reducedMotion: 'no-preference' });
  try {
    const page2 = await moving.newPage();
    await page2.goto('/host.html');
    await page2.locator(`${WIDGET} .primary`).waitFor();
    // Not hovered: the easing sits on the action's transition whether or
    // not anything is animating, and a transition actually running makes
    // every reading a moving target.
    const missing = EVERY_PROPERTY.filter((name) => !live.has(name));
    for (const name of await liveIn(page2, missing)) live.add(name);
  } finally {
    await moving.close();
  }

  expect([...live].sort()).toEqual(EVERY_PROPERTY);
  expect(EVERY_PROPERTY.length).toBe(20);
});

test('the focus ring survives both spellings of zero', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Tab');
  const ring = async (): Promise<string> =>
    page.evaluate(() => {
      const element = document.querySelector('ujira-onboarding')?.shadowRoot?.activeElement;
      const style = element === null || element === undefined ? null : getComputedStyle(element);
      return style === null ? '' : `${style.outlineWidth} ${style.outlineStyle} ${style.boxShadow}`;
    });

  const floors = await ring();
  expect(floors).toContain('2px solid');
  expect(floors).toContain('0px 0px 0px 2px');

  // A unitless zero is a number rather than a length, so before these
  // properties were registered it made the whole declaration invalid at
  // computed value time and took the ring with it, floors and all.
  for (const zero of ['0', '0px']) {
    await setProperty(page, '--ujira-embed-focus-width', zero);
    await setProperty(page, '--ujira-embed-focus-inner-width', zero);
    await setProperty(page, '--ujira-embed-focus-offset', zero);
    const held = await ring();
    expect(held, `a focus ring went missing at a width of ${zero}`).toContain('2px solid');
    expect(held, `the contrast band went missing at a width of ${zero}`).toMatch(
      /0px 0px 0px [12]px/,
    );
  }
});

/** The ring's colour, width and style, and the band, on the focused control. */
async function focusPaint(page: Page): Promise<{ outline: string; band: string }> {
  return page.evaluate(() => {
    const element = document.querySelector('ujira-onboarding')?.shadowRoot?.activeElement;
    if (element === null || element === undefined) return { outline: '', band: '' };
    const style = getComputedStyle(element);
    return {
      outline: `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
      band: style.boxShadow,
    };
  });
}

/** A generated #RRGGBB default as the browser reports a computed colour. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}

const DEFAULT_RING = `${themeBase['--ujira-embed-focus-width']} solid ${rgb(themeBase['--ujira-embed-focus'])}`;
const DEFAULT_BAND = `${rgb(themeBase['--ujira-embed-focus-inner'])} 0px 0px 0px ${themeBase['--ujira-embed-focus-inner-width']}`;

test('a focus colour the page cannot parse leaves the default ring standing', async ({ page }) => {
  // The likeliest thing a real integrator does is point a colour at one of
  // their own tokens and get the name wrong. An unregistered property then
  // makes the declaration it is spent in invalid at computed value time, the
  // outline falls to its initial style of none, and the ring vanishes on the
  // step where someone types the address their money goes to.
  for (const value of ['var(--their-missing-token)', 'not-a-colour', '12px']) {
    await open(page);
    await page.keyboard.press('Tab');
    await setProperty(page, '--ujira-embed-focus', value);
    await setProperty(page, '--ujira-embed-focus-inner', value);
    const { outline, band } = await focusPaint(page);
    expect(outline, `the ring went missing with a colour of ${value}`).toBe(DEFAULT_RING);
    expect(band, `the band went missing with a colour of ${value}`).toBe(DEFAULT_BAND);
  }
});

test('a focus colour on an ancestor does not reach the widget', async ({ page }) => {
  // The defaults are declared on the element, and a declared value beats an
  // inherited one, so the element is the only place a property is set.
  await open(page);
  await page.keyboard.press('Tab');
  await page.addStyleTag({ content: 'main { --ujira-embed-focus: rgb(1, 2, 3); }' });
  expect((await focusPaint(page)).outline).toBe(DEFAULT_RING);
});

test('an unregistered property on an ancestor does not reach the widget', async ({ page }) => {
  // The same rule for a property that is not registered, so no typed
  // fallback is involved: the accent is declared on the element and wins.
  await open(page);
  const fill = async (): Promise<string> =>
    primary(page).evaluate((element: Element) => getComputedStyle(element).backgroundColor);
  const before = await fill();
  expect(before).toBe(rgb(themeModes.light['--ujira-embed-accent']));
  await page.addStyleTag({ content: 'main { --ujira-embed-accent: rgb(1, 2, 3); }' });
  expect(await fill()).toBe(before);
  // And the probe can see a change at all: on the element it paints.
  await setProperty(page, '--ujira-embed-accent', 'rgb(1, 2, 3)');
  expect(await fill()).toBe('rgb(1, 2, 3)');
});

test('an unusable focus colour falls back to what an ancestor set', async ({ page }) => {
  // The one place an ancestor shows through: the value on the element is
  // invalid, the property behaves as unset, and it inherits.
  await open(page);
  await page.keyboard.press('Tab');
  await page.addStyleTag({ content: 'main { --ujira-embed-focus: rgb(1, 2, 3); }' });
  await setProperty(page, '--ujira-embed-focus', 'var(--their-missing-token)');
  expect((await focusPaint(page)).outline).toBe('2px solid rgb(1, 2, 3)');
});

test('the ring stays solid where properties cannot be registered', async ({ page }) => {
  // Older browsers have no CSS.registerProperty, so the colours are left
  // unprotected there. The style is its own declaration, so an unusable
  // colour can cost the ring its colour but never its existence.
  await page.addInitScript(() => {
    Object.defineProperty(CSS, 'registerProperty', { value: undefined });
  });
  await open(page);
  await page.keyboard.press('Tab');
  await setProperty(page, '--ujira-embed-focus', 'var(--their-missing-token)');
  await setProperty(page, '--ujira-embed-focus-inner', 'var(--their-missing-token)');
  const { outline } = await focusPaint(page);
  expect(outline).toMatch(/^2px solid rgb\(/);
});

test('a focus colour the page can parse is the one that paints', async ({ page }) => {
  // Registration must reject only what cannot be a colour. Transparent is a
  // colour, so an integrator who asks for an invisible ring gets one: that is
  // their choice to make, and refusing it would be the widget overruling them.
  for (const [value, painted] of [
    ['rgb(1, 2, 3)', 'rgb(1, 2, 3)'],
    ['transparent', 'rgba(0, 0, 0, 0)'],
  ] as const) {
    await open(page);
    await page.keyboard.press('Tab');
    await setProperty(page, '--ujira-embed-focus', value);
    await setProperty(page, '--ujira-embed-focus-inner', value);
    const { outline, band } = await focusPaint(page);
    expect(outline).toBe(`2px solid ${painted}`);
    expect(band).toBe(`${painted} 0px 0px 0px 2px`);
  }
});
