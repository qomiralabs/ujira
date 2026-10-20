// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Copy } from 'lucide-react';
import { Button } from '../src/primitives/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../src/primitives/tooltip.js';
import { focusFirst } from './helpers.js';

const meta = {
  title: 'Primitives/Tooltip',
  component: Tooltip,
  render: (args) => (
    <div className="flex min-h-32 items-end justify-center">
      <Tooltip {...args}>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Copy receipt number">
            <Copy aria-hidden="true" strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy receipt number</TooltipContent>
      </Tooltip>
    </div>
  ),
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Keyboard focus opens the tooltip as well as the pointer does. */
export const Focus: Story = { play: focusFirst };

export const Open: Story = { args: { open: true } };
