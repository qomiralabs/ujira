// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Page } from '@playwright/test';

import { createFakeApi, type FakeApi, type FakeApiOptions } from '../src/data/fake-api';

/**
 * Answers every API request the page makes from the typed fake, running here
 * in the test process. The browser sees real HTTP answers, so the screen
 * goes through its own data client and schemas exactly as it would live.
 */
export async function serveFakeApi(page: Page, options: FakeApiOptions = {}): Promise<FakeApi> {
  const fake = createFakeApi(options);
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const headers = Object.entries(await request.allHeaders()).filter(
      ([name]) => !name.startsWith(':'),
    );
    const body = request.postData();
    const response = await fake.handle(
      new Request(request.url(), {
        method: request.method(),
        headers,
        ...(body === null ? {} : { body }),
      }),
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  return fake;
}
