// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { useQueryState } from 'nuqs';
import { Suspense } from 'react';

import { projectParam } from '../shell/projects';
import { ApiKeysScreen, ApiKeysScreenSkeleton } from './api-keys-screen';

function ForProject() {
  const [project] = useQueryState('project', projectParam);
  return <ApiKeysScreen project={project} />;
}

/**
 * The Developers section. The project comes from the URL, which a
 * prerendered page can only read once it is in the browser, so the HTML
 * carries the screen's skeleton at its final size until then.
 */
export function DevelopersView() {
  return (
    <Suspense fallback={<ApiKeysScreenSkeleton />}>
      <ForProject />
    </Suspense>
  );
}
