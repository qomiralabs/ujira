// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { useQueryState } from 'nuqs';
import { lazy, Suspense } from 'react';

import { projectParam } from '../shell/projects';
import { ApiKeysScreenSkeleton } from './api-keys-skeleton';

// The screen, its table and its schemas load as their own chunk, after the
// page, since the keys have to be fetched before there is anything to show.
const ApiKeysScreen = lazy(() =>
  import('./api-keys-screen').then((loaded) => ({ default: loaded.ApiKeysScreen })),
);

function ForProject() {
  const [project] = useQueryState('project', projectParam);
  return <ApiKeysScreen project={project} />;
}

/**
 * The Developers section. The project comes from the URL, which a
 * prerendered page can only read once it is in the browser, so the HTML
 * carries the screen's skeleton at its final size until the project is known
 * and the screen has loaded.
 */
export function DevelopersView() {
  return (
    <Suspense fallback={<ApiKeysScreenSkeleton />}>
      <ForProject />
    </Suspense>
  );
}
