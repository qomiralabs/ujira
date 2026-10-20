// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { useQueryState } from 'nuqs';
import { Suspense, type ReactNode } from 'react';

import { DEFAULT_PROJECT, projectParam, type ProjectId } from './projects';
import { Rail } from './rail';
import { TopBar } from './top-bar';

interface FrameProps {
  project: ProjectId;
  onProjectChange: (project: ProjectId) => void;
  children: ReactNode;
}

function Frame({ project, onProjectChange, children }: FrameProps) {
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-control bg-surface px-4 py-2 text-body-s text-text focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Rail project={project} onProjectChange={onProjectChange} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar project={project} onProjectChange={onProjectChange} />
        <main id="main" tabIndex={-1} className="w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function FrameWithProject({ children }: { children: ReactNode }) {
  const [project, setProject] = useQueryState('project', projectParam);
  return (
    <Frame
      project={project}
      onProjectChange={(next) => {
        void setProject(next);
      }}
    >
      {children}
    </Frame>
  );
}

/**
 * The frame every screen shares. The project comes from the URL; until the
 * URL is readable, which on a prerendered page is right after hydration, the
 * frame renders for the default project so the HTML is complete.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <Frame project={DEFAULT_PROJECT} onProjectChange={() => undefined}>
          {children}
        </Frame>
      }
    >
      <FrameWithProject>{children}</FrameWithProject>
    </Suspense>
  );
}
