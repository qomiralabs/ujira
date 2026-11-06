// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One view per step, one question per view. Each view is a plain function of
// the answers so far, so every state can be rendered and read in a test
// without driving the whole widget.

import { html, nothing, type TemplateResult } from 'lit';

import type { Verifier, WalletChallenge } from '../api/contract.js';
import type { MessageKey, Translate } from '../i18n/catalogue.js';
import { methodById, type MethodId, type PayoutMethod } from '../methods.js';
import { offered, type Answers, type Flow, type StepId } from '../steps.js';
import { alertBlock, busyBlock, primaryAction, textButton, textField } from './parts.js';

export const MEMO_ID = 'memo';
export const SIGNATURE_ID = 'signature';

export interface StepContext {
  t: Translate;
  answers: Answers;
  flow: Flow;
  /** The problem on screen, translated. Empty when there is none. */
  message: string;
  /** Which field the problem belongs to. */
  problemField: 'answer' | 'memo';
  busy: boolean;
  /** What the busy line says, when it is not the default. */
  busyLabel?: string;
  submit: (event: Event) => void;
  change: (value: string) => void;
  changeMemo: (value: string) => void;
  choose: (id: MethodId) => void;
  goTo: (step: StepId) => void;
  /** The connected flow's wallet step. */
  proof?: ProofContext;
  /** The identity check, when the chosen method needs one. */
  verification?: VerifyContext;
}

/**
 * The identity check. The person goes to the provider's own page, and the
 * widget only ever learns the status: no document passes through it.
 */
export interface VerifyContext {
  provider: Verifier;
  /** Before it starts, while the person is on the provider's page, or how it ended. */
  state: 'start' | 'waiting' | 'rejected' | 'expired';
  /** The provider's page, once the check is open, so it can be opened again. */
  url: string | undefined;
}

export interface ProofContext {
  /** Undefined while it is being fetched, or when fetching it failed. */
  challenge: WalletChallenge | undefined;
  /** Fetching the message failed; the step offers to try again. */
  failed: boolean;
  /** The page gave the widget a wallet that signs for it. */
  walletSigns: boolean;
  signature: string;
  changeSignature: (value: string) => void;
  copy: () => void;
  copied: boolean;
  /** Turns down free activation, for someone who would rather do it themselves. */
  declineActivation: () => void;
}

function heading(text: string): TemplateResult {
  return html`<h2 class="heading" data-focus tabindex="-1">${text}</h2>`;
}

function busyLine(ctx: StepContext): TemplateResult | typeof nothing {
  return busyBlock(ctx.busyLabel ?? ctx.t('widget.busy'), ctx.busy);
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
    ${primaryAction({ label: t('name.action'), busy: ctx.busy })} ${busyLine(ctx)}
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
 * With one method offered the step states it instead of offering a choice
 * of one, and the action confirms it. With several, it is a radio group.
 */
export function methodStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  const open = offered(ctx.flow);
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
      ${primaryAction({ label: t('method.action'), busy: ctx.busy })} ${busyLine(ctx)}
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
    ${busyLine(ctx)}
  </form>`;
}

export function destinationStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  const method = methodById(ctx.answers.method, ctx.flow.methods);
  if (method === undefined) {
    return html`<form class="step" novalidate @submit=${ctx.submit}>
      ${heading(t('method.heading'))} ${alertBlock(t('method.missing'))}
    </form>`;
  }
  const field = method.destination;
  const problem = ctx.message !== '';
  // Only a wallet address can need a memo; local currency methods never do.
  const memo =
    method.id === 'wallet'
      ? textField({
          id: MEMO_ID,
          label: t('destination.memo.label'),
          hint: t('destination.memo.hint'),
          value: ctx.answers.memo,
          invalid: problem && ctx.problemField === 'memo',
          disabled: ctx.busy,
          code: true,
          inputMode: 'numeric',
          autocomplete: 'off',
          change: ctx.changeMemo,
        })
      : nothing;
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    ${heading(t(field.heading))} ${alertBlock(ctx.message)}
    ${textField({
      label: t(field.label),
      hint: t(field.hint),
      value: ctx.answers.destination,
      invalid: problem && ctx.problemField === 'answer',
      disabled: ctx.busy,
      code: true,
      inputMode: field.inputMode,
      autocomplete: field.autocomplete,
      change: ctx.change,
    })}
    ${memo} ${primaryAction({ label: t(field.action), busy: ctx.busy })} ${busyLine(ctx)}
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
  const method = methodById(ctx.answers.method, ctx.flow.methods);
  const changeTo = (step: StepId, thing: string): TemplateResult =>
    textButton({
      label: t('review.change'),
      name: t('review.change.name', { thing }),
      press: () => {
        ctx.goTo(step);
      },
    });
  const memo = ctx.answers.memo.trim();
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    ${heading(t('review.heading'))}
    <p class="hint">${t('review.hint')}</p>
    ${alertBlock(ctx.message)}
    <ul class="answers">
      ${
        ctx.flow.connected
          ? nothing
          : answerRow(
              t('review.name'),
              ctx.answers.name,
              changeTo('name', t('step.name.short')),
              false,
            )
      }
      ${answerRow(
        t('review.method'),
        method === undefined ? '' : t(method.name),
        changeTo('method', t('step.method.short')),
        false,
      )}
      ${answerRow(
        t('review.destination'),
        ctx.answers.destination.trim(),
        changeTo('destination', t('step.destination.short')),
        true,
      )}
      ${
        memo === ''
          ? nothing
          : answerRow(
              t('review.memo'),
              memo,
              changeTo('destination', t('step.destination.short')),
              true,
            )
      }
    </ul>
    ${primaryAction({ label: t('review.action'), busy: ctx.busy })} ${busyLine(ctx)}
  </form>`;
}

/**
 * The wallet signs a message to show the address is the recipient's. With a
 * wallet from the page that is one press; without, the person signs in
 * their own wallet and pastes the signature back.
 */
export function proveStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  const proof = ctx.proof;
  const challenge = proof?.challenge;
  if (proof === undefined || challenge === undefined) {
    // Fetching the message to sign, or a failed fetch with a way to retry.
    return html`<form class="step" novalidate @submit=${ctx.submit}>
      ${heading(t('prove.heading'))} ${alertBlock(ctx.message)}
      ${
        proof?.failed === true
          ? primaryAction({ label: t('widget.retry'), busy: ctx.busy })
          : busyBlock(t('widget.loading'), true)
      }
    </form>`;
  }
  if (proof.walletSigns) {
    return html`<form class="step" novalidate @submit=${ctx.submit}>
      ${heading(t('prove.heading'))}
      <p class="hint">${t('prove.hint')}</p>
      ${alertBlock(ctx.message)} ${primaryAction({ label: t('prove.action'), busy: ctx.busy })}
      ${busyLine(ctx)}
    </form>`;
  }
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    ${heading(t('prove.heading'))}
    <p class="hint">${t('prove.manual.hint')}</p>
    ${alertBlock(ctx.message)}
    <div class="field">
      <div class="answer-head">
        <span class="label">${t('prove.message.label')}</span>
        ${textButton({
          label: proof.copied ? t('prove.copied') : t('prove.copy'),
          name: t('prove.copy.name'),
          press: proof.copy,
        })}
      </div>
      <pre class="sign-text">${challenge.message}</pre>
    </div>
    ${textField({
      id: SIGNATURE_ID,
      label: t('prove.signature.label'),
      hint: t('prove.signature.hint'),
      value: proof.signature,
      invalid: ctx.message !== '',
      disabled: ctx.busy,
      code: true,
      inputMode: 'text',
      autocomplete: 'off',
      change: proof.changeSignature,
    })}
    ${primaryAction({ label: t('prove.manual.action'), busy: ctx.busy })} ${busyLine(ctx)}
  </form>`;
}

/** Offered first when UJIRA can fix what stops the wallet receiving. */
export function activateStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    ${heading(t('activate.heading'))}
    <p class="hint">${t('activate.hint')}</p>
    ${alertBlock(ctx.message)} ${primaryAction({ label: t('activate.action'), busy: ctx.busy })}
    ${
      ctx.busy
        ? nothing
        : textButton({
            label: t('activate.self'),
            name: t('activate.self.name'),
            press: () => {
              ctx.proof?.declineActivation();
            },
          })
    }
    ${busyLine(ctx)}
  </form>`;
}

export function doneStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  const method = methodById(ctx.answers.method, ctx.flow.methods);
  return html`<div class="step">
    ${heading(t('done.heading'))}
    <p class="hint">${t('done.body', { method: method === undefined ? '' : t(method.name) })}</p>
  </div>`;
}

const START_WORDS: Readonly<Record<Verifier, { hint: MessageKey; action: MessageKey }>> = {
  self: { hint: 'verify.self.hint', action: 'verify.self.action' },
  anchor: { hint: 'verify.anchor.hint', action: 'verify.anchor.action' },
};

const ENDED: Readonly<Record<'rejected' | 'expired', MessageKey>> = {
  rejected: 'verify.rejected',
  expired: 'verify.expired',
};

/**
 * Starts the check, waits for the person to finish it on the provider's
 * page, and says plainly how it ended. The action is always one: start,
 * say you have finished, or start again.
 */
export function verifyStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  const check = ctx.verification;
  if (check === undefined) {
    return html`<div class="step">${heading(t('verify.heading'))}</div>`;
  }
  const words = START_WORDS[check.provider];
  if (check.state === 'waiting') {
    // A link rather than a script, so it opens even where pop-ups are blocked.
    const reopen =
      check.url === undefined
        ? nothing
        : html`<a class="text-button" href=${check.url} target="_blank" rel="noopener noreferrer"
            >${t('verify.reopen')}</a
          >`;
    return html`<form class="step" novalidate @submit=${ctx.submit}>
      ${heading(t('verify.waiting.heading'))}
      <p class="hint">${t('verify.waiting.hint')}</p>
      ${alertBlock(ctx.message)} ${reopen}
      ${primaryAction({ label: t('verify.finished'), busy: ctx.busy })}
      ${busyBlock(ctx.busyLabel ?? t('verify.waiting.status'), true)}
    </form>`;
  }
  const ended = check.state === 'start' ? undefined : ENDED[check.state];
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    ${heading(t('verify.heading'))}
    <p class="hint">${t(words.hint)}</p>
    ${alertBlock(ended === undefined ? ctx.message : t(ended))}
    ${primaryAction({
      label: t(ended === undefined ? words.action : 'verify.retry'),
      busy: ctx.busy,
    })}
    ${busyLine(ctx)}
  </form>`;
}

const VIEWS: Readonly<Record<StepId, (ctx: StepContext) => TemplateResult>> = {
  name: nameStep,
  method: methodStep,
  verify: verifyStep,
  destination: destinationStep,
  review: reviewStep,
  prove: proveStep,
  activate: activateStep,
  done: doneStep,
};

export function stepView(step: StepId, ctx: StepContext): TemplateResult {
  return VIEWS[step](ctx);
}

/** Before the first question: the session is loading, or could not be had. */
export type Waiting =
  { kind: 'loading' } | { kind: 'failed'; retry: () => void } | { kind: 'expired' };

export function waitingView(t: Translate, state: Waiting): TemplateResult {
  if (state.kind === 'loading') {
    return html`<div class="step">${busyBlock(t('widget.loading'), true)}</div>`;
  }
  if (state.kind === 'expired') {
    return html`<div class="step">${alertBlock(t('widget.expired'))}</div>`;
  }
  return html`<form
    class="step"
    novalidate
    @submit=${(event: Event) => {
      event.preventDefault();
      state.retry();
    }}
  >
    ${alertBlock(t('widget.loadFailed'))}
    ${primaryAction({ label: t('widget.retry'), busy: false })}
  </form>`;
}
