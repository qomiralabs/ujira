// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One view per step, one question per view. Each view is a plain function of
// the answers so far, so every state can be rendered and read in a test
// without driving the whole widget.

import { html, nothing, type TemplateResult } from 'lit';

import type { Translate } from '../i18n/catalogue.js';
import { methodById, openMethods, type MethodId, type PayoutMethod } from '../methods.js';
import type { Answers, StepId } from '../steps.js';
import { alertBlock, busyBlock, primaryAction, textButton, textField } from './parts.js';

export interface StepContext {
  t: Translate;
  answers: Answers;
  methods: readonly PayoutMethod[];
  /** The problem with the answer on screen, translated. Empty when there is none. */
  message: string;
  busy: boolean;
  submit: (event: Event) => void;
  change: (value: string) => void;
  choose: (id: MethodId) => void;
  goTo: (step: StepId) => void;
}

function heading(text: string): TemplateResult {
  return html`<h2 class="heading" data-focus tabindex="-1">${text}</h2>`;
}

export function nameStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    ${heading(t('name.heading'))} ${alertBlock(ctx.message)}
    ${textField({
      label: t('name.label'),
      hint: t('name.hint'),
      value: ctx.answers.name,
      invalid: ctx.message !== '',
      disabled: ctx.busy,
      code: false,
      inputMode: 'text',
      autocomplete: 'name',
      change: ctx.change,
    })}
    ${primaryAction({ label: t('name.action'), busy: ctx.busy })}
    ${busyBlock(t('widget.busy'), ctx.busy)}
  </form>`;
}

function choice(ctx: StepContext, method: PayoutMethod): TemplateResult {
  const { t } = ctx;
  const lineId = `method-${method.id}-line`;
  return html`<label class="choice">
    <input
      type="radio"
      name="method"
      value=${method.id}
      .checked=${ctx.answers.method === method.id}
      ?disabled=${ctx.busy}
      aria-describedby=${lineId}
      @change=${() => {
        ctx.choose(method.id);
      }}
    />
    <span class="choice-name">${t(method.name)}</span>
    <span class="choice-line" id=${lineId}>${t(method.line)}</span>
  </label>`;
}

/**
 * With one method open the step states it instead of offering a choice of
 * one, and the action confirms it. With several, it is a radio group.
 */
export function methodStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  const open = openMethods(ctx.methods);
  const only = open.length === 1 ? open[0] : undefined;
  if (only !== undefined) {
    return html`<form class="step" novalidate @submit=${ctx.submit}>
      ${heading(t('method.only.heading'))}
      <p class="hint">${t('method.only.hint')}</p>
      ${alertBlock(ctx.message)}
      <div class="statement">
        <p class="statement-name">${t(only.name)}</p>
        <p class="statement-line">${t(only.line)}</p>
      </div>
      ${primaryAction({ label: t('method.action'), busy: ctx.busy })}
      ${busyBlock(t('widget.busy'), ctx.busy)}
    </form>`;
  }
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    <fieldset class="step">
      <legend class="heading" data-focus tabindex="-1">${t('method.heading')}</legend>
      <p class="hint">${t('method.hint')}</p>
      ${alertBlock(open.length === 0 ? t('method.missing') : ctx.message)}
      ${
        open.length === 0
          ? nothing
          : html`<div class="choices">${open.map((method) => choice(ctx, method))}</div>`
      }
    </fieldset>
    ${open.length === 0 ? nothing : primaryAction({ label: t('method.action'), busy: ctx.busy })}
    ${busyBlock(t('widget.busy'), ctx.busy)}
  </form>`;
}

export function destinationStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  const method = methodById(ctx.answers.method, ctx.methods);
  if (method === undefined) {
    return html`<form class="step" novalidate @submit=${ctx.submit}>
      ${heading(t('method.heading'))} ${alertBlock(t('method.missing'))}
    </form>`;
  }
  const field = method.destination;
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    ${heading(t(field.heading))} ${alertBlock(ctx.message)}
    ${textField({
      label: t(field.label),
      hint: t(field.hint),
      value: ctx.answers.destination,
      invalid: ctx.message !== '',
      disabled: ctx.busy,
      code: true,
      inputMode: field.inputMode,
      autocomplete: field.autocomplete,
      change: ctx.change,
    })}
    ${primaryAction({ label: t(field.action), busy: ctx.busy })}
    ${busyBlock(t('widget.busy'), ctx.busy)}
  </form>`;
}

function answerRow(
  label: string,
  value: string,
  change: TemplateResult,
  code: boolean,
): TemplateResult {
  return html`<li class="answer">
    <div class="answer-head">
      <span class="answer-label">${label}</span>
      ${change}
    </div>
    <span class="answer-value" ?data-code=${code}>${value}</span>
  </li>`;
}

export function reviewStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  const method = methodById(ctx.answers.method, ctx.methods);
  const changeTo = (step: StepId, thing: string): TemplateResult =>
    textButton({
      label: t('review.change'),
      name: t('review.change.name', { thing }),
      press: () => {
        ctx.goTo(step);
      },
    });
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    ${heading(t('review.heading'))}
    <p class="hint">${t('review.hint')}</p>
    ${alertBlock(ctx.message)}
    <ul class="answers">
      ${answerRow(
        t('review.name'),
        ctx.answers.name,
        changeTo('name', t('step.name.short')),
        false,
      )}
      ${answerRow(
        t('review.method'),
        method === undefined ? '' : t(method.name),
        changeTo('method', t('step.method.short')),
        false,
      )}
      ${answerRow(
        t('review.destination'),
        ctx.answers.destination,
        changeTo('destination', t('step.destination.short')),
        true,
      )}
    </ul>
    ${primaryAction({ label: t('review.action'), busy: ctx.busy })}
    ${busyBlock(t('widget.busy'), ctx.busy)}
  </form>`;
}

export function doneStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  const method = methodById(ctx.answers.method, ctx.methods);
  return html`<div class="step">
    ${heading(t('done.heading'))}
    <p class="hint">${t('done.body', { method: method === undefined ? '' : t(method.name) })}</p>
  </div>`;
}

const VIEWS: Readonly<Record<StepId, (ctx: StepContext) => TemplateResult>> = {
  name: nameStep,
  method: methodStep,
  destination: destinationStep,
  review: reviewStep,
  done: doneStep,
};

export function stepView(step: StepId, ctx: StepContext): TemplateResult {
  return VIEWS[step](ctx);
}
