// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter, type UrlUpdateEvent } from 'nuqs/adapters/testing';
import { describe, expect, it, vi } from 'vitest';

import { AppShell } from './app-shell';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

describe('AppShell', () => {
  it('frames the page with a skip link, the rail, the top bar and the main region', () => {
    render(
      <NuqsTestingAdapter>
        <AppShell>
          <p>Page body</p>
        </AppShell>
      </NuqsTestingAdapter>,
    );
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe(
      '#main',
    );
    expect(screen.getByRole('main').textContent).toBe('Page body');
    expect(screen.getAllByRole('navigation', { name: 'Main' }).length).toBeGreaterThan(0);
  });

  it('reads the project from the URL and writes a switch back to it', async () => {
    const updates: UrlUpdateEvent[] = [];
    render(
      <NuqsTestingAdapter
        searchParams="?project=bounties"
        onUrlUpdate={(event) => updates.push(event)}
      >
        <AppShell>
          <p>Page body</p>
        </AppShell>
      </NuqsTestingAdapter>,
    );
    const [trigger] = screen.getAllByRole('button', { name: /Project: Bug bounties/ });
    expect(screen.getAllByRole('link', { name: 'Payouts' })[0]?.getAttribute('href')).toBe(
      '/payouts?project=bounties',
    );
    if (!trigger) throw new Error('no project switcher');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Community grants' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(updates.at(-1)?.queryString).toBe('?project=grants');
  });
});
