// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Download } from 'lucide-react';
import { BrandIcon } from '../src/icons/brand-icon.js';
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
      <Button {...args} size="sm" variant="secondary">
        Small
      </Button>
      <Button {...args} size="md" variant="secondary">
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

/**
 * Pause is one of the nine core brand ideas, so it takes the brand glyph, not
 * a generic one. Lucide is for everything the brand has no icon for.
 */
export const WithIcon: Story = {
  args: { variant: 'danger', children: 'Pause mandate' },
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      <Button {...args}>
        <BrandIcon name="pause" size={16} />
        {args.children}
      </Button>
      <Button variant="secondary">
        <BrandIcon name="receipt" size={16} />
        View receipt
      </Button>
      <Button variant="ghost">
        <Download aria-hidden="true" strokeWidth={1.5} />
        Export CSV
      </Button>
    </div>
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
