// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { THEMES, VIEWPORTS } from '../.storybook/modes.ts';
import { loadStories, openStory, SNAPSHOTS } from './stories.ts';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// An open select, dialog, alert dialog, sheet or menu is modal: it hides the
// rest of the page from assistive technology and keeps focus inside itself.
// axe still reports the hidden trigger as focusable, so a story showing an
// open overlay checks the overlay only. The closed trigger is checked by
// every other story of the component. Detected from the page rather than
// named, so a new story that opens one cannot miss the exclusion and fail for
// a reason that is not its own.
const OPEN_SELECT = [
  '[data-slot="select-content"][data-state="open"]',
  '[data-slot="dialog-content"][data-state="open"]',
  '[data-slot="alert-dialog"][data-state="open"]',
  '[data-slot="sheet-content"][data-state="open"]',
  '[data-slot="dropdown-menu-content"][data-state="open"]',
].join(', ');

// Stories whose layout actually changes with the width: a row of buttons
// wraps, a field and its hint reflow, an option list with descriptions grows.
// These are snapshotted at all three widths. Every other story is a single
// control whose layout does not depend on the viewport, so one width is
// enough and 120 near identical extra images would only slow review down.
// An open list is not a candidate: resizing the viewport makes Radix close
// it, so the extra images would show a closed control instead of the thing
// the story exists for.
const RESPONSIVE = new Set([
  // The rendered amount in the four currencies whose sign comes from the
  // second mono face, and a column of amounts: a font or alignment change
  // shows here before it shows anywhere else.
  'money-amount--alignment',
  'money-amount--launch-signs',
  // The table becomes stacked cards below the tablet width.
  'patterns-datatable--default',
  // The four overview cards go from one column to two to four.
  'patterns-kpicard--overview',
  // The meter legend stacks on a phone; the cards go from one column to two;
  // the badges wrap.
  'payments-mandatemeter--default',
  'payments-payoutcard--list',
  'payments-statusbadge--every-status',
  'primitives-button--variants',
  'primitives-button--with-icon',
  'primitives-field--with-react-hook-form',
  'primitives-input--amount',
  'primitives-radiogroup--default',
  'primitives-textarea--default',
]);

// The width the single width stories are taken at.
const BASE = VIEWPORTS.tablet.width;

async function expectNoSidewaysScroll(page: Page, id: string, width: number): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
  });
  expect(overflow.scrollWidth, `${id} scrolls sideways at ${String(width)}px`).toBeLessThanOrEqual(
    overflow.clientWidth,
  );
}

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
        if (!SNAPSHOTS) {
          // Not a bare return: without this the run reports 130 passing
          // story tests having compared no image at all, and a green local
          // run reads as the full gate. Only the image comparison needs a
          // committed baseline, so everything else below still runs and the
          // annotation names exactly what did not.
          test.info().annotations.push({
            type: 'snapshot skipped',
            description: `screenshots are compared on Linux only, this run is ${process.platform}. Every other assertion in this test ran.`,
          });
        }

        // Nothing may push the page wider than the window, at any width the
        // story is checked at. A hero amount at 40px with a real corridor
        // value does exactly that on a phone, and a story is the pattern the
        // first screen copies. This needs no baseline, so it runs everywhere.
        if (!RESPONSIVE.has(story.id)) {
          await expectNoSidewaysScroll(page, story.id, BASE);
          if (SNAPSHOTS) await expect(page).toHaveScreenshot(`${story.id}--${theme}.png`);
          return;
        }
        for (const { width, height } of Object.values(VIEWPORTS)) {
          await page.setViewportSize({ width, height });
          await expectNoSidewaysScroll(page, story.id, width);
          if (SNAPSHOTS) {
            await expect(page).toHaveScreenshot(`${story.id}--${theme}--${String(width)}.png`);
          }
        }
        await page.setViewportSize({ width: BASE, height: VIEWPORTS.tablet.height });
      });
    }
  });
}
