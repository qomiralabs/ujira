// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectSwitcher } from './project-switcher';

function open(): void {
  fireEvent.keyDown(screen.getByRole('button', { name: /Switch project/ }), { key: 'Enter' });
}

describe('ProjectSwitcher', () => {
  it('names the current project on the trigger', () => {
    render(<ProjectSwitcher project="grants" onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', {
      name: 'Project: Community grants. Switch project',
    });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.textContent).toContain('CG');
  });

  it('lists every project with the current one checked, and switches', () => {
    const onChange = vi.fn();
    render(<ProjectSwitcher project="labelling" onChange={onChange} />);
    open();
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual([
      'Labelling payouts',
      'Bug bounties',
      'Community grants',
    ]);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Bug bounties' }));
    expect(onChange).toHaveBeenCalledWith('bounties');
  });

  it('renders the menu in place when asked, for use inside a modal dialog', () => {
    const { container } = render(<ProjectSwitcher project="labelling" onChange={vi.fn()} inline />);
    open();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });
});
