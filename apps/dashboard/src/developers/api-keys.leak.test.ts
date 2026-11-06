// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A new key's whole text exists in one answer and one dialog. These tests go
// looking for it everywhere else a browser could keep it.

import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createDataClient } from '../data/client';
import { createFakeApi, FAKE_STEP_UP_CODE } from '../data/fake-api';
import { DataClientProvider } from '../data/provider';
import { ApiKeysScreen } from './api-keys-screen';

// Each flow is several round trips through the fake; a loaded machine needs the room.
configure({ asyncUtilTimeout: 5_000 });

const NOW = new Date('2026-11-06T10:00:00.000Z');
const KEY_TEXT = /ujk_test_[a-z2-7]{16}_[a-z2-7]{59}/;
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir'] as const;

let spies: MockInstance[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
  });
  spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method));
  sessionStorage.clear();
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  vi.useRealTimers();
});

function storageText(storage: Storage): string {
  const parts: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const name = storage.key(i) ?? '';
    parts.push(name, storage.getItem(name) ?? '');
  }
  return parts.join('\n');
}

function consoleText(): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((args) =>
      args
        .map((arg: unknown) =>
          arg instanceof Error ? `${arg.name} ${arg.message} ${arg.stack ?? ''}` : String(arg),
        )
        .join(' '),
    )
    .join('\n');
}

async function createKeyAndRead(): Promise<{
  secret: string;
  reveal: HTMLElement;
  fake: ReturnType<typeof createFakeApi>;
}> {
  const fake = createFakeApi({ now: () => NOW });
  const client = createDataClient({ baseUrl: 'http://localhost:3000', fetch: fake.fetch });
  render(
    createElement(DataClientProvider, {
      client,
      children: createElement(ApiKeysScreen, { project: 'labelling' }),
    }),
  );
  await screen.findByRole('table', { name: 'API keys' });
  fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
  const dialog = await screen.findByRole('dialog', { name: 'Create an API key' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
    target: { value: 'CI runner' },
  });
  fireEvent.click(within(dialog).getByRole('radio', { name: 'Full access' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
  const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
  fireEvent.change(within(stepUp).getByLabelText('Code'), { target: { value: FAKE_STEP_UP_CODE } });
  fireEvent.click(within(stepUp).getByRole('button', { name: 'Confirm' }));
  const reveal = await screen.findByRole('dialog', { name: 'Copy your new API key' });
  const secret = within(reveal).getByText(KEY_TEXT).textContent;
  expect(secret).toMatch(KEY_TEXT);
  return { secret, reveal, fake };
}

describe('api keys', { timeout: 30_000 }, () => {
  it('the secret is absent from local storage, session storage and captured console output', async () => {
    const { secret, reveal, fake } = await createKeyAndRead();
    fireEvent.click(within(reveal).getByRole('button', { name: 'Copy key' }));
    expect(await within(reveal).findByText(/^Copied/)).toBeTruthy();

    // While it is on screen, and again after the dialog closes.
    for (const phase of ['open', 'closed']) {
      expect(storageText(localStorage), phase).not.toContain(secret);
      expect(storageText(sessionStorage), phase).not.toContain(secret);
      expect(document.cookie, phase).not.toContain(secret);
      expect(window.location.href, phase).not.toContain(secret);
      expect(consoleText(), phase).not.toContain(secret);
      if (phase === 'open') {
        fireEvent.click(within(reveal).getByRole('button', { name: 'Done' }));
        await waitFor(() => {
          expect(screen.queryByRole('dialog')).toBeNull();
        });
      }
    }

    // Gone from the page, and from every answer after the one that issued it.
    expect(document.documentElement.outerHTML).not.toContain(secret);
    const issued = fake.served.findIndex((r) => r.body.includes(secret));
    expect(issued).toBeGreaterThanOrEqual(0);
    const later = fake.served.slice(issued + 1);
    expect(later.length).toBeGreaterThan(0);
    for (const response of later) expect(response.body).not.toContain(secret);
  });

  it('keeps the secret out of the console even when something fails around it', async () => {
    const { secret, reveal } = await createKeyAndRead();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    fireEvent.click(within(reveal).getByRole('button', { name: 'Copy key' }));
    expect(await within(reveal).findByText(/Copying did not work/)).toBeTruthy();
    expect(consoleText()).not.toContain(secret);
  });
});
