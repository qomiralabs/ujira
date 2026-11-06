// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { render, screen, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import ErrorPage from './error';
import GlobalError from './global-error';
import Loading from './loading';
import NotFound from './not-found';
import OverviewPage from './page';
import * as approvals from './approvals/page';
import * as corridors from './corridors/page';
import * as developers from './developers/page';
import * as funding from './funding/page';
import * as mandates from './mandates/page';
import * as payouts from './payouts/page';
import * as receipts from './receipts/page';
import * as recipients from './recipients/page';
import * as settings from './settings/page';
import { createDataClient } from '../data/client';
import { createFakeApi } from '../data/fake-api';
import { DataClientProvider } from '../data/provider';
import { NAV_ITEMS } from '../shell/nav';

const SECTION_PAGES = Object.fromEntries(
  Object.entries({
    payouts,
    approvals,
    mandates,
    recipients,
    receipts,
    funding,
    corridors,
    developers,
    settings,
  }).map(([segment, mod]) => [segment, { Page: mod.default, metadata: mod.metadata }]),
);

// Sections whose screens are not built yet, which show what will appear.
const PLACEHOLDER_PAGES = Object.fromEntries(
  Object.entries(SECTION_PAGES).filter(([segment]) => segment !== 'developers'),
);

describe('routes', () => {
  it('opens Overview with its one primary action', () => {
    render(<OverviewPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    const action = screen.getByRole('link', { name: 'Set up a mandate' });
    expect(action.getAttribute('href')).toBe('/mandates');
    expect(action.className).toContain('bg-accent-fill');
  });

  // A round trip through the fake, so it gets the room a loaded machine needs.
  it(
    'opens Developers on the API keys, with creating a key as its one primary action',
    { timeout: 30_000 },
    async () => {
      const fake = createFakeApi();
      render(
        <NuqsTestingAdapter searchParams="?project=bounties">
          <DataClientProvider client={createDataClient({ fetch: fake.fetch })}>
            <developers.default />
          </DataClientProvider>
        </NuqsTestingAdapter>,
      );
      expect(screen.getByRole('heading', { level: 1, name: 'Developers' })).toBeTruthy();
      const table = await screen.findByRole('table', { name: 'API keys' }, { timeout: 10_000 });
      expect(within(table).getByText('Bounty bot')).toBeTruthy();
      const action = screen.getByRole('button', { name: 'Create API key' });
      expect(action.className).toContain('bg-accent-fill');
      expect(developers.metadata).toEqual({ title: 'Developers' });
    },
  );

  it.each(Object.entries(PLACEHOLDER_PAGES))(
    'renders %s with its title, summary and empty state, and no action yet',
    (segment, { Page, metadata }) => {
      const item = NAV_ITEMS.find((i) => i.segment === segment);
      if (!item) throw new Error(`no navigation item for ${segment}`);
      render(<Page />);
      expect(screen.getByRole('heading', { level: 1, name: item.label })).toBeTruthy();
      expect(screen.getByText(item.summary)).toBeTruthy();
      expect(screen.getByRole('region')).toBeTruthy();
      // Placeholder sections have nothing to do yet, so no saffron action.
      expect(screen.queryByRole('link')).toBeNull();
      expect(metadata).toEqual({ title: item.label });
    },
  );

  it('has a page for every section in the navigation', () => {
    expect(Object.keys(SECTION_PAGES)).toEqual(
      NAV_ITEMS.filter((i) => i.segment !== '').map((i) => i.segment),
    );
  });

  it('shows the skeleton while a page loads', () => {
    render(<Loading />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('explains a failed page, offers a retry and quotes the reference', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'd1g35t' });
    const { rerender } = render(<ErrorPage error={error} reset={reset} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This page did not load');
    expect(alert.textContent).toContain('quote the reference below');
    // The reference block itself, not the word in the sentence above it.
    expect(screen.getByText(/^Reference/).textContent).toContain('d1g35t');
    // Whatever went wrong is never shown to the person.
    expect(alert.textContent).not.toContain('boom');
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(reset).toHaveBeenCalledOnce();

    rerender(<ErrorPage error={new Error('boom')} reset={reset} />);
    // With no digest there is no reference block at all, and still no message.
    expect(screen.queryByText(/^Reference/)).toBeNull();
    expect(screen.getByRole('alert').textContent).not.toContain('boom');
  });

  it('brings its own document when the frame fails', () => {
    const html = renderToStaticMarkup(
      <GlobalError
        error={Object.assign(new Error('kaboom-secret'), { digest: 'r3f' })}
        reset={vi.fn()}
      />,
    );
    expect(html).toMatch(/^<html lang="en">/);
    expect(html).toContain('The dashboard did not load');
    expect(html).toContain('r3f');
    const noDigest = renderToStaticMarkup(
      <GlobalError error={new Error('boom')} reset={vi.fn()} />,
    );
    expect(noDigest).not.toContain('Reference');
    expect(noDigest).not.toContain('boom');
  });

  it('points a missing page back to the navigation', () => {
    render(<NotFound />);
    expect(screen.getByRole('region', { name: 'There is no page at this address' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to overview' }).getAttribute('href')).toBe('/');
  });
});
