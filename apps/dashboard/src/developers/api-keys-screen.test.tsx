// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDataClient } from '../data/client';
import { createFakeApi, FAKE_STEP_UP_CODE, type FakeApi } from '../data/fake-api';
import { DataClientProvider } from '../data/provider';
import { ApiKeysScreen } from './api-keys-screen';

// Each flow is several round trips through the fake; a loaded machine needs the room.
configure({ asyncUtilTimeout: 5_000 });

const NOW = new Date('2026-11-06T10:00:00.000Z');
const KEY_TEXT = /ujk_test_[a-z2-7]{16}_[a-z2-7]{59}/;

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function renderScreen(project = 'labelling', fake: FakeApi = createFakeApi({ now: () => NOW })) {
  const client = createDataClient({ baseUrl: 'http://localhost:3000', fetch: fake.fetch });
  const view = render(
    <DataClientProvider client={client}>
      <ApiKeysScreen project={project} />
    </DataClientProvider>,
  );
  return { fake, ...view };
}

async function rows(): Promise<HTMLElement[]> {
  const table = await screen.findByRole('table', { name: 'API keys' });
  return within(table).getAllByRole('row').slice(1);
}

function rowFor(name: string): HTMLElement {
  const table = screen.getByRole('table', { name: 'API keys' });
  const row = within(table)
    .getAllByRole('row')
    .find((r) => within(r).queryByText(name, { exact: true }) !== null);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

async function passStepUp(code = FAKE_STEP_UP_CODE): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
  fireEvent.change(within(dialog).getByLabelText('Code'), { target: { value: code } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
}

async function openCreate(): Promise<HTMLElement> {
  await rows();
  fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
  return screen.findByRole('dialog', { name: 'Create an API key' });
}

describe('ApiKeysScreen', { timeout: 30_000 }, () => {
  it('shows a loading state, then each key by name and prefix with its dates and status', async () => {
    renderScreen();
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toContain('Loading API keys');
    const list = await rows();
    expect(list).toHaveLength(5);
    const payroll = rowFor('Payroll server');
    expect(payroll.textContent).toContain('ujk_test_pq7rx2mzk4ahwd3e');
    expect(payroll.textContent).toContain('Payouts');
    expect(payroll.textContent).toContain('Active');
    expect(payroll.textContent).toContain('20 Apr 2026');
    expect(rowFor('Reporting').textContent).toContain('Never');
    expect(rowFor('Nightly export').textContent).toContain('Revoked');
    expect(rowFor('Staging').textContent).toContain('Expired');
  });

  it('marks a key that expires within 14 days, in words', async () => {
    renderScreen();
    await rows();
    expect(rowFor('Labelling agent').textContent).toContain('Expires in 10 days');
    expect(rowFor('Payroll server').textContent).not.toContain('Expires in');
    expect(rowFor('Labelling agent').textContent).toContain('3 permissions');
  });

  it('offers rotate and revoke only where they can work', async () => {
    renderScreen();
    await rows();
    const buttons = (name: string) =>
      within(rowFor(name))
        .queryAllByRole('button')
        .map((b) => b.getAttribute('aria-label'));
    expect(buttons('Payroll server')).toEqual(['Rotate Payroll server', 'Revoke Payroll server']);
    expect(buttons('Staging')).toEqual([]);
    expect(buttons('Nightly export')).toEqual([]);
  });

  it('says what went wrong with a reference, and loads again when asked', async () => {
    const fake = createFakeApi({ now: () => NOW });
    fake.failNext({ method: 'GET', path: '/v1/api-keys' }, 'DB_UNAVAILABLE');
    renderScreen('labelling', fake);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Your API keys did not load');
    expect(alert.textContent).toMatch(/Reference req_fake_\d{8}/);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await rows()).toHaveLength(5);
  });

  it('says what to do when a project has no keys yet', async () => {
    renderScreen('grants');
    const empty = await screen.findByRole('region', { name: 'No API keys yet' });
    expect(empty.textContent).toContain('Create a key');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('loads the keys of the project chosen, and only those', async () => {
    const fake = createFakeApi({ now: () => NOW });
    const client = createDataClient({ baseUrl: 'http://localhost:3000', fetch: fake.fetch });
    const { rerender } = render(
      <DataClientProvider client={client}>
        <ApiKeysScreen project="labelling" />
      </DataClientProvider>,
    );
    expect(await rows()).toHaveLength(5);
    rerender(
      <DataClientProvider client={client}>
        <ApiKeysScreen project="bounties" />
      </DataClientProvider>,
    );
    await waitFor(() => {
      expect(screen.queryAllByText('Payroll server')).toEqual([]);
    });
    expect(await rows()).toHaveLength(1);
    expect(rowFor('Bounty bot').textContent).toContain('ujk_test_bt4mz6qrw3kxpe5n');
  });

  it('asks for a name and a choice of permissions before it creates anything', async () => {
    const { fake } = renderScreen();
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByText('Give the key a name.')).toBeTruthy();
    expect(within(dialog).getByText('Choose what this key may do.')).toBeTruthy();
    expect(fake.served.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('creates a key after a step up and shows it once, with a copy button', async () => {
    const { fake } = renderScreen();
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'CI runner' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Payouts' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));

    await passStepUp('111111');
    expect(
      await screen.findByText('That code did not work. Enter the newest code your app shows.'),
    ).toBeTruthy();
    await passStepUp();

    const reveal = await screen.findByRole('dialog', { name: 'Copy your new API key' });
    expect(reveal.textContent).toContain('This is the only time UJIRA shows this key');
    const secret = within(reveal).getByText(KEY_TEXT).textContent;
    expect(secret).toMatch(KEY_TEXT);

    fireEvent.click(within(reveal).getByRole('button', { name: 'Copy key' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(secret);
    });
    expect(
      await within(reveal).findByText('Copied. Paste it where your software keeps secrets.'),
    ).toBeTruthy();

    fireEvent.click(within(reveal).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.body.innerHTML).not.toContain(secret);
    const created = rowFor('CI runner');
    expect(created.textContent).toContain(secret.slice(0, 25));
    expect(created.textContent).toContain('Payouts');
    expect(created.textContent).toContain('6 Nov 2027');
    const post = fake.served.find(
      (r) => r.method === 'POST' && r.path === '/v1/api-keys' && r.status === 201,
    );
    expect(post).toBeDefined();
  });

  it('creates a key with just the permissions ticked', async () => {
    const { fake } = renderScreen();
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Read receipts' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Choose permissions' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByText('Tick at least one permission.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /See receipts/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /See payouts/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    await passStepUp();
    await screen.findByRole('dialog', { name: 'Copy your new API key' });
    const sent = fake.served.find((r) => r.method === 'POST' && r.status === 201);
    expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({
      scopes: ['payouts:read', 'receipts:read'],
    });
  });

  it('explains the limit when a project already has 20 live keys', async () => {
    const fake = createFakeApi({ now: () => NOW });
    fake.failNext({ method: 'POST', path: '/v1/api-keys' }, 'API_KEY_LIMIT_REACHED');
    renderScreen('labelling', fake);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'One more' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Read only' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    const message = await within(dialog).findByRole('alert');
    expect(message.textContent).toContain('already has 20 live keys');
  });

  it('leaves everything as it was when the step up is cancelled', async () => {
    const { fake } = renderScreen();
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'CI runner' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Read only' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    fireEvent.click(within(stepUp).getByRole('button', { name: 'Cancel' }));
    const message = await within(dialog).findByRole('alert');
    expect(message.textContent).toContain('No key was created');
    expect(fake.served.filter((r) => r.status === 201)).toEqual([]);
  });

  it('revokes a key only once its name is typed, after a step up', async () => {
    renderScreen();
    await rows();
    fireEvent.click(within(rowFor('Payroll server')).getByRole('button', { name: /Revoke/ }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Revoke Payroll server?' });
    expect(confirm.textContent).toContain('stops working within 30 seconds');
    const button = within(confirm).getByRole('button', { name: 'Revoke key' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(confirm).getByLabelText(/to confirm/), {
      target: { value: 'payroll server' },
    });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(confirm).getByLabelText(/to confirm/), {
      target: { value: 'Payroll server' },
    });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    await passStepUp();
    await waitFor(() => {
      expect(rowFor('Payroll server').textContent).toContain('Revoked');
    });
    expect(screen.getByRole('status').textContent).toContain('Payroll server is revoked');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('rotates a key, shows the overlap first, and then the new key once', async () => {
    renderScreen();
    await rows();
    fireEvent.click(within(rowFor('Payroll server')).getByRole('button', { name: /Rotate/ }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Rotate Payroll server?' });
    expect(confirm.textContent).toContain('keeps working for 24 hours, until 7 Nov 2026');
    fireEvent.change(within(confirm).getByLabelText(/to confirm/), {
      target: { value: 'Payroll server' },
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Rotate key' }));
    await passStepUp();
    const reveal = await screen.findByRole('dialog', { name: 'Copy the replacement key' });
    expect(reveal.textContent).toContain('The old key keeps working until 7 Nov 2026');
    const secret = within(reveal).getByText(KEY_TEXT).textContent;
    await act(async () => {
      fireEvent.click(within(reveal).getByRole('button', { name: 'Done' }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.body.innerHTML).not.toContain(secret);
    const payroll = within(screen.getByRole('table', { name: 'API keys' }))
      .getAllByRole('row')
      .filter((r) => r.textContent.includes('Payroll server'));
    expect(payroll).toHaveLength(2);
    expect(payroll.map((r) => r.textContent).join(' ')).toContain('Being replaced');
  });

  it('says so when a change fails, with the reference, and changes nothing', async () => {
    const fake = createFakeApi({ now: () => NOW });
    renderScreen('labelling', fake);
    await rows();
    fake.failNext(
      { method: 'POST', path: '/v1/api-keys/5f0c1a2e-0000-4000-8000-000000000001/revoke' },
      'INTERNAL',
    );
    fireEvent.click(within(rowFor('Payroll server')).getByRole('button', { name: /Revoke/ }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.change(within(confirm).getByLabelText(/to confirm/), {
      target: { value: 'Payroll server' },
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke key' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Payroll server was not revoked');
    expect(alert.textContent).toMatch(/Reference req_fake_\d{8}/);
    expect(rowFor('Payroll server').textContent).toContain('Active');
  });
});
