// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { THEMES, VIEWPORTS } from '../.storybook/modes.ts';
import { loadStories, openStory } from './stories.ts';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Font rendering differs between operating systems, so snapshots are only
// compared on Linux, inside the same Playwright container CI uses.
const SNAPSHOTS = process.platform === 'linux';

// An open select is modal: it hides the rest of the page from assistive
// technology and keeps focus inside its list. axe still reports the hidden
// trigger as focusable, so a story showing an open list checks the list only.
// The closed trigger is checked by every other story of the component.
// Detected from the page rather than named, so a new story that opens a list
// cannot miss the exclusion and fail for a reason that is not its own.
const OPEN_SELECT = '[data-slot="select-content"][data-state="open"]';

// Stories whose layout actually changes with the width: a row of buttons
// wraps, a field and its hint reflow, an option list with descriptions grows.
// These are snapshotted at all three widths. Every other story is a single
// control whose layout does not depend on the viewport, so one width is
// enough and 120 near identical extra images would only slow review down.
// An open list is not a candidate: resizing the viewport makes Radix close
// it, so the extra images would show a closed control instead of the thing
// the story exists for.
const RESPONSIVE = new Set([
  'primitives-button--variants',
  'primitives-button--with-icon',
  'primitives-field--with-react-hook-form',
  'primitives-input--amount',
  'primitives-radiogroup--default',
  'primitives-textarea--default',
]);

// The width the single width stories are taken at.
const BASE = VIEWPORTS.tablet.width;

for (const theme of THEMES) {
  test.describe(`${theme} mode`, () => {
    for (const story of loadStories()) {
      test(`${story.title} ${story.name} has no axe violations and matches its snapshot`, async ({
        page,
      }) => {
        await openStory(page, story, theme);
        const axe = new AxeBuilder({ page }).withTags(WCAG_AA);
        if ((await page.locator(OPEN_SELECT).count()) > 0) {
          axe.exclude('#storybook-root');
        }
        const results = await axe.analyze();
        expect(
          results.violations.map(({ id, nodes }) => ({
            id,
            targets: nodes.map((node) => node.target.join(' ')),
          })),
        ).toEqual([]);
        if (!SNAPSHOTS) return;
        if (!RESPONSIVE.has(story.id)) {
          await expect(page).toHaveScreenshot(`${story.id}--${theme}.png`);
          return;
        }
        for (const { width, height } of Object.values(VIEWPORTS)) {
          await page.setViewportSize({ width, height });
          await expect(page).toHaveScreenshot(`${story.id}--${theme}--${String(width)}.png`);
        }
        await page.setViewportSize({ width: BASE, height: VIEWPORTS.tablet.height });
      });
    }
  });
}
