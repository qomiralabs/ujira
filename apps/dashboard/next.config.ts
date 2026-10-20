// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { NextConfig } from 'next';

// UJIRA_BUDGET_FIXTURE=1 adds the over budget fixture route, which exists only
// to prove the bundle budget check fails. It is never part of a normal build.
const fixture = process.env['UJIRA_BUDGET_FIXTURE'] === '1';

const config: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  poweredByHeader: false,
  // Images ship as SVG and PNG at their final size, so the optimiser is off.
  images: { unoptimized: true },
  pageExtensions: fixture ? ['fixture.tsx', 'tsx', 'ts'] : ['tsx', 'ts'],
  // The workspace root, so Turbopack resolves @ujira/ui from the monorepo.
  turbopack: { root: new URL('../..', import.meta.url).pathname },
};

export default config;
