// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import type { ReactNode } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronsUpDown } from 'lucide-react';

import { Icon } from './icon';
import { PROJECTS, projectName, type ProjectId } from './projects';

interface ProjectSwitcherProps {
  project: ProjectId;
  onChange: (project: ProjectId) => void;
  /**
   * Render the menu in place instead of in a portal. Needed inside a modal
   * dialog, which makes everything outside it inert.
   */
  inline?: boolean;
}

function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

function InPlace({ children }: { children: ReactNode }) {
  return children;
}

function isProject(value: string): value is ProjectId {
  return PROJECTS.some((p) => p.id === value);
}

/** Every view is scoped to the project chosen here, which lives in the URL. */
export function ProjectSwitcher({ project, onChange, inline = false }: ProjectSwitcherProps) {
  const name = projectName(project);
  const Portal = inline ? InPlace : Menu.Portal;
  return (
    // Not modal: a modal menu hides the page with aria-hidden while its links
    // stay focusable. The menu still takes focus and closes on Escape.
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label={`Project: ${name}. Switch project`}
        className="flex h-11 w-full items-center gap-3 rounded-control border border-rule px-2 text-left text-body-s text-text transition-colors duration-150 ease-out hover:bg-surface/60 rail-collapsed:justify-center rail-collapsed:border-transparent rail-collapsed:px-0"
      >
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-control bg-surface font-mono text-label text-text"
        >
          {initials(name)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col rail-collapsed:sr-only">
          <span className="text-label font-mono text-text-secondary uppercase">Project</span>
          <span className="truncate font-medium">{name}</span>
        </span>
        <Icon
          source={{ lucide: ChevronsUpDown }}
          size={16}
          className="shrink-0 text-text-secondary rail-collapsed:hidden"
        />
      </Menu.Trigger>
      <Portal>
        <Menu.Content
          align="start"
          sideOffset={6}
          className="z-50 min-w-56 rounded-card border border-rule bg-surface p-1 text-text shadow-overlay"
        >
          <Menu.Label className="px-3 py-2 text-body-s text-text-secondary">
            Switch project
          </Menu.Label>
          <Menu.RadioGroup
            value={project}
            onValueChange={(value) => {
              if (isProject(value)) onChange(value);
            }}
          >
            {PROJECTS.map((p) => (
              <Menu.RadioItem
                key={p.id}
                value={p.id}
                className="flex h-10 cursor-default items-center gap-3 rounded-control px-3 text-body-s outline-none select-none data-[highlighted]:bg-bg"
              >
                <span className="flex-1">{p.name}</span>
                <Menu.ItemIndicator>
                  <Icon source={{ lucide: Check }} size={16} />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Portal>
    </Menu.Root>
  );
}
