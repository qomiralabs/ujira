// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { RecipientPage, RecipientSummaryView } from '@ujira/api-schema';
import { describe, expect, it } from 'vitest';

import { PERSON, problemOf, recipientWorld } from './recipients.test-support.js';

const RECIPIENTS = '/v1/recipients';

describe('GET /v1/recipients', () => {
  it('list contains no personal fields', async () => {
    const world = recipientWorld();
    await world.newRecipient({ country: 'KE', personal: PERSON });
    await world.newRecipient({ country: 'NG', personal: { fullName: 'Grace Hopper' } });
    const response = await world.request('GET', RECIPIENTS);
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const value of [...Object.values(PERSON), 'Grace Hopper']) {
      expect(text).not.toContain(value);
    }
    const page = RecipientPage.parse(JSON.parse(text));
    expect(page.items).toHaveLength(2);
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(Object.keys(RecipientSummaryView.shape).sort());
    }
  });

  it('never decrypts anything to build a list', async () => {
    const world = recipientWorld();
    await world.newRecipient({ country: 'KE', personal: PERSON });
    expect((await world.request('GET', RECIPIENTS)).status).toBe(200);
    expect(world.cipher.decrypted()).toBe(0);
  });

  it('shows one tenant only its own', async () => {
    const world = recipientWorld();
    const mine = await world.newRecipient();
    const page = RecipientPage.parse(
      await (
        await world.request('GET', RECIPIENTS, undefined, { authorization: 'Bearer bravo' })
      ).json(),
    );
    expect(page.items.map((item) => item.id)).not.toContain(mine);
  });

  it('pages through in order', async () => {
    const world = recipientWorld();
    const ids = [
      await world.newRecipient(),
      await world.newRecipient(),
      await world.newRecipient(),
    ].sort();
    const first = RecipientPage.parse(
      await (await world.request('GET', `${RECIPIENTS}?limit=2`)).json(),
    );
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    expect(first.nextAfter).toBe(ids[1]);
    const rest = RecipientPage.parse(
      await (
        await world.request('GET', `${RECIPIENTS}?limit=2&after=${first.nextAfter ?? ''}`)
      ).json(),
    );
    expect(rest.items.map((item) => item.id)).toEqual(ids.slice(2));
    expect(rest.nextAfter).toBeNull();
  });

  it('refuses a limit out of range', async () => {
    const world = recipientWorld();
    const response = await world.request('GET', `${RECIPIENTS}?limit=500`);
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('INVALID_FILTER');
  });
});
