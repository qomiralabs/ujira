// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The rules for a principal's passkey wallet, which the mandate cannot see and
// so only the operator can hold. An OpenZeppelin smart account keeps a rule's
// signers apart from its policy's threshold and weights, and changing one never
// changes the other: a signer added to a rule counts only once the policy gives
// it a weight, a removed signer's weight stays in the policy, and a threshold
// does not fall when signers leave. So every count here is over a rule's own
// signers, and every check is on the wallet as it would be after the change.
//
// The checks are pure, over a snapshot a reader supplies, and a read that fails
// or comes back incomplete refuses, because a wallet that cannot be read cannot
// be shown to be safe.

import { z } from 'zod';

import type { CallOptions } from '../types.js';

/** The contracts a passkey wallet may run, as reviewed at OpenZeppelin v0.8.0. */
export const REVIEWED_WALLET_CODE = Object.freeze({
  wallet: '6f1a3a524e75da519db0e815115101addd9bae529a45603aa4c3d1a2274d7de2',
  verifiers: ['82ac47ab4f139fc07f9524e1c8b26547a21d686384c46ec89cac2284abba65ef'],
  policies: ['61af5ce32e207ced16163a6fbbb063ca10241c73450402bc4ed9c07f743e430a'],
});

const signerSchema = z.strictObject({
  /** Stable across reads: the delegated address, or the verifier and key data. */
  id: z.string().min(1).max(512),
  /** The address a delegated signer names. */
  address: z.string().min(1).nullable(),
  /** The verifier contract an external signer names. */
  verifier: z.string().min(1).nullable(),
});

const ruleSchema = z.strictObject({
  id: z.int().min(0),
  context: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('default') }),
    z.strictObject({ kind: z.literal('call_contract'), contract: z.string().min(1) }),
    z.strictObject({ kind: z.literal('create_contract') }),
  ]),
  /** The ledger the rule stops at, or null when it never does. */
  validUntil: z.int().min(0).nullable(),
  signers: z.array(signerSchema),
  policies: z.array(z.string().min(1)),
  threshold: z.int().min(1),
  /** By signer id. Can name addresses that are no longer signers of the rule. */
  weights: z.record(z.string(), z.int().min(0)),
});

const HASH = z.string().regex(/^[0-9a-f]{64}$/);

const snapshotSchema = z.strictObject({
  wallet: z.string().min(1),
  codeHash: HASH,
  /** Who may upgrade the wallet, when anyone other than its own rules can. */
  upgradeAuthority: z.string().min(1).nullable(),
  rules: z.array(ruleSchema),
  /** By contract address, for every verifier and policy a rule names. */
  contractHashes: z.record(z.string(), HASH),
});

export type WalletSigner = z.output<typeof signerSchema>;
export type WalletRule = z.output<typeof ruleSchema>;
export type WalletSnapshot = z.output<typeof snapshotSchema>;

export interface WalletReader {
  /** Reads the wallet as it stands; the caller's deadline is in `opts`. */
  read(wallet: string, opts: CallOptions): Promise<unknown>;
}

/** One step of a change relayed as a single transaction. */
export type WalletOp =
  | { readonly op: 'add_rule'; readonly rule: WalletRule }
  | { readonly op: 'remove_rule'; readonly ruleId: number }
  | { readonly op: 'set_valid_until'; readonly ruleId: number; readonly validUntil: number | null }
  | { readonly op: 'add_signer'; readonly ruleId: number; readonly signer: WalletSigner }
  | { readonly op: 'remove_signer'; readonly ruleId: number; readonly signerId: string }
  | {
      readonly op: 'set_weight';
      readonly ruleId: number;
      readonly signerId: string;
      readonly weight: number;
    }
  | { readonly op: 'set_threshold'; readonly ruleId: number; readonly threshold: number };

export const WALLET_REFUSALS = Object.freeze([
  'READ_FAILED',
  'CODE_NOT_REVIEWED',
  'OPERATOR_CONTROLLED',
  'UNKNOWN_RULE',
  'NO_DEFAULT_RULE',
  'RULE_UNREACHABLE',
  'NO_ADMIN_RULE',
  'MANDATE_RULE_EASIER',
  'SINGLE_KEY',
] as const);
export type WalletRefusal = (typeof WALLET_REFUSALS)[number];

export type WalletDecision =
  | { readonly allowed: true; readonly wallet: WalletSnapshot }
  | { readonly allowed: false; readonly reason: WalletRefusal };

/** What the operator holds and what it reviewed. */
export interface WalletPolicy {
  /** Every key and contract of the operator's. None may control a wallet. */
  readonly operatorAddresses: ReadonlySet<string>;
  readonly reviewed: {
    readonly wallet: string;
    readonly verifiers: readonly string[];
    readonly policies: readonly string[];
  };
}

/** A mandate this wallet is principal of. */
export interface WalletMandate {
  readonly contract: string;
  /** Its total budget is over the line, with no recovery set to carry it. */
  readonly needsMultisig: boolean;
}

function refuse(reason: WalletRefusal): WalletDecision {
  return { allowed: false, reason };
}

/** The weights of a rule's own signers, heaviest first. */
function ownWeights(rule: WalletRule): number[] {
  return rule.signers.map((signer) => rule.weights[signer.id] ?? 0).sort((a, b) => b - a);
}

/**
 * The fewest of a rule's own signers whose weights reach its threshold, or null
 * when even all of them cannot, which leaves the rule unusable.
 */
export function fewestSignatures(rule: WalletRule): number | null {
  let total = 0;
  let count = 0;
  for (const weight of ownWeights(rule)) {
    total += weight;
    count += 1;
    if (total >= rule.threshold) return count;
  }
  return null;
}

const isDefault = (rule: WalletRule) => rule.context.kind === 'default';

function mandateRuleOf(wallet: WalletSnapshot, contract: string): WalletRule | undefined {
  return wallet.rules.find(
    (rule) => rule.context.kind === 'call_contract' && rule.context.contract === contract,
  );
}

/** Can authorize the wallet's own administration, and never stops being able to. */
function isLastingAdmin(wallet: WalletSnapshot, rule: WalletRule): boolean {
  const covers =
    isDefault(rule) ||
    (rule.context.kind === 'call_contract' && rule.context.contract === wallet.wallet);
  return covers && rule.validUntil === null && fewestSignatures(rule) !== null;
}

/** No signer can meet the rule alone. An unusable rule cannot be met by anyone at all. */
const needsTwo = (rule: WalletRule) => (fewestSignatures(rule) ?? 2) >= 2;

/**
 * The large mandate rule: a call on the mandate can be authorized under either
 * the Default rule or its own rule, so the weaker one decides.
 */
export function checkSingleKey(wallet: WalletSnapshot, contract: string): WalletRefusal | null {
  const admin = wallet.rules.find(isDefault);
  if (admin === undefined) return 'NO_DEFAULT_RULE';
  const own = mandateRuleOf(wallet, contract);
  return needsTwo(admin) && (own === undefined || needsTwo(own)) ? null : 'SINGLE_KEY';
}

/** The code the wallet runs and who controls it. */
export function checkWalletTrust(
  wallet: WalletSnapshot,
  policy: WalletPolicy,
): WalletRefusal | null {
  const { reviewed, operatorAddresses: operator } = policy;
  if (wallet.codeHash !== reviewed.wallet) return 'CODE_NOT_REVIEWED';
  if (wallet.upgradeAuthority !== null && operator.has(wallet.upgradeAuthority)) {
    return 'OPERATOR_CONTROLLED';
  }
  for (const rule of wallet.rules) {
    for (const signer of rule.signers) {
      if (signer.address !== null && operator.has(signer.address)) return 'OPERATOR_CONTROLLED';
      if (signer.verifier !== null) {
        if (operator.has(signer.verifier)) return 'OPERATOR_CONTROLLED';
        const hash = wallet.contractHashes[signer.verifier];
        // A hash the read did not bring back is a partial read, so it fails here too.
        if (hash === undefined || !reviewed.verifiers.includes(hash)) return 'CODE_NOT_REVIEWED';
      }
    }
    for (const contract of rule.policies) {
      if (operator.has(contract)) return 'OPERATOR_CONTROLLED';
      const hash = wallet.contractHashes[contract];
      if (hash === undefined || !reviewed.policies.includes(hash)) return 'CODE_NOT_REVIEWED';
    }
  }
  return null;
}

/** The wallet after `ops`, with the rules they touch, or null for a rule it does not have. */
function applyOps(
  wallet: WalletSnapshot,
  ops: readonly WalletOp[],
): { readonly after: WalletSnapshot; readonly touched: ReadonlySet<number> } | null {
  const rules = new Map(wallet.rules.map((rule) => [rule.id, rule]));
  const touched = new Set<number>();
  for (const op of ops) {
    if (op.op === 'add_rule') {
      rules.set(op.rule.id, op.rule);
      touched.add(op.rule.id);
      continue;
    }
    const rule = rules.get(op.ruleId);
    if (rule === undefined) return null;
    touched.add(op.ruleId);
    switch (op.op) {
      case 'remove_rule':
        rules.delete(op.ruleId);
        touched.delete(op.ruleId);
        break;
      case 'set_valid_until':
        rules.set(op.ruleId, { ...rule, validUntil: op.validUntil });
        break;
      case 'add_signer':
        rules.set(op.ruleId, { ...rule, signers: [...rule.signers, op.signer] });
        break;
      case 'remove_signer':
        rules.set(op.ruleId, {
          ...rule,
          signers: rule.signers.filter((signer) => signer.id !== op.signerId),
        });
        break;
      case 'set_weight':
        rules.set(op.ruleId, {
          ...rule,
          weights: { ...rule.weights, [op.signerId]: op.weight },
        });
        break;
      case 'set_threshold':
        rules.set(op.ruleId, { ...rule, threshold: op.threshold });
        break;
    }
  }
  return { after: { ...wallet, rules: [...rules.values()] }, touched };
}

/**
 * Whether a change may be relayed, judged on the wallet as it would be after
 * all of `ops`, which go in one transaction. Returns the wallet as it would be,
 * so the caller can read the real one after the change lands and compare.
 */
export function checkWalletChange(
  wallet: WalletSnapshot,
  ops: readonly WalletOp[],
  mandates: readonly WalletMandate[],
  policy: WalletPolicy,
): WalletDecision {
  const applied = applyOps(wallet, ops);
  if (applied === null) return refuse('UNKNOWN_RULE');
  const { after, touched } = applied;
  const trust = checkWalletTrust(after, policy);
  if (trust !== null) return refuse(trust);
  for (const rule of after.rules) {
    if (touched.has(rule.id) && fewestSignatures(rule) === null) return refuse('RULE_UNREACHABLE');
  }
  if (!after.rules.some((rule) => isLastingAdmin(after, rule))) return refuse('NO_ADMIN_RULE');
  const admin = after.rules.find(isDefault);
  if (admin === undefined) return refuse('NO_DEFAULT_RULE');
  const adminSignatures = fewestSignatures(admin);
  for (const rule of after.rules) {
    // Any rule naming one contract is judged, not only the mandates listed: a
    // rule for a mandate this wallet is about to be principal of is no safer.
    if (rule.context.kind !== 'call_contract' || rule.context.contract === after.wallet) continue;
    const signatures = fewestSignatures(rule);
    if (signatures !== null && adminSignatures !== null && signatures < adminSignatures) {
      return refuse('MANDATE_RULE_EASIER');
    }
  }
  for (const mandate of mandates) {
    if (mandate.needsMultisig) {
      const singleKey = checkSingleKey(after, mandate.contract);
      if (singleKey !== null) return refuse(singleKey);
    }
  }
  return { allowed: true, wallet: after };
}

async function readWallet(
  reader: WalletReader,
  wallet: string,
  opts: CallOptions,
): Promise<WalletSnapshot | null> {
  try {
    const parsed = snapshotSchema.safeParse(await reader.read(wallet, opts));
    return parsed.success && parsed.data.wallet === wallet ? parsed.data : null;
  } catch {
    // Whatever went wrong, the wallet was not shown to be safe, and the caller
    // retries a refused relay when the principal asks again.
    return null;
  }
}

/** Reads the wallet and judges a change to it. A failed or partial read refuses. */
export async function guardWalletChange(
  reader: WalletReader,
  wallet: string,
  ops: readonly WalletOp[],
  mandates: readonly WalletMandate[],
  policy: WalletPolicy,
  opts: CallOptions,
): Promise<WalletDecision> {
  const read = await readWallet(reader, wallet, opts);
  return read === null ? refuse('READ_FAILED') : checkWalletChange(read, ops, mandates, policy);
}

/** Reads the wallet and judges it as the principal of a new or raised mandate. */
export async function guardWalletForMandate(
  reader: WalletReader,
  wallet: string,
  mandate: WalletMandate,
  policy: WalletPolicy,
  opts: CallOptions,
): Promise<WalletDecision> {
  const read = await readWallet(reader, wallet, opts);
  if (read === null) return refuse('READ_FAILED');
  const trust = checkWalletTrust(read, policy);
  if (trust !== null) return refuse(trust);
  if (mandate.needsMultisig) {
    const singleKey = checkSingleKey(read, mandate.contract);
    if (singleKey !== null) return refuse(singleKey);
  }
  return { allowed: true, wallet: read };
}
