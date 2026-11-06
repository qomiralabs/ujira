// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

// The identity check, through the real HTTP client, against the fake API
// behind a stub fetch. What matters most here is what leaves the page: only
// a status and an opaque reference ever reach UJIRA about a check. The
// documents stay with Self or the anchor.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiProblem, type OnboardingClient } from './api/client.js';
import { fakeClient, FAKE_RECIPIENT, type FakeScenario } from './api/fake.js';
import { en } from './i18n/en.js';
import { TAG_NAME } from './index.js';
import type { UjiraOnboarding } from './onboarding-element.js';

const BASE = 'https://api.example';

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

/** Serves the fake client over HTTP, the way the real API would answer. */
function serving(client: OnboardingClient, sent: Sent[]): typeof fetch {
  const routes: [string, RegExp, (match: string[], body: never) => Promise<unknown>][] = [
    ['GET', /^\/v1\/embed\/onboarding$/, () => client.session()],
    [
      'POST',
      /^\/v1\/embed\/recipients\/([^/]+)\/verifications$/,
      ([id], body: { method: never }) => client.startVerification(id ?? '', body.method),
    ],
    [
      'POST',
      /^\/v1\/embed\/recipients\/([^/]+)\/verifications\/([^/]+)\/reports$/,
      ([id, check], body: never) => client.reportVerification(id ?? '', check ?? '', body),
    ],
    [
      'GET',
      /^\/v1\/embed\/recipients\/([^/]+)\/verifications\/([^/]+)$/,
      ([id, check]) => client.verificationState(id ?? '', check ?? ''),
    ],
  ];
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ method, path: url.pathname, body });
    for (const [verb, pattern, answer] of routes) {
      const match = pattern.exec(url.pathname);
      if (verb !== method || match === null) continue;
      try {
        const json = await answer(match.slice(1).map(decodeURIComponent), body as never);
        return new Response(JSON.stringify(json), { status: 200 });
      } catch (error) {
        const problem = error instanceof ApiProblem ? error.problem : { status: 500, code: 'X' };
        return new Response(JSON.stringify(problem), { status: problem.status });
      }
    }
    return new Response(JSON.stringify({ status: 404, code: 'NOT_FOUND' }), { status: 404 });
  };
}

let widget: UjiraOnboarding;

function root(): ShadowRoot {
  const shadow = widget.shadowRoot;
  if (shadow === null) throw new Error('the widget has no shadow root');
  return shadow;
}

function find(selector: string): HTMLElement {
  const found = root().querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 8; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await widget.updateComplete;
  }
}

async function submit(): Promise<void> {
  const form = find('form');
  if (!(form instanceof HTMLFormElement)) throw new Error('that is not a form');
  form.requestSubmit();
  await settle();
}

interface Popup {
  opener: unknown;
  location: { replace: (url: string) => void };
  close: () => void;
  loaded: string[];
}

function stubPopup(): Popup {
  const popup: Popup = {
    opener: 'the widget page',
    loaded: [],
    location: { replace: (url) => popup.loaded.push(url) },
    close: () => undefined,
  };
  vi.stubGlobal('open', () => popup);
  return popup;
}

async function open(scenario: Partial<FakeScenario>, sent: Sent[]): Promise<void> {
  vi.stubGlobal('fetch', serving(fakeClient(scenario), sent));
  widget = document.createElement(TAG_NAME);
  widget.setAttribute('api-base', BASE);
  widget.setAttribute('session-token', 'ujes_test_fake');
  document.body.replaceChildren(widget);
  await settle();
}

const SELF_WALLET: Partial<FakeScenario> = {
  verifications: [{ method: 'stellar_wallet', provider: 'self', status: null }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('verify', () => {
  it('only status and reference are posted', async () => {
    const sent: Sent[] = [];
    const popup = stubPopup();
    await open(SELF_WALLET, sent);
    await submit();
    expect(widget.currentStep).toBe('verify');
    await submit();
    await submit();
    expect(widget.currentStep).toBe('destination');

    const checks = sent.filter((request) => request.path.includes('/verifications'));
    const posted = checks.filter((request) => request.method === 'POST');
    expect(posted.map((request) => request.body)).toEqual([
      { method: 'stellar_wallet' },
      { status: 'completed', reference: 'check-0001' },
    ]);
    // Every path names the recipient and the check by opaque id, nothing else.
    for (const request of checks) {
      expect(request.path).toMatch(
        new RegExp(
          `^/v1/embed/recipients/${FAKE_RECIPIENT}/verifications(/check-\\d+(/reports)?)?$`,
        ),
      );
    }
    expect(popup.loaded).toEqual(['https://verify.example/self/check-0001']);
    expect(popup.opener).toBeNull();
  });

  it('a wallet recipient in allowlist mode is never asked for a check', async () => {
    const sent: Sent[] = [];
    await open({}, sent);
    await submit();
    expect(widget.currentStep).toBe('destination');
    expect(find('.progress').textContent.trim()).toBe('Step 2 of 4');
    expect(sent.some((request) => request.path.includes('/verifications'))).toBe(false);
  });

  it('counts the check as a step, and keeps counting it once it passed', async () => {
    stubPopup();
    await open(SELF_WALLET, []);
    expect(find('.progress').textContent.trim()).toBe('Step 1 of 5');
    await submit();
    expect(find('.progress').textContent.trim()).toBe('Step 2 of 5');
    expect(find('.primary').textContent.trim()).toBe(en['verify.self.action']);
    await submit();
    await submit();
    expect(find('.progress').textContent.trim()).toBe('Step 3 of 5');
  });

  it('says the result is not in yet, and moves on by itself once it is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      stubPopup();
      const client = fakeClient(SELF_WALLET);
      widget = document.createElement(TAG_NAME);
      // A report that leaves the check pending, then a look that finds it passed.
      let passed = false;
      widget.client = {
        ...client,
        reportVerification: (id, check) => client.verificationState(id, check),
        verificationState: async (id, check) => {
          const state = await client.verificationState(id, check);
          return passed ? { ...state, status: 'verified' } : state;
        },
      };
      document.body.replaceChildren(widget);
      await settle();
      await submit();
      await submit();
      await submit();
      expect(find('.alert').textContent.trim()).toBe(en['verify.pending']);
      passed = true;
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(widget.currentStep).toBe('destination');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says plainly when the check failed, and offers to start again', async () => {
    stubPopup();
    await open({ ...SELF_WALLET, verificationOutcome: 'rejected' }, []);
    await submit();
    await submit();
    await submit();
    expect(widget.currentStep).toBe('verify');
    expect(find('.alert').textContent.trim()).toBe(en['verify.rejected']);
    expect(find('.primary').textContent.trim()).toBe(en['verify.retry']);
  });

  it('says so when the check closed before it was finished', async () => {
    stubPopup();
    await open({ ...SELF_WALLET, verificationOutcome: 'expired' }, []);
    await submit();
    await submit();
    await submit();
    expect(find('.alert').textContent.trim()).toBe(en['verify.expired']);
  });

  it('picks up a check left open, with its page to open again', async () => {
    const sent: Sent[] = [];
    await open(
      {
        verifications: [
          {
            method: 'stellar_wallet',
            provider: 'self',
            status: 'pending',
            verificationId: 'check-0042',
          },
        ],
      },
      sent,
    );
    await submit();
    expect(widget.currentStep).toBe('verify');
    expect(find('.heading').textContent).toBe(en['verify.waiting.heading']);
    const reopen = find('a.text-button');
    expect(reopen.getAttribute('href')).toBe('https://verify.example/self/check-0042');
    expect(reopen.getAttribute('rel')).toBe('noopener noreferrer');
    expect(find('.primary').textContent.trim()).toBe(en['verify.finished']);
  });

  it('skips a check that already passed', async () => {
    await open(
      { verifications: [{ method: 'stellar_wallet', provider: 'self', status: 'verified' }] },
      [],
    );
    await submit();
    expect(widget.currentStep).toBe('destination');
    expect(find('.progress').textContent.trim()).toBe('Step 2 of 4');
  });

  it('works where pop-ups are blocked, through the link', async () => {
    vi.stubGlobal('open', () => null);
    await open(SELF_WALLET, []);
    await submit();
    await submit();
    expect(find('a.text-button').getAttribute('href')).toBe(
      'https://verify.example/self/check-0001',
    );
  });

  it('goes back past the check rather than into it', async () => {
    stubPopup();
    await open(SELF_WALLET, []);
    await submit();
    await submit();
    await submit();
    expect(widget.currentStep).toBe('destination');
    find('.text-button').click();
    await settle();
    expect(widget.currentStep).toBe('method');
    await submit();
    expect(widget.currentStep).toBe('destination');
  });

  it('says so when the check could not be started', async () => {
    vi.stubGlobal('open', () => null);
    const client = fakeClient(SELF_WALLET);
    widget = document.createElement(TAG_NAME);
    widget.client = {
      ...client,
      startVerification: () => Promise.reject(new ApiProblem({ status: 503, code: 'X' })),
    };
    document.body.replaceChildren(widget);
    await settle();
    await submit();
    await submit();
    expect(find('.alert').textContent.trim()).toBe(en['verify.failed']);
  });
});
