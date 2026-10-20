// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import Link from 'next/link';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { Icon } from './icon';
import { Logo } from './logo';
import { NavList } from './nav-list';
import { setRail, useRail } from './preferences';
import { ProjectSwitcher } from './project-switcher';
import { withProject, type ProjectId } from './projects';

interface RailProps {
  project: ProjectId;
  onProjectChange: (project: ProjectId) => void;
}

/**
 * The left rail from tablet width up. It always sits on teal, in light and
 * dark, so it scopes the dark tokens to itself.
 */
export function Rail({ project, onProjectChange }: RailProps) {
  const rail = useRail();
  const collapsed = rail === 'collapsed';
  return (
    <aside
      data-theme="dark"
      data-collapsible=""
      className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-4 border-r border-rule bg-bg px-3 py-4 text-text md:flex rail-collapsed:w-16 rail-collapsed:px-2"
    >
      <Link
        href={withProject('/', { project })}
        className="flex h-10 items-center rounded-control px-2 rail-collapsed:justify-center rail-collapsed:px-0"
      >
        <Logo variant="lockup" className="h-8 w-auto rail-collapsed:hidden" />
        <Logo variant="mark" className="hidden size-8 rail-collapsed:block" />
      </Link>
      <ProjectSwitcher project={project} onChange={onProjectChange} />
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col justify-between gap-4">
        <NavList project={project} group="primary" collapsed={collapsed} />
        <NavList project={project} group="secondary" collapsed={collapsed} />
      </nav>
      <button
        type="button"
        onClick={() => {
          setRail(collapsed ? 'expanded' : 'collapsed');
        }}
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        title={collapsed ? 'Expand navigation' : undefined}
        className="flex h-10 items-center gap-3 rounded-control px-3 text-body-s text-text-secondary transition-colors duration-150 ease-out hover:bg-surface/60 hover:text-text rail-collapsed:justify-center rail-collapsed:px-0"
      >
        <Icon source={{ lucide: collapsed ? PanelLeftOpen : PanelLeftClose }} />
        <span className="rail-collapsed:sr-only" aria-hidden="true">
          Collapse
        </span>
      </button>
    </aside>
  );
}
