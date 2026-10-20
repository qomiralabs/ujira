// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { z } from 'zod';
import type { Theme } from '../.storybook/modes.ts';

const INDEX = join(import.meta.dirname, '..', 'storybook-static', 'index.json');

const indexSchema = z.object({
  v: z.number(),
  entries: z.record(
    z.string(),
    z.object({
      type: z.enum(['story', 'docs']),
      id: z.string(),
      name: z.string(),
      title: z.string(),
    }),
  ),
});

// Phases a story render ends in. Anything but finished is a failure.
const SETTLED = ['finished', 'errored', 'aborted'];

export interface StoryEntry {
  id: string;
  name: string;
  title: string;
}

/** Every story in the built catalogue, read from its index. */
export function loadStories(): StoryEntry[] {
  if (!existsSync(INDEX)) {
    throw new Error('No built catalogue. Run `pnpm --filter @ujira/ui build-storybook` first.');
  }
  const index = indexSchema.parse(JSON.parse(readFileSync(INDEX, 'utf8')));
  return Object.values(index.entries)
    .filter((entry) => entry.type === 'story')
    .map(({ id, name, title }) => ({ id, name, title }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Opens one story in one colour mode and waits until it has rendered, its
 * play function has finished and the fonts are in.
 */
export async function openStory(page: Page, story: StoryEntry, theme: Theme): Promise<void> {
  await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`);
  const phase = await page.waitForFunction((settledPhases) => {
    const preview = (
      window as unknown as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } } }
    ).__STORYBOOK_PREVIEW__;
    const current = preview?.currentRender?.phase;
    return current !== undefined && settledPhases.includes(current) ? current : false;
  }, SETTLED);
  const settled = (await phase.jsonValue()) as string;
  if (settled !== 'finished') throw new Error(`${story.id} did not render: ${settled}`);
  await page.waitForFunction(
    (expected) => document.documentElement.getAttribute('data-theme') === expected,
    theme,
  );
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}
