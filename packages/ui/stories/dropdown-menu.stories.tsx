// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChevronsUpDown, Download, Pause, Trash2 } from 'lucide-react';
import { Button } from '../src/primitives/button.js';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../src/primitives/dropdown-menu.js';
import { focusFirst } from './helpers.js';

function Actions() {
  return (
    <div className="flex min-h-72 items-start">
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary">Actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem>
            <Download aria-hidden="true" strokeWidth={1.5} />
            Download receipt
            <DropdownMenuShortcut>D</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>Show USD equivalent</DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="danger">
            <Pause aria-hidden="true" strokeWidth={1.5} />
            Pause mandate
          </DropdownMenuItem>
          <DropdownMenuItem variant="danger" disabled>
            <Trash2 aria-hidden="true" strokeWidth={1.5} />
            Delete saved view
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const meta = {
  title: 'Primitives/DropdownMenu',
  component: Actions,
} satisfies Meta<typeof Actions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Focus: Story = { play: focusFirst };

/**
 * The shape a project switcher takes: the panel matches its trigger's width,
 * opens beside the rail rather than over it, and marks the chosen project
 * with a ground as well as a check.
 */
export const ProjectSwitcher: Story = {
  render: () => (
    <div className="flex min-h-72 w-64 items-start">
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" className="w-full justify-between">
            Annotation team
            <ChevronsUpDown aria-hidden="true" strokeWidth={1.5} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
        >
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
          <DropdownMenuRadioGroup value="annotation">
            <DropdownMenuRadioItem value="annotation">Annotation team</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="bounties">Bounties</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="grants">Grants</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
};
