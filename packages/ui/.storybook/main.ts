// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { join } from 'node:path';
import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { mergeConfig } from 'vite';

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../stories/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-themes', 'storybook-addon-pseudo-states'],
  core: {
    disableTelemetry: true,
    disableWhatsNewNotifications: true,
  },
  viteFinal: (viteConfig) =>
    mergeConfig(viteConfig, {
      plugins: [react(), tailwindcss()],
      // The money components format through the core money model. The
      // catalogue reads its source, so building the catalogue never depends
      // on core having been compiled first.
      resolve: {
        alias: { '@ujira/core': join(import.meta.dirname, '..', '..', 'core', 'src', 'index.ts') },
      },
      // The catalogue bundles React, Storybook and axe into one preview chunk
      // of about 1.2 MB. It is a review tool and never ships to people, so
      // the size warning only adds noise.
      build: { chunkSizeWarningLimit: 2048 },
    }),
};

export default config;
