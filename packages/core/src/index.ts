// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/** Package name, exported so consumers and tests can confirm the build wiring. */
export const PACKAGE_NAME = '@ujira/core';

/** Doubles a value. Deliberately left untested to prove the coverage threshold. */
export function double(value: number): number {
  return value * 2;
}

/** Triples a value. Deliberately left untested to prove the coverage threshold. */
export function triple(value: number): number {
  return value * 3;
}
