// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Lookups over the generated mandate error table. The table itself is
// generated from the vendored spec, so this file only reads it.

import { MANDATE_ERRORS, MANDATE_ERROR_NAMES_BY_CODE } from './mandate-errors.generated.js';
import type { MandateErrorName } from './mandate-errors.generated.js';

export { MANDATE_ERRORS, MANDATE_ERROR_NAMES_BY_CODE };
export type { MandateErrorName };

/** Every spec error name, in the order the spec lists them. */
export const MANDATE_ERROR_NAMES: readonly MandateErrorName[] = Object.freeze(
  Object.keys(MANDATE_ERRORS) as MandateErrorName[],
);

/** The spec name of a code, or undefined for a code the vendored table does not hold. */
export function mandateErrorName(code: number): MandateErrorName | undefined {
  return Number.isSafeInteger(code) && Object.hasOwn(MANDATE_ERROR_NAMES_BY_CODE, code)
    ? MANDATE_ERROR_NAMES_BY_CODE[code]
    : undefined;
}

export function isMandateErrorName(name: unknown): name is MandateErrorName {
  return typeof name === 'string' && Object.hasOwn(MANDATE_ERRORS, name);
}
