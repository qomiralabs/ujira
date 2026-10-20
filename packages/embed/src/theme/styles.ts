// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The widget's own styles. Shadow DOM keeps them off the integrator's page
// and keeps the integrator's page off the widget, so everything that should
// be theirs to change is a custom property.
//
// Built for a 320px screen on a low end phone: one column, 48px controls,
// no shadows, no images, no web font of our own.

import { css, type CSSResultGroup } from 'lit';

import { hostTheme, typeStep } from './theme.js';

const widget = css`
  * {
    box-sizing: border-box;
  }

  .widget {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 16px;
    background: var(--ujira-embed-surface);
    border: 1px solid var(--ujira-embed-rule);
    border-radius: var(--ujira-embed-radius-card);
  }

  @container (min-width: 23rem) {
    .widget {
      padding: 24px;
    }
  }

  :focus-visible {
    outline: var(--ujira-embed-focus-width) solid var(--ujira-embed-focus);
    outline-offset: var(--ujira-embed-focus-offset);
    box-shadow: 0 0 0 var(--ujira-embed-focus-offset) var(--ujira-embed-focus-inner);
  }

  .chrome {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 24px;
  }

  .progress {
    ${typeStep('label')}
    margin: 0;
    color: var(--ujira-embed-text-secondary);
    text-transform: uppercase;
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .heading {
    ${typeStep('title')}
    margin: 0;
    padding: 0;
    color: var(--ujira-embed-text);
  }

  .hint {
    ${typeStep('body-s')}
    margin: 0;
    color: var(--ujira-embed-text-secondary);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .label {
    ${typeStep('body-s')}
    font-weight: 500;
    color: var(--ujira-embed-text);
  }

  .input {
    ${typeStep('body')}
    width: 100%;
    min-height: 48px;
    padding: 12px;
    color: var(--ujira-embed-text);
    background: var(--ujira-embed-surface);
    border: 1px solid var(--ujira-embed-field-border);
    border-radius: var(--ujira-embed-radius-control);
  }

  .input[data-code] {
    font-family: var(--ujira-embed-font-mono);
  }

  .input:disabled {
    opacity: 0.7;
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .choice {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: start;
    gap: 4px 12px;
    min-height: 48px;
    padding: 12px;
    background: var(--ujira-embed-surface);
    border: 1px solid var(--ujira-embed-field-border);
    border-radius: var(--ujira-embed-radius-control);
    cursor: pointer;
  }

  .choice:has(input:checked) {
    border-color: var(--ujira-embed-text);
    box-shadow: inset 0 0 0 1px var(--ujira-embed-text);
  }

  .choice input {
    width: 20px;
    height: 20px;
    margin: 2px 0 0;
    accent-color: var(--ujira-embed-accent);
  }

  .choice-name {
    ${typeStep('body')}
    font-weight: 600;
  }

  .choice-line,
  .statement-line {
    ${typeStep('body-s')}
    grid-column: 2;
    margin: 0;
    color: var(--ujira-embed-text-secondary);
  }

  .statement {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .statement-name {
    ${typeStep('body')}
    margin: 0;
    font-weight: 600;
  }

  .answers {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .answer {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: start;
    column-gap: 12px;
    padding: 12px 0;
    border-top: 1px solid var(--ujira-embed-rule);
  }

  .answer:last-child {
    border-bottom: 1px solid var(--ujira-embed-rule);
  }

  .answer-label {
    ${typeStep('label')}
    grid-column: 1;
    color: var(--ujira-embed-text-secondary);
    text-transform: uppercase;
  }

  .answer-value {
    ${typeStep('body')}
    grid-column: 1;
    margin: 4px 0 0;
    overflow-wrap: anywhere;
  }

  .answer-value[data-code] {
    ${typeStep('data')}
  }

  .answer .text-button {
    grid-column: 2;
    grid-row: 1 / span 2;
  }

  .primary {
    ${typeStep('body')}
    width: 100%;
    min-height: 48px;
    padding: 12px 20px;
    font-weight: 600;
    color: var(--ujira-embed-on-accent);
    background: var(--ujira-embed-accent);
    border: 0;
    border-radius: var(--ujira-embed-radius-control);
    cursor: pointer;
    transition: background-color 160ms var(--ujira-embed-ease);
  }

  .primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ujira-embed-accent) 88%, var(--ujira-embed-text));
  }

  .primary:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .text-button {
    ${typeStep('body-s')}
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0;
    color: var(--ujira-embed-accent-text);
    background: none;
    border: 0;
    cursor: pointer;
    text-align: start;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .alert {
    ${typeStep('body-s')}
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 12px;
    color: var(--ujira-embed-error);
    border: 1px solid var(--ujira-embed-error);
    border-radius: var(--ujira-embed-radius-control);
  }

  .alert svg {
    flex: none;
    width: 20px;
    height: 20px;
  }

  .status {
    ${typeStep('body-s')}
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--ujira-embed-text-secondary);
  }

  .spinner {
    flex: none;
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .footer {
    ${typeStep('body-s')}
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 16px;
    margin: 0;
    color: var(--ujira-embed-text-secondary);
    border-top: 1px solid var(--ujira-embed-rule);
  }

  .footer svg {
    flex: none;
    width: 16px;
    height: 16px;
  }

  @media (prefers-reduced-motion: reduce) {
    .primary {
      transition: none;
    }

    .spinner {
      display: none;
    }
  }
`;

export const widgetStyles: CSSResultGroup = [hostTheme, widget];
