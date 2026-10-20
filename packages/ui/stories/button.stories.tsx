// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Download, Trash2 } from 'lucide-react';
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
      <Button {...args} variant="danger" icon={<BrandIcon name="pause" size={16} />}>
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
  args: { children: 'Pause mandate' },
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="danger" icon={<BrandIcon name="pause" size={16} />}>
        {args.children}
      </Button>
      <Button variant="secondary" icon={<BrandIcon name="receipt" size={16} />}>
        View receipt
      </Button>
      <Button variant="ghost" icon={<Download aria-hidden="true" strokeWidth={1.5} />}>
        Export CSV
      </Button>
    </div>
  ),
};

/**
 * A destructive action is told apart from an ordinary one by its build, not by
 * a colour: a double weight border and an icon in a ruled cap. The icon is
 * required by the type, so `variant="danger"` cannot be written without one.
 */
export const DangerBesideSecondary: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary">Export CSV</Button>
      <Button variant="danger" icon={<BrandIcon name="pause" size={16} />}>
        Pause mandate
      </Button>
      <Button variant="danger" size="sm" icon={<Trash2 aria-hidden="true" strokeWidth={1.5} />}>
        Delete saved view
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
