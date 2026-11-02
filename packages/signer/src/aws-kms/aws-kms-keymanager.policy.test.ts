// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The key manager role can encrypt and decrypt and can never sign. This is
// the list of actions the code declares it needs; the deployed policy is
// written from it and should be checked against it once an account exists.

import { describe, expect, it } from 'vitest';

import { KEY_MANAGER_IAM_ACTIONS } from './key-manager.js';

describe('the key manager role', () => {
  it('can encrypt and decrypt and can never sign', () => {
    expect([...KEY_MANAGER_IAM_ACTIONS].sort()).toEqual(['kms:Decrypt', 'kms:Encrypt']);
    expect(KEY_MANAGER_IAM_ACTIONS.some((action) => /sign|\*/i.test(action))).toBe(false);
  });
});
