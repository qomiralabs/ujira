// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { composeStories } from '@storybook/react-vite';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as dataTable from '../../../stories/patterns/data-table.stories.tsx';
import { samplePayouts } from '../../../stories/patterns/sample-payouts.ts';

afterEach(cleanup);

const REQUIRED = [
  'Default',
  'Compact',
  'Selection',
  'Loading',
  'Empty',
  'NoResults',
  'TenThousandRows',
];

describe('data table stories', { timeout: 60_000 }, () => {
  it('covers every state', () => {
    expect(dataTable.default.title).toBe('Patterns/DataTable');
    expect(Object.keys(dataTable)).toEqual(expect.arrayContaining(REQUIRED));
  });

  for (const [name, Story] of Object.entries(composeStories(dataTable))) {
    it(`${name} renders`, () => {
      const { container } = render(<Story />);
      expect(container.querySelector('table')).not.toBeNull();
    });
  }

  it('the sample data is the same for the same seed', () => {
    const first = samplePayouts(50);
    const second = samplePayouts(50);
    expect(first.map((row) => row.amount.amount)).toEqual(second.map((row) => row.amount.amount));
    expect(new Set(first.map((row) => row.id)).size).toBe(50);
  });
});
