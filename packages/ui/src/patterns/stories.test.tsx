// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { composeStories } from '@storybook/react-vite';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as detailSheet from '../../stories/patterns/detail-sheet.stories.tsx';
import * as emptyState from '../../stories/patterns/empty-state.stories.tsx';
import * as kpiCard from '../../stories/patterns/kpi-card.stories.tsx';

afterEach(cleanup);

const CATALOGUE = {
  'Patterns/DetailSheet': { module: detailSheet, required: ['Default', 'Open'] },
  'Patterns/EmptyState': { module: emptyState, required: ['NothingYet', 'NoResults'] },
  'Patterns/KpiCard': { module: kpiCard, required: ['Default', 'Overview', 'WithSparklineSlot'] },
} as const;

describe('pattern stories', { timeout: 60_000 }, () => {
  for (const [title, { module, required }] of Object.entries(CATALOGUE)) {
    it(`${title} covers its cases`, () => {
      expect(module.default.title).toBe(title);
      expect(Object.keys(module)).toEqual(expect.arrayContaining([...required]));
    });

    const composed = composeStories(module as Parameters<typeof composeStories>[0]);
    for (const [name, Story] of Object.entries(composed)) {
      it(`${title} ${name} renders`, () => {
        const { container } = render(createElement(Story as () => ReactNode));
        expect(container.firstElementChild).not.toBeNull();
      });
    }
  }
});
