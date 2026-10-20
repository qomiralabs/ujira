// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Download, Pause } from 'lucide-react';
import { Button } from '../src/primitives/button.js';
import { focusFirst, HOVER } from './helpers.js';

const meta = {
  title: 'Primitives/Button',
  component: Button,
  args: { children: 'Approve payout', variant: 'primary', size: 'md' },
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'ghost', 'danger'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg', 'icon'] },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

function renderVariants(args: Story['args']) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button {...args} variant="primary">
        Approve payout
      </Button>
      <Button {...args} variant="secondary">
        Export CSV
      </Button>
      <Button {...args} variant="ghost">
        Cancel
      </Button>
      <Button {...args} variant="danger">
        Revoke mandate
      </Button>
    </div>
  );
}

export const Variants: Story = { render: renderVariants };

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      <Button {...args} size="sm">
        Small
      </Button>
      <Button {...args} size="md">
        Medium
      </Button>
      <Button {...args} size="lg">
        Large
      </Button>
      <Button {...args} size="icon" variant="secondary" aria-label="Download receipt">
        <Download aria-hidden="true" strokeWidth={1.5} />
      </Button>
    </div>
  ),
};

export const WithIcon: Story = {
  args: { variant: 'danger', children: 'Pause mandate' },
  render: (args) => (
    <Button {...args}>
      <Pause aria-hidden="true" strokeWidth={1.5} />
      {args.children}
    </Button>
  ),
};

export const Hover: Story = {
  parameters: HOVER,
  render: renderVariants,
};

export const Focus: Story = {
  play: focusFirst,
};

export const FocusSecondary: Story = {
  args: { variant: 'secondary', children: 'Export CSV' },
  play: focusFirst,
};

export const Disabled: Story = {
  args: { disabled: true },
  render: renderVariants,
};

export const Loading: Story = {
  args: { loading: true, children: 'Approving' },
};
