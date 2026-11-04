// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { expect, test } from 'vitest';

import {
  ReceiptChainAbortedError,
  ReceiptChainTimeoutError,
  ReceiptError,
  ReceiptInvalidError,
  ReceiptNotCanonicalError,
  ReceiptNotIssuedError,
  ReceiptNotPaidError,
  ReceiptOptionsInvalidError,
  ReceiptPresentationInvalidError,
  ReceiptSignatureInvalidError,
  ReceiptSigningAbortedError,
  ReceiptSigningTimeoutError,
  ReceiptTenantMismatchError,
  ReceiptUnverifiedError,
} from './errors.js';

test('every error class has code and name', () => {
  const errors = [
    [new ReceiptInvalidError(['a (b)']), 'ReceiptInvalidError', 'RECEIPT_INVALID'],
    [
      new ReceiptNotCanonicalError('$.a', 'why'),
      'ReceiptNotCanonicalError',
      'RECEIPT_NOT_CANONICAL',
    ],
    [new ReceiptOptionsInvalidError('x'), 'ReceiptOptionsInvalidError', 'RECEIPT_OPTIONS_INVALID'],
    [
      new ReceiptPresentationInvalidError('x'),
      'ReceiptPresentationInvalidError',
      'RECEIPT_PRESENTATION_INVALID',
    ],
    [
      new ReceiptSignatureInvalidError('x'),
      'ReceiptSignatureInvalidError',
      'RECEIPT_SIGNATURE_INVALID',
    ],
    [new ReceiptSigningAbortedError('x'), 'ReceiptSigningAbortedError', 'RECEIPT_SIGNING_ABORTED'],
    [new ReceiptSigningTimeoutError('x'), 'ReceiptSigningTimeoutError', 'RECEIPT_SIGNING_TIMEOUT'],
    [new ReceiptNotPaidError('x'), 'ReceiptNotPaidError', 'RECEIPT_NOT_PAID'],
    [new ReceiptNotIssuedError('x'), 'ReceiptNotIssuedError', 'RECEIPT_NOT_ISSUED'],
    [new ReceiptTenantMismatchError('x'), 'ReceiptTenantMismatchError', 'RECEIPT_TENANT_MISMATCH'],
    [new ReceiptUnverifiedError('x'), 'ReceiptUnverifiedError', 'RECEIPT_UNVERIFIED'],
    [new ReceiptChainTimeoutError('x'), 'ReceiptChainTimeoutError', 'RECEIPT_CHAIN_TIMEOUT'],
    [new ReceiptChainAbortedError('x'), 'ReceiptChainAbortedError', 'RECEIPT_CHAIN_ABORTED'],
  ] as const;
  for (const [error, name, code] of errors) {
    expect(error).toBeInstanceOf(ReceiptError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
  }
  expect(new Set(errors.map(([, , code]) => code)).size).toBe(errors.length);
});

test('the issues of an invalid receipt are a frozen copy', () => {
  const issues = ['legs (too_small)'];
  const error = new ReceiptInvalidError(issues);
  issues.push('later');
  expect(error.issues).toEqual(['legs (too_small)']);
  expect(Object.isFrozen(error.issues)).toBe(true);
  expect(error.message).toBe('the receipt is not valid');
});
