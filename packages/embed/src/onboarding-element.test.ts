// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { en } from './i18n/en.js';
import { define, TAG_NAME } from './index.js';
import {
  COMPLETE_EVENT,
  STEP_CHANGE_EVENT,
  type CompleteDetail,
  type StepChangeDetail,
  type UjiraOnboarding,
} from './onboarding-element.js';

const WALLET = `G${'A'.repeat(55)}`;

let widget: UjiraOnboarding;

function root(): ShadowRoot {
  const shadow = widget.shadowRoot;
  if (shadow === null) throw new Error('the widget has no shadow root');
  return shadow;
}

function text(): string {
  return root().textContent;
}

function find(selector: string): HTMLElement {
  const found = root().querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}

function findInput(): HTMLInputElement {
  const found = find('input');
  if (!(found instanceof HTMLInputElement)) throw new Error('that is not an input');
  return found;
}

function findButton(selector: string): HTMLButtonElement {
  const found = find(selector);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`${selector} is not a button`);
  return found;
}

function findForm(): HTMLFormElement {
  const found = find('form');
  if (!(found instanceof HTMLFormElement)) throw new Error('that is not a form');
  return found;
}

async function type(value: string): Promise<void> {
  const input = findInput();
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await widget.updateComplete;
}

async function submit(): Promise<void> {
  findForm().requestSubmit();
  await widget.updateComplete;
}

async function fillInEverything(): Promise<void> {
  await type('Amara Eze');
  await submit();
  await submit();
  await type(WALLET);
  await submit();
}

beforeEach(async () => {
  widget = document.createElement(TAG_NAME);
  document.body.replaceChildren(widget);
  await widget.updateComplete;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('ujira-onboarding', () => {
  it('is defined once, however many script tags load it', () => {
    const first = customElements.get(TAG_NAME);
    define();
    expect(customElements.get(TAG_NAME)).toBe(first);
  });

  it('opens on the first question with nowhere to go back to', () => {
    expect(widget.currentStep).toBe('name');
    expect(find('.progress').textContent.trim()).toBe('Step 1 of 4');
    expect(root().querySelector('.text-button')).toBeNull();
    expect(find('section').getAttribute('aria-label')).toBe(en['widget.label']);
  });

  it('names the widget region and carries the byline once', () => {
    expect(text()).toContain(en['footer.byline']);
    expect(root().querySelectorAll('.footer')).toHaveLength(1);
    expect(root().querySelectorAll('.footer svg')).toHaveLength(1);
  });

  it('refuses to move on without an answer, and says why', async () => {
    await submit();
    expect(widget.currentStep).toBe('name');
    expect(find('.alert').textContent.trim()).toBe(en['name.missing']);
  });

  it('clears the problem as soon as the answer changes', async () => {
    await submit();
    await type('A');
    expect(root().querySelector('.alert')).toBeNull();
  });

  it('walks a person through every step', async () => {
    await type('Amara Eze');
    await submit();
    expect(widget.currentStep).toBe('method');
    expect(find('.progress').textContent.trim()).toBe('Step 2 of 4');
    expect(find('.text-button').textContent.trim()).toBe(`Back to ${en['step.name.short']}`);

    await submit();
    expect(widget.currentStep).toBe('destination');
    await type('GABC');
    await submit();
    expect(widget.currentStep).toBe('destination');
    expect(find('.alert').textContent.trim()).toBe(en['destination.wallet.invalid']);

    await type(WALLET);
    await submit();
    expect(widget.currentStep).toBe('review');
    expect(text()).toContain('Amara Eze');
    expect(text()).toContain(WALLET);
  });

  it('goes back to the step a person came from', async () => {
    await type('Amara Eze');
    await submit();
    findButton('.text-button').click();
    await widget.updateComplete;
    expect(widget.currentStep).toBe('name');
    expect(findInput().value).toBe('Amara Eze');
  });

  it('moves focus to the new question', async () => {
    await type('Amara Eze');
    await submit();
    expect(root().activeElement).toBe(find('.heading'));
  });

  it('reports every step change', async () => {
    const seen: StepChangeDetail[] = [];
    widget.addEventListener(STEP_CHANGE_EVENT, (event) => {
      seen.push((event as CustomEvent<StepChangeDetail>).detail);
    });
    await fillInEverything();
    expect(seen).toEqual([
      { step: 'method', position: 2, total: 4 },
      { step: 'destination', position: 3, total: 4 },
      { step: 'review', position: 4, total: 4 },
    ]);
  });

  it('hands the answers over and closes', async () => {
    const seen: CompleteDetail[] = [];
    widget.addEventListener(COMPLETE_EVENT, (event) => {
      seen.push((event as CustomEvent<CompleteDetail>).detail);
    });
    await fillInEverything();
    await submit();
    expect(seen).toEqual([{ name: 'Amara Eze', method: 'wallet', destination: WALLET }]);
    expect(widget.currentStep).toBe('done');
    expect(text()).toContain(en['method.wallet.name']);
    expect(root().querySelector('.progress')).toBeNull();
  });

  it('waits on the review step when the host takes over the saving', async () => {
    widget.addEventListener(COMPLETE_EVENT, (event) => {
      event.preventDefault();
    });
    await fillInEverything();
    await submit();
    expect(widget.currentStep).toBe('review');

    widget.busy = true;
    await widget.updateComplete;
    expect(text()).toContain(en['widget.busy']);
    expect(findButton('.primary').disabled).toBe(true);

    widget.busy = false;
    widget.finish();
    await widget.updateComplete;
    expect(widget.currentStep).toBe('done');
  });

  it('shows the failure message from the integrator in place of ours', async () => {
    widget.error = 'Your account is closed. Call us on 0800 000 000.';
    await widget.updateComplete;
    expect(find('.alert').textContent.trim()).toBe(widget.error);
  });

  it('starts again when asked', async () => {
    await fillInEverything();
    widget.reset();
    await widget.updateComplete;
    expect(widget.currentStep).toBe('name');
    expect(widget.currentAnswers).toEqual({ name: '', method: 'wallet', destination: '' });
  });

  it('hands out a copy of the answers, not the answers themselves', async () => {
    await type('Amara Eze');
    const answers = widget.currentAnswers;
    answers.name = 'Someone else';
    await widget.updateComplete;
    expect(widget.currentAnswers.name).toBe('Amara Eze');
  });

  it('takes the mode and locale from the page', async () => {
    widget.setAttribute('mode', 'dark');
    widget.setAttribute('locale', 'ha');
    await widget.updateComplete;
    expect(widget.mode).toBe('dark');
    expect(find('.heading').textContent).toBe(en['name.heading']);
  });

  it('defaults to light, the way a recipient screen should', () => {
    expect(widget.getAttribute('mode')).toBe('light');
  });
});
