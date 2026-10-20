// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import type { ReactNode } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronsUpDown } from 'lucide-react';

import { Icon } from './icon';
import { PROJECTS, project, type ProjectId } from './projects';

interface ProjectSwitcherProps {
  project: ProjectId;
  onChange: (project: ProjectId) => void;
  /**
   * Render the menu in place instead of in a portal. Needed inside a modal
   * dialog, which makes everything outside it inert.
   */
  inline?: boolean;
}

function InPlace({ children }: { children: ReactNode }) {
  return children;
}

function isProject(value: string): value is ProjectId {
  return PROJECTS.some((p) => p.id === value);
}

function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

/** Every view is scoped to the project chosen here, which lives in the URL. */
export function ProjectSwitcher({
  project: current,
  onChange,
  inline = false,
}: ProjectSwitcherProps) {
  const chosen = project(current);
  const Portal = inline ? InPlace : Menu.Portal;
  return (
    // Not modal: a modal menu hides the page with aria-hidden while its links
    // stay focusable. The menu still takes focus and closes on Escape.
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label={`Project: ${chosen.name}. Choose a different project`}
        className="flex h-11 w-full items-center gap-3 rounded-control border border-rule px-2 text-left text-body-s text-text transition-[background-color,color] duration-150 ease-out hover:bg-surface/60 rail-collapsed:justify-center rail-collapsed:border-transparent rail-collapsed:px-0"
      >
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-control bg-surface font-mono text-label text-text"
        >
          {initials(chosen.name)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col rail-collapsed:sr-only">
          <span className="text-label font-mono text-text-secondary uppercase">Project</span>
          <span className="truncate font-medium">{chosen.name}</span>
        </span>
        <Icon
          source={{ lucide: ChevronsUpDown }}
          size={16}
          className="shrink-0 text-text-secondary rail-collapsed:hidden"
        />
      </Menu.Trigger>
      <Portal>
        <Menu.Content
          // No colour mode of its own. Every colour here is a token, so the
          // panel follows the dashboard's light or dark setting exactly as
          // every other surface does, including while it is open.
          // Beside the rail, not over it: a menu dropped below this trigger
          // would cover the navigation it sits above. Inside the drawer there
          // is no room to the side, so it opens downward there and Radix
          // flips it back if a narrow window leaves no space either way.
          side={inline ? 'bottom' : 'right'}
          align="start"
          sideOffset={inline ? 8 : 16}
          collisionPadding={12}
          className="z-50 w-(--radix-dropdown-menu-trigger-width) max-w-[calc(100vw-1.5rem)] min-w-48 rounded-overlay border border-rule bg-surface p-1.5 text-text shadow-overlay"
        >
          <Menu.Label className="px-2.5 pt-1.5 pb-2 text-label font-mono text-text-secondary uppercase">
            Projects
          </Menu.Label>
          <Menu.RadioGroup
            value={current}
            onValueChange={(value) => {
              if (isProject(value)) onChange(value);
            }}
          >
            {PROJECTS.map((p) => (
              <Menu.RadioItem
                key={p.id}
                value={p.id}
                className="group flex h-10 cursor-default items-center gap-3 rounded-control px-2.5 outline-none select-none data-highlighted:bg-bg data-highlighted:focus-ring-inset data-[state=checked]:bg-bg data-[state=checked]:chosen-outline"
              >
                <span className="min-w-0 flex-1 truncate text-body-s font-medium text-text-secondary group-data-[state=checked]:text-text">
                  {p.name}
                </span>
                {/*
                 * The marker is the brand's generic interface icon at the
                 * brand stroke, in the text colour. Not saffron: the brand
                 * spends saffron on the mark, the amount, the one primary
                 * action and the focus ring, and a selection marker is none
                 * of those. The chosen row also carries the raised ground the
                 * rail uses for the current page, so selection never rests on
                 * colour alone.
                 */}
                <Menu.ItemIndicator className="shrink-0 text-text">
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
