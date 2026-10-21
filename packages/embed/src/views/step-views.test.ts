// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { render, type TemplateResult } from 'lit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { en } from '../i18n/en.js';
import { translator } from '../i18n/catalogue.js';
import { PAYOUT_METHODS, type PayoutMethod } from '../methods.js';
import { STEP_IDS, type Answers } from '../steps.js';
import {
  destinationStep,
  doneStep,
  methodStep,
  nameStep,
  reviewStep,
  stepView,
  type StepContext,
} from './step-views.js';

const WALLET = `G${'A'.repeat(55)}`;

function withOpen(ids: readonly string[]): readonly PayoutMethod[] {
  return PAYOUT_METHODS.map((method) => ({ ...method, open: ids.includes(method.id) }));
}

function context(overrides: Partial<StepContext> = {}): StepContext {
  const answers: Answers = { name: 'Amara Eze', method: 'wallet', destination: WALLET };
  return {
    t: translator('en'),
    answers,
    methods: PAYOUT_METHODS,
    message: '',
    busy: false,
    submit: vi.fn(),
    change: vi.fn(),
    choose: vi.fn(),
    goTo: vi.fn(),
    ...overrides,
  };
}

let host: HTMLElement;

function draw(template: TemplateResult): HTMLElement {
  render(template, host);
  return host;
}

function text(): string {
  return host.textContent;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.replaceChildren(host);
});

describe('step views', () => {
  it('asks for a name, with the label and hint from the catalogue', () => {
    draw(nameStep(context()));
    expect(host.querySelector('.heading')?.textContent).toBe(en['name.heading']);
    expect(host.querySelector('label')?.textContent).toBe(en['name.label']);
    expect(host.querySelector('.hint')?.textContent).toBe(en['name.hint']);
    expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('Amara Eze');
    expect(host.querySelector('.primary')?.textContent.trim()).toBe(en['name.action']);
    expect(host.querySelector('.alert')).toBeNull();
  });

  it('marks the field invalid and points at the problem', () => {
    draw(nameStep(context({ message: en['name.missing'] })));
    const alert = host.querySelector('.alert');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent.trim()).toBe(en['name.missing']);
    const input = host.querySelector('input');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-describedby')).toContain('answer-problem');
  });

  it('says it is saving and holds the controls while it does', () => {
    draw(nameStep(context({ busy: true })));
    expect(host.querySelector('.status')?.getAttribute('role')).toBe('status');
    expect(text()).toContain(en['widget.busy']);
    expect(host.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.primary')?.disabled).toBe(true);
  });

  it('states the one open method instead of offering a choice of one', () => {
    draw(methodStep(context()));
    expect(host.querySelector('.heading')?.textContent).toBe(en['method.only.heading']);
    expect(host.querySelector('.statement-name')?.textContent).toBe(en['method.wallet.name']);
    expect(host.querySelector('.statement-line')?.textContent).toBe(en['method.wallet.line']);
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(host.querySelector('.primary')?.textContent.trim()).toBe(en['method.action']);
  });

  it('offers a radio group once more than one method is open', () => {
    draw(methodStep(context({ methods: withOpen(['wallet', 'bank', 'mobile']) })));
    const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(3);
    expect([...radios].map((radio) => radio.value)).toEqual(['wallet', 'bank', 'mobile']);
    expect([...radios].filter((radio) => radio.checked)).toHaveLength(1);
    expect(host.querySelector('legend')?.textContent).toBe(en['method.heading']);
    expect(text()).toContain(en['method.bank.line']);
  });

  it('gives every choice a line that says what it is', () => {
    draw(methodStep(context({ methods: withOpen(['wallet', 'bank']) })));
    const names = host.querySelectorAll('.choice-name');
    const lines = host.querySelectorAll('.choice-line');
    expect(names).toHaveLength(2);
    expect(lines).toHaveLength(2);
    const described = Array.from(host.querySelectorAll('input[type="radio"]'), (radio) => {
      const id = radio.getAttribute('aria-describedby') ?? '';
      return host.querySelector(`#${id}`)?.textContent;
    });
    expect(described).toEqual([en['method.wallet.line'], en['method.bank.line']]);
  });

  // The theming can change how a chosen method looks, so selection must not
  // rest on colour. It does not: the choice is a native radio, and its
  // checked state is drawn by the browser and read by assistive technology
  // whatever our properties say. The text coloured border is reinforcement
  // on top of that, which is why the coupling is documented rather than
  // given a property of its own.
  it('marks a chosen method with the control state, not with colour alone', () => {
    draw(methodStep(context({ methods: withOpen(['wallet', 'bank']) })));
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
    expect(radios.map((radio) => radio.getAttribute('type'))).toEqual(['radio', 'radio']);
  });

  it('tells a person when no method is open at all', () => {
    draw(methodStep(context({ methods: withOpen([]) })));
    expect(host.querySelector('.alert')?.textContent.trim()).toBe(en['method.missing']);
    expect(host.querySelector('.primary')).toBeNull();
    expect(host.querySelector('.choices')).toBeNull();
  });

  it('reports the chosen method when a choice is made', () => {
    const ctx = context({
      methods: withOpen(['wallet', 'bank']),
      answers: { name: '', method: '', destination: '' },
    });
    draw(methodStep(ctx));
    const bank = host.querySelector<HTMLInputElement>('input[value="bank"]');
    bank?.click();
    expect(ctx.choose).toHaveBeenCalledWith('bank');
  });

  it('asks where the money arrives, in the words of the chosen method', () => {
    draw(destinationStep(context()));
    expect(host.querySelector('.heading')?.textContent).toBe(en['destination.wallet.heading']);
    expect(host.querySelector('label')?.textContent).toBe(en['destination.wallet.label']);
    expect(host.querySelector('.primary')?.textContent.trim()).toBe(
      en['destination.wallet.action'],
    );
    expect(host.querySelector('input')?.hasAttribute('data-code')).toBe(true);
  });

  it('reports what was typed into the destination field', () => {
    const ctx = context();
    draw(destinationStep(ctx));
    const input = host.querySelector<HTMLInputElement>('input');
    if (input) {
      input.value = 'GABC';
      input.dispatchEvent(new Event('input'));
    }
    expect(ctx.change).toHaveBeenCalledWith('GABC');
  });

  it('sends a person back to the method step when nothing is chosen', () => {
    draw(destinationStep(context({ answers: { name: 'Amara Eze', method: '', destination: '' } })));
    expect(host.querySelector('.alert')?.textContent.trim()).toBe(en['method.missing']);
    expect(host.querySelector('input')).toBeNull();
  });

  it('lists every answer with a way to change it', () => {
    const ctx = context();
    draw(reviewStep(ctx));
    const rows = host.querySelectorAll('.answer');
    expect(rows).toHaveLength(3);
    expect(host.querySelector('.answer-value')?.textContent).toBe('Amara Eze');
    expect(text()).toContain(en['method.wallet.name']);
    expect(text()).toContain(WALLET);
    const changes = Array.from(host.querySelectorAll('.text-button'), (button) => [
      button.textContent.trim(),
      button.getAttribute('aria-label'),
    ]);
    // Short on screen, and the whole sentence for a screen reader.
    expect(changes).toEqual([
      ['Change', `Change ${en['step.name.short']}`],
      ['Change', `Change ${en['step.method.short']}`],
      ['Change', `Change ${en['step.destination.short']}`],
    ]);
    host.querySelector<HTMLButtonElement>('.text-button')?.click();
    expect(ctx.goTo).toHaveBeenCalledWith('name');
  });

  it('shows the address as a code, not as prose', () => {
    draw(reviewStep(context()));
    const cells = [...host.querySelectorAll('.answer-value')];
    expect(cells.at(-1)?.hasAttribute('data-code')).toBe(true);
    expect(cells.at(0)?.hasAttribute('data-code')).toBe(false);
  });

  it('closes with what happens next and no action to take', () => {
    draw(doneStep(context()));
    expect(host.querySelector('.heading')?.textContent).toBe(en['done.heading']);
    expect(text()).toContain(en['method.wallet.name']);
    expect(host.querySelector('.primary')).toBeNull();
  });

  it('leaves no placeholder unfilled and one action per step', () => {
    for (const step of STEP_IDS) {
      render(stepView(step, context()), host);
      expect(text()).not.toMatch(/\{\w+\}/);
      expect(host.querySelectorAll('.primary').length).toBeLessThanOrEqual(1);
    }
  });
});
