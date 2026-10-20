// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The onboarding widget: one custom element, one shadow root, no framework
// needed on the page that hosts it.
//
// The integrator owns the look (custom properties), the words (locale) and
// what happens with the answers (events). The widget owns the flow: which
// question comes next, what counts as an answer, and what a person sees while
// an answer is being saved or after it failed.

import { html, LitElement, nothing, type CSSResultGroup, type TemplateResult } from 'lit';

import { DEFAULT_LOCALE, translator, type MessageKey, type Translate } from './i18n/catalogue.js';
import { PAYOUT_METHODS, type MethodId } from './methods.js';
import {
  initialAnswers,
  isQuestionStep,
  nextStep,
  previousStep,
  problem,
  shortLabel,
  stepCount,
  stepNumber,
  type Answers,
  type StepId,
} from './steps.js';
import { widgetStyles } from './theme/styles.js';
import type { ThemeMode } from './theme/defaults.generated.js';
import { footer } from './views/footer.js';
import { textButton } from './views/parts.js';
import { stepView, type StepContext } from './views/step-views.js';

export const TAG_NAME = 'ujira-onboarding';

/** Fires whenever the step on screen changes. */
export const STEP_CHANGE_EVENT = 'ujira-step-change';

/**
 * Fires once the last answer is given. Cancel it to keep the widget on the
 * review step while the answers are saved, then call finish() or set error.
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

export class UjiraOnboarding extends LitElement {
  static override styles: CSSResultGroup = widgetStyles;

  static override properties = {
    mode: { type: String, reflect: true },
    locale: { type: String, reflect: true },
    busy: { type: Boolean, reflect: true },
    error: { type: String },
    step: { state: true },
    answers: { state: true },
    message: { state: true },
  };

  /** light, dark, or system to follow the reader's setting. */
  declare mode: WidgetMode;

  /** A language tag. Unknown languages fall back to English. */
  declare locale: string;

  /** Set while the integrator saves an answer: the step waits, and says so. */
  declare busy: boolean;

  /** A message from the integrator, shown in place of our own. */
  declare error: string;

  declare private step: StepId;

  declare private answers: Answers;

  declare private message: MessageKey | '';

  /** True when the last render came from moving between steps. */
  private moved = false;

  constructor() {
    super();
    this.mode = 'light';
    this.locale = DEFAULT_LOCALE;
    this.busy = false;
    this.error = '';
    this.step = 'name';
    this.answers = initialAnswers(PAYOUT_METHODS);
    this.message = '';
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
    this.answers = initialAnswers(PAYOUT_METHODS);
    this.error = '';
    this.goTo('name');
  }

  protected override render(): TemplateResult {
    const t = translator(this.locale);
    const ctx: StepContext = {
      t,
      answers: this.answers,
      methods: PAYOUT_METHODS,
      message: this.alert(t),
      busy: this.busy,
      submit: (event: Event) => {
        this.onSubmit(event);
      },
      change: (value: string) => {
        this.onChange(value);
      },
      choose: (id: MethodId) => {
        this.onChoose(id);
      },
      goTo: (step: StepId) => {
        this.goTo(step);
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

  /** The integrator's message wins: they know what their save failed on. */
  private alert(t: Translate): string {
    if (this.error !== '') return this.error;
    return this.message === '' ? '' : t(this.message);
  }

  private chrome(t: Translate): TemplateResult | typeof nothing {
    const step = this.step;
    if (!isQuestionStep(step)) return nothing;
    const back = previousStep(step);
    const backLabel = back === undefined ? undefined : shortLabel(back);
    return html`<div class="chrome" part="chrome">
      ${
        back === undefined || backLabel === undefined
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
          step: String(stepNumber(step)),
          total: String(stepCount()),
        })}
      </p>
    </div>`;
  }

  private onSubmit(event: Event): void {
    event.preventDefault();
    if (this.busy) return;
    const found = problem(this.step, this.answers, PAYOUT_METHODS);
    if (found !== undefined) {
      this.message = found;
      return;
    }
    this.message = '';
    if (this.step !== 'review') {
      this.goTo(nextStep(this.step));
      return;
    }
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

  private onChange(value: string): void {
    this.answers =
      this.step === 'name'
        ? { ...this.answers, name: value }
        : { ...this.answers, destination: value };
    this.message = '';
  }

  private onChoose(id: MethodId): void {
    this.answers = { ...this.answers, method: id, destination: '' };
    this.message = '';
  }

  private goTo(step: StepId): void {
    if (step === this.step) return;
    this.step = step;
    this.message = '';
    this.moved = true;
    this.dispatchEvent(
      new CustomEvent<StepChangeDetail>(STEP_CHANGE_EVENT, {
        detail: {
          step,
          position: isQuestionStep(step) ? stepNumber(step) : 0,
          total: stepCount(),
        },
        bubbles: true,
        composed: true,
      }),
    );
  }
}
