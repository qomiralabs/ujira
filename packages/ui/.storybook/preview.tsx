// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { withThemeByDataAttribute } from '@storybook/addon-themes';
import type { Preview } from '@storybook/react-vite';
import { THEMES, VIEWPORTS, type Theme } from './modes.ts';
import './preview.css';

const themes = Object.fromEntries(THEMES.map((theme) => [theme, theme])) as Record<Theme, Theme>;

const preview: Preview = {
  decorators: [
    withThemeByDataAttribute({
      themes,
      defaultTheme: 'light',
      attributeName: 'data-theme',
      parentSelector: 'html',
    }),
    (Story) => (
      <div className="min-h-screen bg-bg p-6 font-sans text-body text-text">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
    viewport: {
      options: Object.fromEntries(
        Object.entries(VIEWPORTS).map(([key, { name, width, height }]) => [
          key,
          { name, styles: { width: `${String(width)}px`, height: `${String(height)}px` } },
        ]),
      ),
    },
    a11y: {
      context: 'body',
      options: {
        runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
      },
      test: 'error',
    },
  },
};

export default preview;
