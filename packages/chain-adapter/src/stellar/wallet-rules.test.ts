// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The passkey wallet rules, CHAINOPS-CREATE-002, 006 and 007. Each refusal has a
 * wallet that breaks it and one that passes. Counts are over a rule's own
 * signers, and a change is judged on the wallet as it would be afterwards.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  REVIEWED_WALLET_CODE,
  WALLET_REFUSALS,
  checkSingleKey,
  checkWalletChange,
  checkWalletTrust,
  fewestSignatures,
  guardWalletChange,
  guardWalletForMandate,
} from './wallet-rules.js';
import type {
  WalletDecision,
  WalletMandate,
  WalletPolicy,
  WalletRule,
  WalletSigner,
  WalletSnapshot,
} from './wallet-rules.js';

const OPTS = { correlationId: 'wallet-rules-test' };
const WALLET = 'CWALLET';
const MANDATE = 'CMANDATE';
const VERIFIER = 'CVERIFIER';
const POLICY_CONTRACT = 'CPOLICY';
const OPERATOR = 'GOPERATOR';
const POLICY: WalletPolicy = {
  operatorAddresses: new Set([OPERATOR]),
  reviewed: REVIEWED_WALLET_CODE,
};

function signer(id: string): WalletSigner {
  return { id, address: null, verifier: VERIFIER };
}

function rule(
  id: number,
  context: WalletRule['context'],
  signers: readonly string[],
  threshold: number,
  weights: Readonly<Record<string, number>> = Object.fromEntries(signers.map((s) => [s, 1])),
): WalletRule {
  return {
    id,
    context,
    validUntil: null,
    signers: signers.map(signer),
    policies: [POLICY_CONTRACT],
    threshold,
    weights,
  };
}

const DEFAULT: WalletRule['context'] = { kind: 'default' };
const ON_MANDATE: WalletRule['context'] = { kind: 'call_contract', contract: MANDATE };

function wallet(rules: readonly WalletRule[]): WalletSnapshot {
  return {
    wallet: WALLET,
    codeHash: REVIEWED_WALLET_CODE.wallet,
    upgradeAuthority: null,
    rules: [...rules],
    contractHashes: {
      [VERIFIER]: REVIEWED_WALLET_CODE.verifiers[0] ?? '',
      [POLICY_CONTRACT]: REVIEWED_WALLET_CODE.policies[0] ?? '',
    },
  };
}

const TWO_OF_THREE = wallet([rule(0, DEFAULT, ['a', 'b', 'c'], 2)]);
const WITH_MANDATE_RULE = wallet([
  rule(0, DEFAULT, ['a', 'b', 'c'], 2),
  rule(1, ON_MANDATE, ['a', 'b', 'c'], 2),
]);
const LARGE: readonly WalletMandate[] = [{ contract: MANDATE, needsMultisig: true }];

function without<T extends object>(value: T, key: string): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as Partial<T>;
}

const reasonOf = (decision: WalletDecision) => (decision.allowed ? 'allowed' : decision.reason);

describe('fewestSignatures', () => {
  it('counts the heaviest signers first', () => {
    expect(fewestSignatures(rule(0, DEFAULT, ['a', 'b', 'c'], 3, { a: 1, b: 3, c: 1 }))).toBe(1);
    expect(fewestSignatures(rule(0, DEFAULT, ['a', 'b', 'c'], 4, { a: 1, b: 3, c: 1 }))).toBe(2);
  });

  it("ignores the weight of an address that is not one of the rule's signers", () => {
    expect(fewestSignatures(rule(0, DEFAULT, ['a'], 2, { a: 1, gone: 5 }))).toBeNull();
  });

  it('gives a signer with no weight nothing', () => {
    expect(fewestSignatures(rule(0, DEFAULT, ['a', 'b'], 2, { a: 1 }))).toBeNull();
  });

  it('is the true minimum, checked against every subset', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 0, maxLength: 7 }),
        fc.integer({ min: 1, max: 12 }),
        (weights, threshold) => {
          const names = weights.map((_, index) => `s${String(index)}`);
          const table = Object.fromEntries(names.map((name, index) => [name, weights[index] ?? 0]));
          let best: number | null = null;
          for (let mask = 0; mask < 1 << weights.length; mask += 1) {
            let total = 0;
            let count = 0;
            weights.forEach((weight, index) => {
              if ((mask & (1 << index)) !== 0) {
                total += weight;
                count += 1;
              }
            });
            if (total >= threshold && (best === null || count < best)) best = count;
          }
          expect(fewestSignatures(rule(0, DEFAULT, names, threshold, table))).toBe(best);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('a large mandate needs more than one key', () => {
  it('passes two of three, before and after the mandate rule exists', () => {
    expect(checkSingleKey(TWO_OF_THREE, MANDATE)).toBeNull();
    expect(checkSingleKey(WITH_MANDATE_RULE, MANDATE)).toBeNull();
  });

  it('refuses when one signer can meet the Default rule', () => {
    const weak = wallet([rule(0, DEFAULT, ['a', 'b'], 2, { a: 2, b: 1 })]);
    expect(checkSingleKey(weak, MANDATE)).toBe('SINGLE_KEY');
  });

  it('refuses when one signer can meet the mandate rule, since the weaker rule decides', () => {
    const weak = wallet([
      rule(0, DEFAULT, ['a', 'b', 'c'], 2),
      rule(1, ON_MANDATE, ['a', 'b'], 2, { a: 2, b: 1 }),
    ]);
    expect(checkSingleKey(weak, MANDATE)).toBe('SINGLE_KEY');
  });

  it('does not count a weight the policy keeps for someone who left the rule', () => {
    const left = wallet([rule(0, DEFAULT, ['a', 'b'], 2, { a: 1, b: 1, gone: 2 })]);
    expect(checkSingleKey(left, MANDATE)).toBeNull();
  });

  it('refuses a wallet with no Default rule', () => {
    expect(checkSingleKey(wallet([rule(1, ON_MANDATE, ['a', 'b'], 2)]), MANDATE)).toBe(
      'NO_DEFAULT_RULE',
    );
  });
});

describe('the operator cannot sign for, change or upgrade a wallet', () => {
  const trust = (change: Partial<WalletSnapshot>) =>
    checkWalletTrust({ ...TWO_OF_THREE, ...change }, POLICY);

  it('passes a wallet running only reviewed code, with no operator in it', () => {
    expect(trust({})).toBeNull();
  });

  it('refuses a wallet that is not the reviewed code', () => {
    expect(trust({ codeHash: 'ab'.repeat(32) })).toBe('CODE_NOT_REVIEWED');
  });

  it('refuses a verifier that is not reviewed, or that the read did not bring back', () => {
    const other = { ...TWO_OF_THREE.contractHashes, [VERIFIER]: 'ab'.repeat(32) };
    expect(trust({ contractHashes: other })).toBe('CODE_NOT_REVIEWED');
    const missing = without(TWO_OF_THREE.contractHashes, VERIFIER) as Record<string, string>;
    expect(trust({ contractHashes: missing })).toBe('CODE_NOT_REVIEWED');
  });

  it('refuses a policy that is not reviewed, or that the read did not bring back', () => {
    const other = { ...TWO_OF_THREE.contractHashes, [POLICY_CONTRACT]: 'ab'.repeat(32) };
    expect(trust({ contractHashes: other })).toBe('CODE_NOT_REVIEWED');
    const missing = without(TWO_OF_THREE.contractHashes, POLICY_CONTRACT) as Record<string, string>;
    expect(trust({ contractHashes: missing })).toBe('CODE_NOT_REVIEWED');
  });

  it('refuses the operator as upgrade authority', () => {
    expect(trust({ upgradeAuthority: OPERATOR })).toBe('OPERATOR_CONTROLLED');
    expect(trust({ upgradeAuthority: 'GSOMEONE' })).toBeNull();
  });

  it('refuses the operator as a delegated signer, a verifier or a policy', () => {
    const base = TWO_OF_THREE.rules[0];
    if (base === undefined) throw new Error('no rule');
    const delegated: WalletSigner = { id: 'op', address: OPERATOR, verifier: null };
    expect(trust({ rules: [{ ...base, signers: [delegated] }] })).toBe('OPERATOR_CONTROLLED');
    const verifier: WalletSigner = { id: 'op', address: null, verifier: OPERATOR };
    expect(trust({ rules: [{ ...base, signers: [verifier] }] })).toBe('OPERATOR_CONTROLLED');
    expect(trust({ rules: [{ ...base, policies: [OPERATOR] }] })).toBe('OPERATOR_CONTROLLED');
    const other: WalletSigner = { id: 'g', address: 'GSOMEONE', verifier: null };
    expect(trust({ rules: [{ ...base, signers: [other] }] })).toBeNull();
  });
});

describe('a relayed change keeps every rule reachable', () => {
  const change = (
    before: WalletSnapshot,
    ops: Parameters<typeof checkWalletChange>[1],
    mandates: readonly WalletMandate[] = [],
  ) => reasonOf(checkWalletChange(before, ops, mandates, POLICY));

  it('refuses a change naming a rule the wallet does not have', () => {
    expect(change(TWO_OF_THREE, [{ op: 'set_threshold', ruleId: 9, threshold: 1 }])).toBe(
      'UNKNOWN_RULE',
    );
  });

  it('refuses removing signers until the threshold is above their total weight', () => {
    const ops = [
      { op: 'remove_signer', ruleId: 0, signerId: 'b' },
      { op: 'remove_signer', ruleId: 0, signerId: 'c' },
    ] as const;
    expect(change(TWO_OF_THREE, ops)).toBe('RULE_UNREACHABLE');
    expect(change(TWO_OF_THREE, [{ op: 'remove_signer', ruleId: 0, signerId: 'c' }])).toBe(
      'allowed',
    );
  });

  it('refuses a threshold above the total weight', () => {
    expect(change(TWO_OF_THREE, [{ op: 'set_threshold', ruleId: 0, threshold: 4 }])).toBe(
      'RULE_UNREACHABLE',
    );
    expect(change(TWO_OF_THREE, [{ op: 'set_threshold', ruleId: 0, threshold: 3 }])).toBe(
      'allowed',
    );
  });

  it('counts a new signer only once the policy gives it a weight, judged as one transaction', () => {
    const add = { op: 'add_signer', ruleId: 0, signer: signer('d') } as const;
    const raise = { op: 'set_threshold', ruleId: 0, threshold: 4 } as const;
    expect(change(TWO_OF_THREE, [add, raise])).toBe('RULE_UNREACHABLE');
    const weigh = { op: 'set_weight', ruleId: 0, signerId: 'd', weight: 1 } as const;
    expect(change(TWO_OF_THREE, [add, weigh, raise])).toBe('allowed');
  });

  it('does not refuse a change for a broken rule it does not touch', () => {
    const broken = wallet([
      rule(0, DEFAULT, ['a', 'b', 'c'], 2),
      rule(2, { kind: 'create_contract' }, ['a'], 5),
    ]);
    expect(change(broken, [{ op: 'set_threshold', ruleId: 0, threshold: 3 }])).toBe('allowed');
  });

  it('refuses leaving no lasting rule that can administer the wallet', () => {
    expect(change(TWO_OF_THREE, [{ op: 'remove_rule', ruleId: 0 }])).toBe('NO_ADMIN_RULE');
    expect(change(TWO_OF_THREE, [{ op: 'set_valid_until', ruleId: 0, validUntil: 100 }])).toBe(
      'NO_ADMIN_RULE',
    );
  });

  it('accepts a rule on the wallet itself as the lasting admin, but still needs a Default rule', () => {
    const self = rule(3, { kind: 'call_contract', contract: WALLET }, ['a', 'b'], 2);
    const both = wallet([rule(0, DEFAULT, ['a', 'b', 'c'], 2), self]);
    expect(change(both, [{ op: 'set_valid_until', ruleId: 0, validUntil: 100 }])).toBe('allowed');
    expect(change(both, [{ op: 'remove_rule', ruleId: 0 }])).toBe('NO_DEFAULT_RULE');
  });

  it('refuses a mandate rule easier than the Default rule, on install and on any later change', () => {
    const easier = rule(1, ON_MANDATE, ['a', 'b'], 1);
    expect(change(TWO_OF_THREE, [{ op: 'add_rule', rule: easier }])).toBe('MANDATE_RULE_EASIER');
    const same = rule(1, ON_MANDATE, ['a', 'b'], 2);
    expect(change(TWO_OF_THREE, [{ op: 'add_rule', rule: same }])).toBe('allowed');
    expect(change(WITH_MANDATE_RULE, [{ op: 'set_threshold', ruleId: 1, threshold: 1 }])).toBe(
      'MANDATE_RULE_EASIER',
    );
    expect(change(WITH_MANDATE_RULE, [{ op: 'set_threshold', ruleId: 0, threshold: 3 }])).toBe(
      'MANDATE_RULE_EASIER',
    );
  });

  it('compares signatures, not raw thresholds', () => {
    // A threshold of 5 met by one signer of weight 5 is one signature.
    const heavy = rule(1, ON_MANDATE, ['a', 'b'], 5, { a: 5, b: 1 });
    expect(change(TWO_OF_THREE, [{ op: 'add_rule', rule: heavy }])).toBe('MANDATE_RULE_EASIER');
  });

  it('refuses a change that would break the large mandate rule, and only for a large mandate', () => {
    const weaken = { op: 'set_threshold', ruleId: 0, threshold: 1 } as const;
    expect(change(TWO_OF_THREE, [weaken], LARGE)).toBe('SINGLE_KEY');
    expect(change(TWO_OF_THREE, [weaken], [{ contract: MANDATE, needsMultisig: false }])).toBe(
      'allowed',
    );
  });

  it('refuses a change that brings in the operator or unreviewed code', () => {
    const operator: WalletSigner = { id: 'op', address: OPERATOR, verifier: null };
    expect(change(TWO_OF_THREE, [{ op: 'add_signer', ruleId: 0, signer: operator }])).toBe(
      'OPERATOR_CONTROLLED',
    );
    const other: WalletSigner = { id: 'x', address: null, verifier: 'COTHER' };
    expect(change(TWO_OF_THREE, [{ op: 'add_signer', ruleId: 0, signer: other }])).toBe(
      'CODE_NOT_REVIEWED',
    );
  });

  it('returns the wallet as it would be, and leaves the one it was given alone', () => {
    const decision = checkWalletChange(
      TWO_OF_THREE,
      [{ op: 'set_threshold', ruleId: 0, threshold: 3 }],
      [],
      POLICY,
    );
    if (!decision.allowed) throw new Error(decision.reason);
    expect(decision.wallet.rules[0]?.threshold).toBe(3);
    expect(TWO_OF_THREE.rules[0]?.threshold).toBe(2);
  });
});

describe('a wallet that cannot be read', () => {
  const noOps = [{ op: 'set_threshold', ruleId: 0, threshold: 3 }] as const;
  const partial = without(TWO_OF_THREE, 'contractHashes');
  const failing: readonly (readonly [string, unknown])[] = [
    ['an incomplete answer', partial],
    [
      'a rule with no threshold',
      { ...TWO_OF_THREE, rules: [{ ...TWO_OF_THREE.rules[0], threshold: undefined }] },
    ],
    ['a code hash that is no hash', { ...TWO_OF_THREE, codeHash: 'nope' }],
    ['an answer about another wallet', { ...TWO_OF_THREE, wallet: 'COTHER' }],
    ['no answer at all', null],
  ];

  it.each(failing)('refuses a change on %s', async (_label, answer) => {
    const reader = { read: () => Promise.resolve(answer) };
    const decision = await guardWalletChange(reader, WALLET, noOps, [], POLICY, OPTS);
    expect(reasonOf(decision)).toBe('READ_FAILED');
  });

  it('refuses a change when the read fails', async () => {
    const reader = { read: () => Promise.reject(new Error('rpc down')) };
    const decision = await guardWalletChange(reader, WALLET, noOps, [], POLICY, OPTS);
    expect(reasonOf(decision)).toBe('READ_FAILED');
  });

  it('refuses a mandate when the read fails', async () => {
    const reader = { read: () => Promise.reject(new Error('rpc down')) };
    const mandate = { contract: MANDATE, needsMultisig: false };
    const decision = await guardWalletForMandate(reader, WALLET, mandate, POLICY, OPTS);
    expect(reasonOf(decision)).toBe('READ_FAILED');
  });

  it('judges a change on what it read', async () => {
    const reader = { read: () => Promise.resolve(TWO_OF_THREE) };
    const decision = await guardWalletChange(reader, WALLET, noOps, [], POLICY, OPTS);
    expect(reasonOf(decision)).toBe('allowed');
  });
});

describe('a wallet as the principal of a mandate', () => {
  const guard = (answer: WalletSnapshot, mandate: WalletMandate) =>
    guardWalletForMandate({ read: () => Promise.resolve(answer) }, WALLET, mandate, POLICY, OPTS);
  const weak = wallet([rule(0, DEFAULT, ['a', 'b'], 1)]);

  it('passes a small mandate on one key, and refuses a large one', async () => {
    expect(reasonOf(await guard(weak, { contract: MANDATE, needsMultisig: false }))).toBe(
      'allowed',
    );
    expect(reasonOf(await guard(weak, { contract: MANDATE, needsMultisig: true }))).toBe(
      'SINGLE_KEY',
    );
  });

  it('passes a large mandate on two of three', async () => {
    expect(reasonOf(await guard(TWO_OF_THREE, { contract: MANDATE, needsMultisig: true }))).toBe(
      'allowed',
    );
  });

  it('refuses unreviewed code, whatever the size', async () => {
    const other = { ...TWO_OF_THREE, codeHash: 'ab'.repeat(32) };
    expect(reasonOf(await guard(other, { contract: MANDATE, needsMultisig: false }))).toBe(
      'CODE_NOT_REVIEWED',
    );
  });
});

describe('the reasons', () => {
  it('are the ones callers can be told about', () => {
    expect([...WALLET_REFUSALS].sort()).toEqual([
      'CODE_NOT_REVIEWED',
      'MANDATE_RULE_EASIER',
      'NO_ADMIN_RULE',
      'NO_DEFAULT_RULE',
      'OPERATOR_CONTROLLED',
      'READ_FAILED',
      'RULE_UNREACHABLE',
      'SINGLE_KEY',
      'UNKNOWN_RULE',
    ]);
  });
});
