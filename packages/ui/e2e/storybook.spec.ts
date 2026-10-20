// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { THEMES } from '../.storybook/modes.ts';
import { loadStories, openStory } from './stories.ts';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Font rendering differs between operating systems, so snapshots are only
// compared on Linux, inside the same Playwright container CI uses.
const SNAPSHOTS = process.platform === 'linux';

// An open select is modal: it hides the rest of the page from assistive
// technology and keeps focus inside its list. axe still reports the hidden
// trigger as focusable, so these stories check the open overlay only. The
// closed trigger is checked by every other story of the component.
const OVERLAY_OPEN = 'Open';

for (const theme of THEMES) {
  test.describe(`${theme} mode`, () => {
    for (const story of loadStories()) {
      test(`${story.title} ${story.name} has no axe violations and matches its snapshot`, async ({
        page,
      }) => {
        await openStory(page, story, theme);
        const axe = new AxeBuilder({ page }).withTags(WCAG_AA);
        if (story.name === OVERLAY_OPEN && story.title === 'Primitives/Select') {
          axe.exclude('#storybook-root');
        }
        const results = await axe.analyze();
        expect(
          results.violations.map(({ id, nodes }) => ({
            id,
            targets: nodes.map((node) => node.target.join(' ')),
          })),
        ).toEqual([]);
        if (SNAPSHOTS) {
          await expect(page).toHaveScreenshot(`${story.id}--${theme}.png`);
        }
      });
    }
  });
}
