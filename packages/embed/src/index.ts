// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The script tag entry point. Loading this file defines <ujira-onboarding>;
// nothing else is needed on the page.

import { registerFocusProperties } from './theme/theme.js';
import { TAG_NAME, UjiraOnboarding } from './onboarding-element.js';

export {
  TAG_NAME,
  UjiraOnboarding,
  COMPLETE_EVENT,
  STEP_CHANGE_EVENT,
} from './onboarding-element.js';
export type { CompleteDetail, StepChangeDetail, WidgetMode } from './onboarding-element.js';
export type { Answers, StepId } from './steps.js';
export type { MethodId } from './methods.js';
export type { OnboardingClient } from './api/client.js';
export type { SignedMessage, WalletConnector } from './wallet.js';
export { LOCALES, type Locale, type MessageKey } from './i18n/catalogue.js';

/** Defines the element once, so two script tags on one page are harmless. */
export function define(): void {
  // Before the element renders: this is what keeps a focus value CSS cannot
  // use, a bad length or a colour token that never resolves, from taking the
  // focus ring with it.
  registerFocusProperties();
  if (customElements.get(TAG_NAME) === undefined) {
    customElements.define(TAG_NAME, UjiraOnboarding);
  }
}

define();

declare global {
  interface HTMLElementTagNameMap {
    [TAG_NAME]: UjiraOnboarding;
  }
}
