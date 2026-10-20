// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { expect, test } from '@playwright/test';
import { THEMES } from '../.storybook/modes.ts';
import { focus, palette } from '../src/tokens/index.ts';
import { loadStories, openStory } from './stories.ts';

// Components a person can reach with the keyboard.
const INTERACTIVE = new Set([
  'Primitives/Button',
  'Primitives/Checkbox',
  'Primitives/Field',
  'Primitives/Input',
  'Primitives/Label',
  'Primitives/RadioGroup',
  'Primitives/Select',
  'Primitives/Switch',
  'Primitives/Textarea',
  'Primitives/Tooltip',
]);

// Disabled stories have nothing to focus. An open select already holds focus
// inside its list. Focus stories focus their control in a play function, so
// the real Tab key is pressed on every other story of the component instead.
const SKIPPED = /^(Disabled|Open|Focus)/;

function rgb(hex: string): string {
  const value = hex.replace('#', '');
  const channel = (start: number) => String(Number.parseInt(value.slice(start, start + 2), 16));
  return `rgb(${channel(0)}, ${channel(2)}, ${channel(4)})`;
}

test('every interactive story shows the saffron ring on keyboard focus', async ({ page }) => {
  const stories = loadStories().filter(
    (story) => INTERACTIVE.has(story.title) && !SKIPPED.test(story.name),
  );
  expect(stories.length).toBeGreaterThan(0);
  test.setTimeout(stories.length * THEMES.length * 5_000);

  for (const theme of THEMES) {
    for (const story of stories) {
      await openStory(page, story, theme);
      // A freshly loaded story has nothing focused, so Tab lands on its first control.
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const element = document.activeElement;
        if (!(element instanceof HTMLElement) || element === document.body) return null;
        const style = getComputedStyle(element);
        return {
          inStory: document.getElementById('storybook-root')?.contains(element) ?? false,
          focusVisible: element.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineOffset: style.outlineOffset,
          outlineColor: style.outlineColor,
          boxShadow: style.boxShadow,
        };
      });
      const where = `${story.title} ${story.name} (${theme})`;
      expect(ring, where).not.toBeNull();
      expect(ring, where).toMatchObject({
        inStory: true,
        focusVisible: true,
        outlineStyle: 'solid',
        outlineWidth: focus.width,
        outlineOffset: focus.offset,
        outlineColor: rgb(palette.saffron),
      });
      expect(ring?.boxShadow, where).toContain(rgb(palette['teal-ink']));
    }
  }
});
