// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { PAYOUT_STATUSES } from '@ujira/api-schema';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BADGE_STATUSES, STATUS_SPECS, StatusBadge, type BadgeStatus } from './status-badge.js';

afterEach(cleanup);

// The first render loads React and the icons, which is slow on a loaded runner.
describe('StatusBadge', { timeout: 30_000 }, () => {
  it('covers every public payout status', () => {
    for (const status of PAYOUT_STATUSES) expect(BADGE_STATUSES).toContain(status);
    expect(Object.keys(STATUS_SPECS).sort()).toEqual([...BADGE_STATUSES].sort());
  });

  it.each(BADGE_STATUSES)('every status renders its word and an icon: %s', (status) => {
    const { container } = render(<StatusBadge status={status} />);
    const badge = container.querySelector('[data-slot="status-badge"]');
    expect(badge?.textContent).toBe(STATUS_SPECS[status].word);
    const icon = badge?.querySelector('svg');
    expect(icon).not.toBeNull();
    // The icon repeats the word, so assistive technology skips it.
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(badge?.getAttribute('data-tone')).toBe(STATUS_SPECS[status].tone);
  });

  it.each(BADGE_STATUSES)('the accessible name is the word: %s', (status) => {
    render(
      <table>
        <tbody>
          <tr>
            <td>
              <StatusBadge status={status} />
            </td>
          </tr>
        </tbody>
      </table>,
    );
    expect(screen.getByRole('cell').textContent).toBe(STATUS_SPECS[status].word);
    expect(screen.getByRole('cell', { name: STATUS_SPECS[status].word })).toBeTruthy();
  });

  it('gives every status its own word, so no two states read the same in one list', () => {
    // The approval and delivery views each show one family, so a word may
    // repeat across families but never inside one.
    const payoutWords = PAYOUT_STATUSES.map((status) => STATUS_SPECS[status].word);
    expect(new Set(payoutWords).size).toBe(payoutWords.length);
    const approvalWords = (
      ['approval_waiting', 'approval_approved', 'approval_rejected'] as const
    ).map((status) => STATUS_SPECS[status].word);
    expect(new Set(approvalWords).size).toBe(3);
    const deliveryWords = (['in_transit', 'arrived', 'verified'] as const).map(
      (status) => STATUS_SPECS[status].word,
    );
    expect(new Set(deliveryWords).size).toBe(3);
  });

  it('maps the states the brand names to the brand colours', () => {
    const tone = (status: BadgeStatus) => STATUS_SPECS[status].tone;
    for (const status of ['paid', 'arrived', 'verified'] as const)
      expect(tone(status)).toBe('paid');
    for (const status of ['pending_approval', 'approval_waiting', 'in_transit'] as const) {
      expect(tone(status)).toBe('waiting');
    }
    for (const status of ['blocked', 'failed', 'rejected', 'approval_rejected'] as const) {
      expect(tone(status)).toBe('blocked');
    }
  });

  it('is a fully rounded pill set as a label', () => {
    const { container } = render(<StatusBadge status="paid" />);
    const classes = container.querySelector('[data-slot="status-badge"]')?.className ?? '';
    expect(classes).toContain('rounded-full');
    expect(classes).toContain('font-mono');
    expect(classes).toContain('text-label');
    expect(classes).toContain('uppercase');
    expect(classes).toContain('whitespace-nowrap');
  });

  it('draws the word in the status text colour, which holds AA on both grounds', () => {
    const tones = { paid: 'text-paid', waiting: 'text-waiting', blocked: 'text-blocked' } as const;
    for (const [status, colour] of [
      ['paid', tones.paid],
      ['settling', tones.waiting],
      ['failed', tones.blocked],
    ] as const) {
      const { container, unmount } = render(<StatusBadge status={status} />);
      const classes = container.querySelector('[data-slot="status-badge"]')?.className ?? '';
      expect(classes.split(' '), status).toContain(colour);
      unmount();
    }
  });
});
