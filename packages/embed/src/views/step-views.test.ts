// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { render, type TemplateResult } from 'lit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeAccountAddress } from '../destination.js';
import { en } from '../i18n/en.js';
import { translator } from '../i18n/catalogue.js';
import { PAYOUT_METHODS, type MethodId, type PayoutMethod } from '../methods.js';
import { HANDED, STEP_IDS, type Answers, type Flow } from '../steps.js';
import {
  activateStep,
  destinationStep,
  doneStep,
  MEMO_ID,
  methodStep,
  nameStep,
  proveStep,
  reviewStep,
  SIGNATURE_ID,
  stepView,
  waitingView,
  type ProofContext,
  type StepContext,
} from './step-views.js';

const WALLET = encodeAccountAddress(new Uint8Array(32).fill(7));

const CONNECTED: Flow = {
  connected: true,
  methods: PAYOUT_METHODS,
  corridor: ['stellar_wallet'],
  neverPayable: [],
};

function withOpen(ids: readonly MethodId[]): Flow {
  const methods: readonly PayoutMethod[] = PAYOUT_METHODS.map((method) => ({
    ...method,
    open: ids.includes(method.id),
  }));
  return { ...HANDED, methods };
}

function proof(overrides: Partial<ProofContext> = {}): ProofContext {
  return {
    challenge: {
      challengeId: 'c-1',
      message: 'example.com asks you to confirm your payout address.\nNonce: c-1',
      nonce: 'c-1',
      expiresAt: '2026-11-05T12:05:00.000Z',
    },
    failed: false,
    walletSigns: false,
    signature: '',
    changeSignature: vi.fn(),
    copy: vi.fn(),
    copied: false,
    declineActivation: vi.fn(),
    ...overrides,
  };
}

function context(overrides: Partial<StepContext> = {}): StepContext {
  const answers: Answers = { name: 'Amara Eze', method: 'wallet', destination: WALLET, memo: '' };
  return {
    t: translator('en'),
    answers,
    flow: HANDED,
    message: '',
    problemField: 'answer',
    busy: false,
    submit: vi.fn(),
    change: vi.fn(),
    changeMemo: vi.fn(),
    choose: vi.fn(),
    goTo: vi.fn(),
    proof: proof(),
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
    draw(methodStep(context({ flow: withOpen(['wallet', 'bank', 'mobile']) })));
    const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(3);
    expect([...radios].map((radio) => radio.value)).toEqual(['wallet', 'bank', 'mobile']);
    expect([...radios].filter((radio) => radio.checked)).toHaveLength(1);
    expect(host.querySelector('legend')?.textContent).toBe(en['method.heading']);
    expect(text()).toContain(en['method.bank.line']);
  });

  it('offers only what the corridor pays out', () => {
    const open = withOpen(['wallet', 'mobile']);
    draw(methodStep(context({ flow: { ...open, connected: true, corridor: ['stellar_wallet'] } })));
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(host.querySelector('.statement-name')?.textContent).toBe(en['method.wallet.name']);
    draw(
      methodStep(
        context({
          flow: { ...open, connected: true, corridor: ['stellar_wallet', 'mobile_money'] },
        }),
      ),
    );
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.value)).toEqual(['wallet', 'mobile']);
  });

  it('gives every choice a line that says what it is', () => {
    draw(methodStep(context({ flow: withOpen(['wallet', 'bank']) })));
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
    draw(methodStep(context({ flow: withOpen(['wallet', 'bank']) })));
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
    expect(radios.map((radio) => radio.getAttribute('type'))).toEqual(['radio', 'radio']);
  });

  it('tells a person when no method is open at all', () => {
    draw(methodStep(context({ flow: withOpen([]) })));
    expect(host.querySelector('.alert')?.textContent.trim()).toBe(en['method.missing']);
    expect(host.querySelector('.primary')).toBeNull();
    expect(host.querySelector('.choices')).toBeNull();
  });

  it('reports the chosen method when a choice is made', () => {
    const ctx = context({
      flow: withOpen(['wallet', 'bank']),
      answers: { name: '', method: '', destination: '', memo: '' },
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

  it('offers a memo field for a wallet, labelled as optional', () => {
    draw(destinationStep(context()));
    const memo = host.querySelector<HTMLInputElement>(`#${MEMO_ID}`);
    expect(host.querySelector(`label[for="${MEMO_ID}"]`)?.textContent).toBe(
      en['destination.memo.label'],
    );
    expect(memo?.getAttribute('inputmode')).toBe('numeric');
    expect(memo?.getAttribute('aria-describedby')).toBe(`${MEMO_ID}-hint`);
  });

  it('marks only the field the problem belongs to', () => {
    draw(
      destinationStep(
        context({ message: en['destination.memo.unsupported'], problemField: 'memo' }),
      ),
    );
    expect(host.querySelector('#answer')?.getAttribute('aria-invalid')).toBe('false');
    const memo = host.querySelector(`#${MEMO_ID}`);
    expect(memo?.getAttribute('aria-invalid')).toBe('true');
    expect(memo?.getAttribute('aria-describedby')).toContain('answer-problem');
  });

  it('asks no memo for a local currency method', () => {
    const flow = withOpen(['wallet', 'mobile']);
    draw(
      destinationStep(
        context({ flow, answers: { name: '', method: 'mobile', destination: '', memo: '' } }),
      ),
    );
    expect(host.querySelector(`#${MEMO_ID}`)).toBeNull();
    expect(host.querySelector('.heading')?.textContent).toBe(en['destination.mobile.heading']);
  });

  it('reports what was typed into the destination and memo fields', () => {
    const ctx = context();
    draw(destinationStep(ctx));
    const [address, memo] = host.querySelectorAll<HTMLInputElement>('input');
    if (address !== undefined && memo !== undefined) {
      address.value = 'GABC';
      address.dispatchEvent(new Event('input'));
      memo.value = '42';
      memo.dispatchEvent(new Event('input'));
    }
    expect(ctx.change).toHaveBeenCalledWith('GABC');
    expect(ctx.changeMemo).toHaveBeenCalledWith('42');
  });

  it('sends a person back to the method step when nothing is chosen', () => {
    draw(
      destinationStep(
        context({ answers: { name: 'Amara Eze', method: '', destination: '', memo: '' } }),
      ),
    );
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

  it('adds the memo to the review when there is one, and leaves the name out when connected', () => {
    draw(
      reviewStep(
        context({
          flow: CONNECTED,
          answers: { name: '', method: 'wallet', destination: WALLET, memo: '77' },
        }),
      ),
    );
    const labels = [...host.querySelectorAll('.answer-label')].map((label) => label.textContent);
    expect(labels).toEqual([en['review.method'], en['review.destination'], en['review.memo']]);
    expect(host.querySelectorAll('.answer-value')[2]?.textContent).toBe('77');
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

describe('confirming the wallet', () => {
  it('asks the page wallet to sign with one press', () => {
    draw(proveStep(context({ flow: CONNECTED, proof: proof({ walletSigns: true }) })));
    expect(host.querySelector('.heading')?.textContent).toBe(en['prove.heading']);
    expect(text()).toContain(en['prove.hint']);
    expect(host.querySelector('.primary')?.textContent.trim()).toBe(en['prove.action']);
    expect(host.querySelector(`#${SIGNATURE_ID}`)).toBeNull();
  });

  it('shows the message and takes a pasted signature without a page wallet', () => {
    const ctx = context({ flow: CONNECTED });
    draw(proveStep(ctx));
    expect(host.querySelector('.sign-text')?.textContent).toBe(ctx.proof?.challenge?.message);
    const field = host.querySelector<HTMLInputElement>(`#${SIGNATURE_ID}`);
    expect(host.querySelector(`label[for="${SIGNATURE_ID}"]`)?.textContent).toBe(
      en['prove.signature.label'],
    );
    if (field !== null) {
      field.value = 'c2lnbmVk';
      field.dispatchEvent(new Event('input'));
    }
    expect(ctx.proof?.changeSignature).toHaveBeenCalledWith('c2lnbmVk');
    expect(host.querySelector('.primary')?.textContent.trim()).toBe(en['prove.manual.action']);
  });

  it('copies the message, and says so', () => {
    const ctx = context({ flow: CONNECTED });
    draw(proveStep(ctx));
    const copy = host.querySelector<HTMLButtonElement>('.text-button');
    expect(copy?.textContent.trim()).toBe(en['prove.copy']);
    expect(copy?.getAttribute('aria-label')).toBe(en['prove.copy.name']);
    copy?.click();
    expect(ctx.proof?.copy).toHaveBeenCalled();
    draw(proveStep(context({ flow: CONNECTED, proof: proof({ copied: true }) })));
    expect(host.querySelector('.text-button')?.textContent.trim()).toBe(en['prove.copied']);
  });

  it('waits for the message, and offers to fetch it again when that failed', () => {
    draw(proveStep(context({ flow: CONNECTED, proof: proof({ challenge: undefined }) })));
    expect(text()).toContain(en['widget.loading']);
    expect(host.querySelector('.primary')).toBeNull();
    draw(
      proveStep(
        context({
          flow: CONNECTED,
          message: en['widget.loadFailed'],
          proof: proof({ challenge: undefined, failed: true }),
        }),
      ),
    );
    expect(host.querySelector('.alert')?.textContent.trim()).toBe(en['widget.loadFailed']);
    expect(host.querySelector('.primary')?.textContent.trim()).toBe(en['widget.retry']);
  });

  it('says what it is waiting for while the wallet signs', () => {
    draw(
      proveStep(
        context({
          flow: CONNECTED,
          busy: true,
          busyLabel: en['prove.busy'],
          proof: proof({ walletSigns: true }),
        }),
      ),
    );
    expect(host.querySelector('.status')?.textContent).toContain(en['prove.busy']);
  });

  it('offers free activation first, and a way to do it yourself', () => {
    const ctx = context({ flow: CONNECTED });
    draw(activateStep(ctx));
    expect(host.querySelector('.heading')?.textContent).toBe(en['activate.heading']);
    expect(host.querySelector('.primary')?.textContent.trim()).toBe(en['activate.action']);
    const self = host.querySelector<HTMLButtonElement>('.text-button');
    expect(self?.textContent.trim()).toBe(en['activate.self']);
    self?.click();
    expect(ctx.proof?.declineActivation).toHaveBeenCalled();
    draw(activateStep(context({ flow: CONNECTED, busy: true, busyLabel: en['activate.busy'] })));
    expect(host.querySelector('.text-button')).toBeNull();
    expect(text()).toContain(en['activate.busy']);
  });
});

describe('before the first question', () => {
  const t = translator('en');

  it('says it is getting ready', () => {
    draw(waitingView(t, { kind: 'loading' }));
    expect(host.querySelector('.status')?.textContent).toContain(en['widget.loading']);
  });

  it('offers to try again when UJIRA could not be reached', () => {
    const retry = vi.fn();
    draw(waitingView(t, { kind: 'failed', retry }));
    expect(host.querySelector('.alert')?.textContent.trim()).toBe(en['widget.loadFailed']);
    host.querySelector('form')?.requestSubmit();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('says plainly when the link has expired, with nothing to press', () => {
    draw(waitingView(t, { kind: 'expired' }));
    expect(host.querySelector('.alert')?.textContent.trim()).toBe(en['widget.expired']);
    expect(host.querySelector('.primary')).toBeNull();
  });
});
