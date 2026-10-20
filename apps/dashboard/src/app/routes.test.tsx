// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { render, screen } from '@testing-library/react';
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

describe('routes', () => {
  it('opens Overview with its one primary action', () => {
    render(<OverviewPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    const action = screen.getByRole('link', { name: 'Set up a mandate' });
    expect(action.getAttribute('href')).toBe('/mandates');
    expect(action.className).toContain('bg-accent-fill');
  });

  it.each(Object.entries(SECTION_PAGES))(
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
    expect(alert.textContent).toContain('d1g35t');
    expect(alert.textContent).not.toContain('boom');
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(reset).toHaveBeenCalledOnce();
    rerender(<ErrorPage error={new Error('boom')} reset={reset} />);
    expect(screen.getByRole('alert').textContent).not.toContain('reference');
  });

  it('brings its own document when the frame fails', () => {
    const html = renderToStaticMarkup(
      <GlobalError error={Object.assign(new Error('x'), { digest: 'r3f' })} reset={vi.fn()} />,
    );
    expect(html).toMatch(/^<html lang="en">/);
    expect(html).toContain('The dashboard did not load');
    expect(html).toContain('r3f');
    expect(
      renderToStaticMarkup(<GlobalError error={new Error('x')} reset={vi.fn()} />),
    ).not.toContain('Reference');
  });

  it('points a missing page back to the navigation', () => {
    render(<NotFound />);
    expect(screen.getByRole('region', { name: 'There is no page at this address' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to overview' }).getAttribute('href')).toBe('/');
  });
});
