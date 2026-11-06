// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The onboarding widget: one custom element, one shadow root, no framework
// needed on the page that hosts it.
//
// The integrator owns the look (custom properties) and the words (locale).
// What happens with the answers is theirs too, in one of two ways:
//   - Handed answers. With no session, the widget asks its questions and
//     hands the answers over in an event, and the page saves them.
//   - Connected. Given an embed token, the widget saves through UJIRA itself:
//     it reads which methods the recipient's corridor pays out, saves the
//     destination, and has the wallet confirm it is the recipient's.
// The widget owns the flow either way: which question comes next, what
// counts as an answer, and what a person sees while an answer is being saved
// or after it failed.

import { html, LitElement, nothing, type CSSResultGroup, type TemplateResult } from 'lit';

import { httpClient, isExpiry, type OnboardingClient } from './api/client.js';
import type { OnboardingSession, ReceivabilityReason, WalletChallenge } from './api/contract.js';
import { DEFAULT_LOCALE, translator, type MessageKey, type Translate } from './i18n/catalogue.js';
import { methodById, PAYOUT_METHODS, type MethodId } from './methods.js';
import { afterProofFailed, afterSaveFailed, receivabilityMessage } from './outcomes.js';
import {
  findProblem,
  firstStep,
  HANDED,
  initialAnswers,
  isQuestionStep,
  nextStep,
  previousStep,
  shortLabel,
  stepCount,
  stepNumber,
  type Answers,
  type Flow,
  type StepId,
} from './steps.js';
import { widgetStyles } from './theme/styles.js';
import type { ThemeMode } from './theme/defaults.generated.js';
import { footer } from './views/footer.js';
import { textButton } from './views/parts.js';
import { stepView, waitingView, type StepContext } from './views/step-views.js';
import type { WalletConnector } from './wallet.js';

export const TAG_NAME = 'ujira-onboarding';

/** Fires whenever the step on screen changes. */
export const STEP_CHANGE_EVENT = 'ujira-step-change';

/**
 * Fires once the last answer is given. With handed answers, cancel it to
 * keep the widget on the review step while the answers are saved, then call
 * finish() or set error. Connected, it fires once UJIRA has saved the method
 * and the wallet has confirmed it, and cannot be cancelled.
 */
export const COMPLETE_EVENT = 'ujira-onboarding-complete';

export interface StepChangeDetail {
  step: StepId;
  /** Position in the progress line, or 0 on the confirmation screen. */
  position: number;
  total: number;
}

export interface CompleteDetail {
  name: string;
  method: MethodId | '';
  destination: string;
  memo: string;
  /** The saved method's id, when the widget saved it through UJIRA. */
  methodId?: string;
}

/** How the widget picks its colours when the integrator sets none. */
export type WidgetMode = ThemeMode | 'system';

// Narrow views of two browser features the widget can do without: a page
// that has neither still renders, it just renders at rest.
interface Animatable {
  animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => unknown;
}

interface MotionAware {
  matchMedia?: (query: string) => { matches: boolean };
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

const LIFT = [
  { opacity: 0, transform: 'translateY(4px)' },
  { opacity: 1, transform: 'translateY(0)' },
];

type Loading = 'idle' | 'loading' | 'failed';

export class UjiraOnboarding extends LitElement {
  static override styles: CSSResultGroup = widgetStyles;

  static override properties = {
    mode: { type: String, reflect: true },
    locale: { type: String, reflect: true },
    busy: { type: Boolean, reflect: true },
    error: { type: String },
    sessionToken: { type: String, attribute: 'session-token' },
    apiBase: { type: String, attribute: 'api-base' },
    client: { attribute: false },
    wallet: { attribute: false },
    step: { state: true },
    answers: { state: true },
    message: { state: true },
    session: { state: true },
    loading: { state: true },
    expired: { state: true },
    working: { state: true },
    challenge: { state: true },
    challengeFailed: { state: true },
    signature: { state: true },
    copied: { state: true },
  };

  /** light, dark, or system to follow the reader's setting. */
  declare mode: WidgetMode;

  /** A language tag. Unknown languages fall back to English. */
  declare locale: string;

  /** Set while the integrator saves an answer: the step waits, and says so. */
  declare busy: boolean;

  /** A message from the integrator, shown in place of our own. */
  declare error: string;

  /** The embed token the integrator's server minted for this recipient. */
  declare sessionToken: string;

  /** Where the UJIRA API is. Needed with a session token. */
  declare apiBase: string;

  /** A client to use instead of one built from the token, such as a test's. */
  declare client: OnboardingClient | undefined;

  /** The page's wallet, if it can sign for the recipient. */
  declare wallet: WalletConnector | undefined;

  declare private step: StepId;
  declare private answers: Answers;
  declare private message: MessageKey | '';
  declare private session: OnboardingSession | undefined;
  declare private loading: Loading;
  declare private expired: boolean;
  declare private working: MessageKey | '';
  declare private challenge: WalletChallenge | undefined;
  declare private challengeFailed: boolean;
  declare private signature: string;
  declare private copied: boolean;

  private problemField: 'answer' | 'memo' = 'answer';
  private methodId = '';
  private activationReason: ReceivabilityReason | undefined;
  private built: { key: string; client: OnboardingClient } | undefined;
  /** Counts session loads, so a stale answer never lands over a newer one. */
  private loads = 0;
  private loadedFrom: OnboardingClient | undefined;

  /** True when the last render came from moving between steps. */
  private moved = false;

  constructor() {
    super();
    this.mode = 'light';
    this.locale = DEFAULT_LOCALE;
    this.busy = false;
    this.error = '';
    this.sessionToken = '';
    this.apiBase = '';
    this.client = undefined;
    this.wallet = undefined;
    this.step = firstStep(HANDED);
    this.answers = initialAnswers(HANDED);
    this.message = '';
    this.session = undefined;
    this.loading = 'idle';
    this.expired = false;
    this.working = '';
    this.challenge = undefined;
    this.challengeFailed = false;
    this.signature = '';
    this.copied = false;
  }

  /** The step on screen. */
  get currentStep(): StepId {
    return this.step;
  }

  /** The answers so far. */
  get currentAnswers(): Answers {
    return { ...this.answers };
  }

  /** Moves to the confirmation screen, for a host that saved the answers itself. */
  finish(): void {
    this.error = '';
    this.goTo('done');
  }

  /** Starts again from the first question with nothing filled in. */
  reset(): void {
    this.answers = initialAnswers(this.flow);
    this.error = '';
    this.methodId = '';
    this.challenge = undefined;
    this.signature = '';
    this.goTo(firstStep(this.flow));
  }

  /** The client in use: the page's own, or one built from the token. */
  private get api(): OnboardingClient | undefined {
    if (this.client !== undefined) return this.client;
    if (this.sessionToken === '' || this.apiBase === '') return undefined;
    const key = `${this.apiBase}\n${this.sessionToken}`;
    if (this.built?.key !== key) {
      this.built = { key, client: httpClient({ baseUrl: this.apiBase, token: this.sessionToken }) };
    }
    return this.built.client;
  }

  private get flow(): Flow {
    const session = this.session;
    if (session === undefined) return HANDED;
    return {
      connected: true,
      methods: PAYOUT_METHODS,
      corridor: session.methods,
      neverPayable: session.neverPayable,
    };
  }

  private get canActivate(): boolean {
    return this.session?.activation.offered === true && this.wallet?.signTransaction !== undefined;
  }

  protected override willUpdate(): void {
    const api = this.api;
    if (api !== undefined && api !== this.loadedFrom) {
      this.loadedFrom = api;
      void this.load(api);
    }
  }

  protected override render(): TemplateResult {
    const t = translator(this.locale);
    const waiting = this.waiting();
    if (waiting !== undefined) {
      return html`<section class="widget" part="widget" aria-label=${t('widget.label')}>
        ${waitingView(t, waiting)} ${footer(t('footer.byline'))}
      </section>`;
    }
    const ctx: StepContext = {
      t,
      answers: this.answers,
      flow: this.flow,
      message: this.alert(t),
      problemField: this.problemField,
      busy: this.busy || this.working !== '',
      ...(this.working === '' ? {} : { busyLabel: t(this.working) }),
      submit: (event: Event) => {
        event.preventDefault();
        void this.onSubmit();
      },
      change: (value: string) => {
        this.onChange(value);
      },
      changeMemo: (value: string) => {
        this.answers = { ...this.answers, memo: value };
        this.message = '';
      },
      choose: (id: MethodId) => {
        this.onChoose(id);
      },
      goTo: (step: StepId) => {
        this.goTo(step);
      },
      proof: {
        challenge: this.challenge,
        failed: this.challengeFailed,
        walletSigns: this.wallet !== undefined,
        signature: this.signature,
        changeSignature: (value: string) => {
          this.signature = value;
          this.message = '';
        },
        copy: () => {
          this.copyMessage();
        },
        copied: this.copied,
        declineActivation: () => {
          this.declineActivation();
        },
      },
    };
    return html`<section class="widget" part="widget" aria-label=${t('widget.label')}>
      ${this.chrome(t)} ${stepView(this.step, ctx)} ${footer(t('footer.byline'))}
    </section>`;
  }

  protected override updated(): void {
    if (!this.moved) return;
    this.moved = false;
    const target = this.renderRoot.querySelector<HTMLElement>('[data-focus]');
    target?.focus();
    const step: Animatable | null = this.renderRoot.querySelector('.step');
    const view: MotionAware | null = this.ownerDocument.defaultView;
    if (view?.matchMedia?.(REDUCED_MOTION).matches === true) return;
    step?.animate?.(LIFT, { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  }

  private waiting():
    { kind: 'loading' } | { kind: 'failed'; retry: () => void } | { kind: 'expired' } | undefined {
    if (this.expired) return { kind: 'expired' };
    if (this.api === undefined || this.session !== undefined) return undefined;
    if (this.loading === 'failed') {
      return {
        kind: 'failed',
        retry: () => {
          const api = this.api;
          if (api !== undefined) void this.load(api);
        },
      };
    }
    return { kind: 'loading' };
  }

  private async load(api: OnboardingClient): Promise<void> {
    this.loads += 1;
    const ticket = this.loads;
    this.loading = 'loading';
    try {
      const session = await api.session();
      if (ticket !== this.loads) return;
      this.session = session;
      this.loading = 'idle';
      this.answers = initialAnswers(this.flow);
      this.goTo(firstStep(this.flow));
    } catch (error) {
      if (ticket !== this.loads) return;
      if (isExpiry(error)) this.expired = true;
      this.loading = 'failed';
    }
  }

  /** The integrator's message wins: they know what their save failed on. */
  private alert(t: Translate): string {
    if (this.error !== '') return this.error;
    return this.message === '' ? '' : t(this.message);
  }

  private show(key: MessageKey, field: 'answer' | 'memo' = 'answer'): void {
    this.message = key;
    this.problemField = field;
  }

  private chrome(t: Translate): TemplateResult | typeof nothing {
    const step = this.step;
    const flow = this.flow;
    if (!isQuestionStep(step, flow)) return nothing;
    const back = previousStep(step, flow);
    const backLabel = back === undefined ? undefined : shortLabel(back);
    return html`<div class="chrome" part="chrome">
      ${
        back === undefined || backLabel === undefined || this.working !== ''
          ? nothing
          : textButton({
              label: t('widget.back'),
              name: t('widget.back.name', { step: t(backLabel) }),
              press: () => {
                this.goTo(back);
              },
            })
      }
      <p class="progress" part="progress" role="status">
        ${t('widget.progress', {
          step: String(stepNumber(step, flow)),
          total: String(stepCount(flow)),
        })}
      </p>
    </div>`;
  }

  private async onSubmit(): Promise<void> {
    if (this.busy || this.working !== '') return;
    const flow = this.flow;
    if (this.step === 'prove') return this.prove();
    if (this.step === 'activate') return this.activate();
    const found = findProblem(this.step, this.answers, flow);
    if (found !== undefined) {
      this.show(found.key, found.field);
      return;
    }
    this.message = '';
    if (this.step !== 'review') {
      this.goTo(nextStep(this.step, flow));
      return;
    }
    if (flow.connected) return this.save();
    const accepted = this.dispatchEvent(
      new CustomEvent<CompleteDetail>(COMPLETE_EVENT, {
        detail: { ...this.answers },
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    if (accepted) this.goTo('done');
  }

  /** Saves the method through UJIRA, then asks the wallet to confirm it. */
  private async save(): Promise<void> {
    const api = this.api;
    const session = this.session;
    const method = methodById(this.answers.method);
    if (api === undefined || session === undefined || method === undefined) return;
    const memo = this.answers.memo.trim();
    this.working = 'widget.busy';
    try {
      const saved = await api.addMethod(session.recipientId, {
        method: method.api,
        destination: {
          network: session.network,
          address: this.answers.destination.trim(),
          ...(memo === '' ? {} : { memo }),
        },
      });
      this.methodId = saved.id;
      this.working = '';
      this.goTo('prove');
      await this.fetchChallenge();
    } catch (error) {
      this.working = '';
      const outcome = afterSaveFailed(error);
      if (outcome.kind === 'expired') {
        this.expired = true;
        return;
      }
      this.goTo(outcome.step);
      this.show(outcome.key, outcome.key === 'destination.memo.unsupported' ? 'memo' : 'answer');
    }
  }

  private async fetchChallenge(): Promise<void> {
    const api = this.api;
    const session = this.session;
    if (api === undefined || session === undefined) return;
    this.challenge = undefined;
    this.challengeFailed = false;
    this.signature = '';
    this.copied = false;
    try {
      this.challenge = await api.createWalletChallenge(session.recipientId, this.methodId);
    } catch (error) {
      if (isExpiry(error)) {
        this.expired = true;
        return;
      }
      this.challengeFailed = true;
      this.show('widget.loadFailed');
    }
  }

  /** Has the wallet sign the challenge, and sends the proof. */
  private async prove(): Promise<void> {
    const api = this.api;
    const session = this.session;
    const challenge = this.challenge;
    if (api === undefined || session === undefined) return;
    if (challenge === undefined) {
      this.message = '';
      await this.fetchChallenge();
      return;
    }
    const address = this.answers.destination.trim();
    let signature = this.signature.trim();
    let signer: string | undefined;
    this.working = 'prove.busy';
    if (this.wallet !== undefined) {
      try {
        const signed = await this.wallet.signMessage(challenge.message, address);
        signature = signed.signature;
        signer = signed.signer;
      } catch {
        this.working = '';
        this.show('prove.declined');
        return;
      }
    } else if (signature === '') {
      this.working = '';
      this.show('prove.signature.missing');
      return;
    }
    try {
      await api.submitWalletProof(session.recipientId, this.methodId, {
        challengeId: challenge.challengeId,
        message: challenge.message,
        nonce: challenge.nonce,
        signature,
        ...(signer === undefined ? {} : { signer }),
      });
      this.working = '';
      this.complete();
    } catch (error) {
      this.working = '';
      const outcome = afterProofFailed(error, this.canActivate);
      if (outcome.kind === 'expired') {
        this.expired = true;
        return;
      }
      if (outcome.kind === 'activate') {
        this.activationReason = outcome.reason;
        this.goTo('activate');
        return;
      }
      // A challenge is good for one try, so the next try gets a new one.
      await this.fetchChallenge();
      this.show(outcome.key);
    }
  }

  /** Has UJIRA pay to activate the wallet, then goes back to proving it. */
  private async activate(): Promise<void> {
    const api = this.api;
    const session = this.session;
    const sign = this.wallet?.signTransaction?.bind(this.wallet);
    if (api === undefined || session === undefined || sign === undefined) return;
    this.working = 'activate.busy';
    try {
      const offer = await api.requestActivation(session.recipientId, this.methodId);
      const signed = await sign(offer.transaction, {
        address: this.answers.destination.trim(),
        networkPassphrase: offer.networkPassphrase,
      });
      await api.submitActivation(offer.activationId, signed);
      this.working = '';
      this.activationReason = undefined;
      this.goTo('prove');
      await this.fetchChallenge();
    } catch (error) {
      this.working = '';
      if (isExpiry(error)) {
        this.expired = true;
        return;
      }
      this.show('activate.failed');
    }
  }

  private declineActivation(): void {
    const reason = this.activationReason;
    this.goTo('prove');
    if (reason !== undefined) this.show(receivabilityMessage(reason));
    void this.fetchChallenge();
  }

  private copyMessage(): void {
    const text = this.challenge?.message;
    const clipboard = this.ownerDocument.defaultView?.navigator.clipboard;
    if (text === undefined || clipboard === undefined) return;
    // A refused copy changes nothing: the message is on screen to select.
    clipboard.writeText(text).then(
      () => {
        this.copied = true;
      },
      () => undefined,
    );
  }

  private complete(): void {
    this.dispatchEvent(
      new CustomEvent<CompleteDetail>(COMPLETE_EVENT, {
        detail: { ...this.answers, methodId: this.methodId },
        bubbles: true,
        composed: true,
        cancelable: false,
      }),
    );
    this.goTo('done');
  }

  private onChange(value: string): void {
    this.answers =
      this.step === 'name'
        ? { ...this.answers, name: value }
        : { ...this.answers, destination: value };
    this.message = '';
  }

  private onChoose(id: MethodId): void {
    this.answers = { ...this.answers, method: id, destination: '', memo: '' };
    this.message = '';
  }

  private goTo(step: StepId): void {
    if (step === this.step) return;
    const flow = this.flow;
    this.step = step;
    this.message = '';
    this.moved = true;
    this.dispatchEvent(
      new CustomEvent<StepChangeDetail>(STEP_CHANGE_EVENT, {
        detail: {
          step,
          position: isQuestionStep(step, flow) ? stepNumber(step, flow) : 0,
          total: stepCount(flow),
        },
        bubbles: true,
        composed: true,
      }),
    );
  }
}
