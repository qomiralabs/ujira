// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The in-memory mandate: every operation of the mandate spec with its check
// order, events, errors and state changes, run on the fake ledger. Services
// above the chain adapter are tested against it, so it must refuse exactly
// what the contract refuses, with the same first error, and change nothing
// when it does. The shared contract vectors prove that.
//
// Each public method is one call: input the chain cannot carry fails first
// as invalid input, then the checks run in the spec's order, then the
// effects. The ledger saves every contract before the call and puts it all
// back on any failure, so a check never has to undo anything.

import { MandateRuleError } from '../errors.js';

import { attestationMessage } from './attestation.js';
import { ed25519Verify } from './bytes.js';
import {
  FakeHostFailure,
  HostAbort,
  HostAuthFailure,
  TransportFailure,
  refusal,
} from './failures.js';
import * as input from './input.js';
import type { CheckedRequest } from './input.js';
import type { FakeLedger, LedgerContract } from './ledger.js';
import {
  ROLE_BOUND,
  approvalsFit,
  attesterWellFormed,
  feeCap,
  isRoleCode,
  isZeroAddress,
  joinConflicts,
  keyHeldBy,
  limitsValid,
  recoveryFits,
  validateConfig,
} from './rules.js';
import type { RoleSets } from './rules.js';
import {
  ATTESTATION_SIGNATURE_BYTES,
  CANCEL_REASON,
  I128_MAX,
  MAX_ATTESTATION_VALIDITY,
  MAX_BATCH,
  MAX_BATCH_TRANSFERS,
  MAX_LEGS,
  RECOVERY_ACTION,
  ROLE,
  SECONDS_PER_DAY,
  SPEC_VERSION,
  SWEEP_GRACE_SECONDS,
  U64_MAX,
  isMandateErrorName,
} from './spec.js';
import type {
  CancelReason,
  OpenStatus,
  PayoutStatus,
  RecipientMode,
  RecoveryActionKind,
  RoleCode,
  TerminalStatus,
} from './spec.js';
import { FakeToken } from './token.js';
import type {
  EngineAllowEntry,
  EngineApproval,
  EngineConfig,
  EngineConfigView,
  EngineDailyUsage,
  EngineAttestation,
  EngineDestination,
  EngineItemResult,
  EngineLeg,
  EngineLimits,
  EnginePayoutRecord,
  EnginePayoutRequest,
  EnginePayoutView,
  EngineStateView,
  EventValue,
  Invocation,
} from './types.js';

interface AgentSeat {
  readonly account: string;
  /** The agent_epoch value the agent was added under. */
  readonly epoch: number;
  // What this agent's open payouts reserve. Nothing limits how many it can have open,
  // so removing an agent subtracts these rather than looping over its payouts.
  pending: bigint;
  committed: bigint;
}

interface PayoutRecord {
  readonly payoutId: string;
  status: OpenStatus;
  readonly agent: string;
  readonly agentEpoch: number;
  readonly recipientRef: string;
  readonly total: bigint;
  readonly fee: bigint;
  readonly legs: readonly EngineLeg[];
  readonly createdAt: bigint;
  readonly expiresAt: bigint;
  readonly policyEpoch: bigint;
  approvals: EngineApproval[];
}

interface Tombstone {
  readonly payoutId: string;
  readonly status: TerminalStatus;
}

type PayoutEntry = PayoutRecord | Tombstone;

interface MandateState {
  principal: string;
  proposedPrincipal: string | null;
  limits: EngineLimits;
  attester: Uint8Array | null;
  countryPolicyHash: string;
  policyEpoch: bigint;
  maxFeeBps: number;
  agents: AgentSeat[];
  approvers: string[];
  /** The approver_epoch value each current approver was added under. */
  approverEpochs: Map<string, number>;
  approvalsRequired: number;
  guardians: string[];
  executors: string[];
  recovery: string[];
  recoveryThreshold: number;
  agentEpoch: number;
  approverEpoch: number;
  recoveryEpoch: number;
  spent: bigint;
  pending: bigint;
  committed: bigint;
  paused: boolean;
  revoked: boolean;
  /** Records and tombstones; an ID once used is never removed. */
  payouts: Map<string, PayoutEntry>;
  daily: Map<string, EngineDailyUsage>;
  allowlist: Set<string>;
  /** Voters per recovery action, for the current recovery epoch only. */
  votes: Map<string, string[]>;
}

export interface MandateEngineInit {
  readonly address: string;
  readonly factory: string;
  readonly feeAddress: string;
  readonly config: EngineConfig;
}

function allowKey(recipientRef: string, d: EngineDestination): string {
  return `${recipientRef}|${d.address}|${d.tag === null ? '-' : d.tag.toString()}`;
}

function sameDestination(a: EngineDestination, b: EngineDestination): boolean {
  return a.address === b.address && a.tag === b.tag;
}

function destinationField(d: EngineDestination): EventValue {
  return { address: d.address, tag: d.tag };
}

function legsField(legs: readonly EngineLeg[]): EventValue {
  return legs.map((leg) => ({
    destination: destinationField(leg.destination),
    amount: leg.amount,
  }));
}

function limitsField(l: EngineLimits): Readonly<Record<string, EventValue>> {
  return {
    total_budget: l.totalBudget,
    per_payment_cap: l.perPaymentCap,
    per_recipient_daily_cap: l.perRecipientDailyCap,
    approval_threshold: l.approvalThreshold,
    payout_ttl_seconds: l.payoutTtlSeconds,
    expires_at: l.expiresAt,
  };
}

function charged(p: { readonly total: bigint; readonly fee: bigint }): bigint {
  return p.total + p.fee;
}

function isOpen(entry: PayoutEntry): entry is PayoutRecord {
  return entry.status === 'PENDING' || entry.status === 'APPROVED';
}

function copyLegs(legs: readonly EngineLeg[]): EngineLeg[] {
  return legs.map((leg) => ({ destination: { ...leg.destination }, amount: leg.amount }));
}

export class MandateEngine implements LedgerContract {
  readonly address: string;
  readonly factory: string;
  readonly asset: string;
  readonly recipientMode: RecipientMode;
  readonly tenantTag: string;
  readonly feeAddress: string;
  readonly #ledger: FakeLedger;
  #s: MandateState;

  /**
   * Deploys a mandate at `init.address`. The factory calls this after its
   * own checks; the constructor runs the same validation again as a
   * backstop, as the contract's constructor does.
   */
  constructor(ledger: FakeLedger, init: MandateEngineInit) {
    const c = input.config(init.config);
    validateConfig(c, init.feeAddress, ledger.now);
    this.#ledger = ledger;
    this.address = init.address;
    this.factory = init.factory;
    this.asset = c.asset;
    this.recipientMode = c.recipientMode;
    this.tenantTag = c.tenantTag;
    this.feeAddress = init.feeAddress;
    this.#s = {
      principal: c.principal,
      proposedPrincipal: null,
      limits: { ...c.limits },
      attester: c.attester === null ? null : Uint8Array.from(c.attester),
      countryPolicyHash: c.countryPolicyHash,
      policyEpoch: 0n,
      maxFeeBps: c.maxFeeBps,
      // Agents named at creation hold epoch 0; every later addition takes a
      // higher value, so no payout queued before it can match it.
      agents: c.agents.map((account) => ({ account, epoch: 0, pending: 0n, committed: 0n })),
      approvers: [...c.approvers],
      approverEpochs: new Map(c.approvers.map((account) => [account, 0])),
      approvalsRequired: c.approvalsRequired,
      guardians: [...c.guardians],
      executors: [...c.executors],
      recovery: [...c.recovery],
      recoveryThreshold: c.recoveryThreshold,
      agentEpoch: 0,
      approverEpoch: 0,
      recoveryEpoch: 0,
      spent: 0n,
      pending: 0n,
      committed: 0n,
      paused: false,
      revoked: false,
      payouts: new Map(),
      daily: new Map(),
      allowlist: new Set(),
      votes: new Map(),
    };
    ledger.register(this);
    this.#emit('mandate_initialized', {
      principal: c.principal,
      asset: c.asset,
      recipient_mode: c.recipientMode,
      tenant_tag: c.tenantTag,
      agents: [...c.agents],
      approvers: [...c.approvers],
      approvals_required: c.approvalsRequired,
      guardians: [...c.guardians],
      executors: [...c.executors],
      recovery: [...c.recovery],
      recovery_threshold: c.recoveryThreshold,
      limits: limitsField(c.limits),
      attester: c.attester,
      country_policy_hash: c.countryPolicyHash,
      max_fee_bps: c.maxFeeBps,
      fee_address: this.feeAddress,
    });
  }

  checkpoint(): () => void {
    const saved = structuredClone(this.#s);
    return () => {
      this.#s = saved;
    };
  }

  // -------------------------------------------------------------------------
  // Payouts

  /** request_payout: returns the status the payout starts in. */
  requestPayout(inv: Invocation, req: EnginePayoutRequest): OpenStatus {
    const r = input.request(req);
    return this.#call(inv, () => {
      const agent = this.#authorizeCaller(inv);
      if (!this.#isAgent(agent)) throw refusal('UNAUTHORIZED');
      this.#activeChecks();
      return this.#requestItem(agent, r);
    });
  }

  /** request_payouts: one result per item; an item's refusal never reverts the batch. */
  requestPayouts(inv: Invocation, reqs: readonly EnginePayoutRequest[]): EngineItemResult[] {
    const items = reqs.map((r) => input.request(r));
    return this.#call(inv, () => {
      const agent = this.#authorizeCaller(inv);
      if (!this.#isAgent(agent)) throw refusal('UNAUTHORIZED');
      this.#activeChecks();
      this.#batchLength(items.length);
      return items.map((r) => {
        try {
          return { payoutId: r.payoutId, error: null, status: this.#requestItem(agent, r) };
        } catch (error) {
          const name = ruleName(error);
          this.#emit('payout_request_rejected', { payout_id: r.payoutId, agent, code: name });
          return { payoutId: r.payoutId, error: name, status: null };
        }
      });
    });
  }

  /** approve: returns the payout's status after the approval. */
  approve(inv: Invocation, payoutId: string): OpenStatus {
    const id = input.bytes32('payoutId', payoutId);
    return this.#call(inv, () => {
      const approver = this.#authorizeCaller(inv);
      if (!this.#s.approvers.includes(approver)) throw refusal('UNAUTHORIZED');
      this.#activeChecks();
      const p = this.#pendingPayout(id);
      if (this.#ledger.now >= p.expiresAt) throw refusal('PAYOUT_LAPSED');
      if (!this.#agentStillSame(p)) throw refusal('AGENT_REMOVED');
      const required = this.#s.approvalsRequired;
      const epoch = this.#s.approverEpochs.get(approver) ?? 0;
      // One from an earlier epoch is not a repeat: it no longer counts, so the
      // approver may approve again, and the new approval replaces it.
      const already = p.approvals.some((a) => a.approver === approver && a.epoch === epoch);
      // A repeat is refused only while it could still matter; once the live
      // count meets a lowered requirement the call completes the payout, so
      // a payout never gets stuck.
      if (already && this.#liveApprovals(p) < required) throw refusal('ALREADY_APPROVED');
      if (!already) {
        p.approvals = [...p.approvals.filter((a) => a.approver !== approver), { approver, epoch }];
        this.#emit('payout_approval_added', {
          payout_id: id,
          approver,
          approvals: this.#liveApprovals(p),
          required,
        });
      }
      if (this.#liveApprovals(p) >= required) {
        p.status = 'APPROVED';
        this.#s.pending -= charged(p);
        this.#s.committed += charged(p);
        const seat = this.#seatOf(p);
        if (seat !== undefined) {
          seat.pending -= charged(p);
          seat.committed += charged(p);
        }
        this.#emit('payout_approved', { payout_id: id });
      }
      return p.status;
    });
  }

  reject(inv: Invocation, payoutId: string): void {
    const id = input.bytes32('payoutId', payoutId);
    this.#call(inv, () => {
      const by = this.#authorizeCaller(inv);
      if (!this.#s.approvers.includes(by) && by !== this.#s.principal) {
        throw refusal('UNAUTHORIZED');
      }
      this.#notRevoked();
      const p = this.#pendingPayout(id);
      this.#s.payouts.set(id, { payoutId: id, status: 'REJECTED' });
      this.#releasePayout(p);
      this.#emit('payout_rejected', { payout_id: id, by });
    });
  }

  cancel(inv: Invocation, payoutId: string): void {
    const id = input.bytes32('payoutId', payoutId);
    this.#call(inv, () => {
      const by = this.#authorizeCaller(inv);
      this.#notRevoked();
      this.#cancelItem(by, id);
    });
  }

  /** cancel_batch: one result per item; an item's refusal never reverts the batch. */
  cancelBatch(inv: Invocation, payoutIds: readonly string[]): EngineItemResult[] {
    const ids = payoutIds.map((id, i) => input.bytes32(`payoutIds.${String(i)}`, id));
    return this.#call(inv, () => {
      const by = this.#authorizeCaller(inv);
      this.#notRevoked();
      this.#batchLength(ids.length);
      return ids.map((id) => {
        try {
          this.#cancelItem(by, id);
          return { payoutId: id, error: null, status: 'CANCELLED' as PayoutStatus };
        } catch (error) {
          return { payoutId: id, error: ruleName(error), status: null };
        }
      });
    });
  }

  execute(inv: Invocation, payoutId: string): void {
    const id = input.bytes32('payoutId', payoutId);
    this.#call(inv, () => {
      this.#mayExecute(inv);
      this.#activeChecks();
      const p = this.#executeChecks(id);
      this.#executeEffects(p);
    });
  }

  /** execute_batch: atomic; the first failing item fails the whole call with its code. */
  executeBatch(inv: Invocation, payoutIds: readonly string[]): void {
    const ids = payoutIds.map((id, i) => input.bytes32(`payoutIds.${String(i)}`, id));
    this.#call(inv, () => {
      this.#mayExecute(inv);
      this.#activeChecks();
      this.#batchLength(ids.length);
      let transfers = 0;
      for (const id of ids) {
        // Each item is checked against the state earlier items left, its
        // balance included, then pays before the next is looked at.
        const p = this.#executeChecks(id);
        transfers += p.legs.length + (p.fee > 0n ? 1 : 0);
        if (transfers > MAX_BATCH_TRANSFERS) throw refusal('BATCH_INVALID');
        this.#executeEffects(p);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Pause, revoke and the return of funds

  pause(inv: Invocation): void {
    this.#call(inv, () => {
      const by = this.#authorizeCaller(inv);
      const s = this.#s;
      const may =
        by === s.principal ||
        s.approvers.includes(by) ||
        s.guardians.includes(by) ||
        s.recovery.includes(by);
      if (!may) throw refusal('UNAUTHORIZED');
      this.#notRevoked();
      if (s.paused) throw refusal('ALREADY_PAUSED');
      s.paused = true;
      this.#emit('paused', { by });
    });
  }

  resume(inv: Invocation): void {
    this.#call(inv, () => {
      const by = this.#authorizePrincipal(inv);
      this.#notRevoked();
      if (!this.#s.paused) throw refusal('NOT_PAUSED');
      this.#s.paused = false;
      this.#emit('resumed', { by });
    });
  }

  /** revoke: returns the balance frozen for the principal. */
  revoke(inv: Invocation): bigint {
    return this.#call(inv, () => {
      const by = this.#authorizePrincipal(inv);
      this.#notRevoked();
      return this.#revokeEffects(by);
    });
  }

  withdraw(inv: Invocation, amount: bigint): void {
    const value = input.i128('amount', amount);
    this.#call(inv, () => {
      const to = this.#authorizePrincipal(inv);
      if (value < 1n) throw refusal('AMOUNT_INVALID');
      if (value > this.#free()) throw refusal('INSUFFICIENT_FUNDS');
      this.#pay(this.asset, { address: to, tag: null }, value);
      this.#emit('withdrawn', { to, amount: value });
    });
  }

  /** sweep: anyone may call it; returns the amount paid to the principal. */
  sweep(inv: Invocation): bigint {
    return this.#call(inv, () => {
      const by = this.#authorizeCaller(inv);
      const s = this.#s;
      const now = this.#ledger.now;
      if (this.#active()) throw refusal('MANDATE_ACTIVE');
      const third = by !== s.principal;
      if (third && s.proposedPrincipal !== null) throw refusal('PRINCIPAL_CHANGE_PENDING');
      // Here the mandate is expired or revoked; while it is only expired,
      // now >= expires_at, so the difference cannot go below zero.
      if (third && !s.revoked && now - s.limits.expiresAt < SWEEP_GRACE_SECONDS) {
        throw refusal('SWEEP_GRACE_PERIOD');
      }
      const amount = this.#balance();
      if (amount === 0n) throw refusal('NOTHING_TO_SWEEP');
      this.#pay(this.asset, { address: s.principal, tag: null }, amount);
      this.#emit('swept', { by, amount });
      return amount;
    });
  }

  recoverToken(inv: Invocation, token: string, amount: bigint): void {
    const tokenAddress = input.destination('token', { address: token, tag: null }).address;
    const value = input.i128('amount', amount);
    this.#call(inv, () => {
      const to = this.#authorizePrincipal(inv);
      if (tokenAddress === this.asset) throw refusal('WRONG_ASSET');
      if (value < 1n) throw refusal('AMOUNT_INVALID');
      const before = this.#balance();
      this.#pay(tokenAddress, { address: to, tag: null }, value);
      // A second address for the settlement asset must never let recovery
      // bypass the free balance cap of withdraw.
      if (this.#balance() !== before) throw refusal('WRONG_ASSET');
      this.#emit('token_recovered', { token: tokenAddress, amount: value });
    });
  }

  // -------------------------------------------------------------------------
  // Configuration

  updateLimits(inv: Invocation, limits: EngineLimits): void {
    const l = input.limits(limits);
    this.#call(inv, () => {
      this.#authorizePrincipal(inv);
      this.#notRevoked();
      const s = this.#s;
      const now = this.#ledger.now;
      if (!limitsValid(l, now)) throw refusal('CONFIG_INVALID');
      if (s.approvers.length === 0 && l.approvalThreshold <= l.perPaymentCap) {
        throw refusal('CONFIG_INVALID');
      }
      if (l.totalBudget < s.spent + s.pending + s.committed) {
        throw refusal('BUDGET_BELOW_RESERVED');
      }
      // Reactivating an expired mandate must leave its reservations covered.
      if (now >= s.limits.expiresAt && this.#balance() < s.pending + s.committed) {
        throw refusal('INSUFFICIENT_FUNDS');
      }
      s.limits = { ...l };
      this.#emit('limits_updated', limitsField(l));
    });
  }

  addRole(inv: Invocation, role: number, account: string): void {
    const code = input.u32('role', role);
    const who = input.destination('account', { address: account, tag: null }).address;
    this.#call(inv, () => {
      this.#authorizePrincipal(inv);
      this.#notRevoked();
      const s = this.#s;
      if (!isRoleCode(code) || this.#members(code).includes(who)) throw refusal('CONFIG_INVALID');
      if (isZeroAddress(who)) throw refusal('CONFIG_INVALID');
      if (joinConflicts(code, who, this.#sets(), s.principal, this.feeAddress)) {
        throw refusal('ROLE_CONFLICT');
      }
      if (s.attester !== null && keyHeldBy(s.attester, [who])) throw refusal('ROLE_CONFLICT');
      if (this.#members(code).length >= ROLE_BOUND[code]) throw refusal('ROLE_SET_FULL');
      this.#append(code, who);
      this.#emit('role_added', { role: code, account: who });
      if (code === ROLE.APPROVER && s.approvers.length === 1) {
        s.approvalsRequired = 1;
        this.#emit('approvals_required_set', { required: 1 });
      }
      if (code === ROLE.AGENT || code === ROLE.RECOVERY) this.#bumpRecoveryEpoch();
      if (code === ROLE.RECOVERY && s.recovery.length === 1) {
        // A lone new member must never face a threshold of 0.
        s.recoveryThreshold = 1;
        this.#emit('recovery_threshold_set', { required: 1, recovery_epoch: s.recoveryEpoch });
      }
    });
  }

  removeRole(inv: Invocation, role: number, account: string): void {
    const code = input.u32('role', role);
    const who = input.destination('account', { address: account, tag: null }).address;
    this.#call(inv, () => {
      this.#authorizePrincipal(inv);
      this.#notRevoked();
      const s = this.#s;
      if (!isRoleCode(code) || !this.#members(code).includes(who)) throw refusal('CONFIG_INVALID');
      const size = this.#members(code).length;
      if (code === ROLE.APPROVER && size > 1 && size - 1 < s.approvalsRequired) {
        throw refusal('CONFIG_INVALID');
      }
      if (
        code === ROLE.APPROVER &&
        size === 1 &&
        s.limits.approvalThreshold <= s.limits.perPaymentCap
      ) {
        throw refusal('CONFIG_INVALID');
      }
      if (code === ROLE.RECOVERY && size > 1 && size - 1 < s.recoveryThreshold) {
        throw refusal('CONFIG_INVALID');
      }
      if (code === ROLE.AGENT) this.#releaseAgent(who);
      this.#remove(code, who);
      this.#emit('role_removed', { role: code, account: who });
      if (code === ROLE.APPROVER && size === 1) {
        s.approvalsRequired = 0;
        this.#emit('approvals_required_set', { required: 0 });
      }
      if (code === ROLE.AGENT || code === ROLE.RECOVERY) this.#bumpRecoveryEpoch();
      if (code === ROLE.RECOVERY && size === 1) {
        s.recoveryThreshold = 0;
        this.#emit('recovery_threshold_set', { required: 0, recovery_epoch: s.recoveryEpoch });
      }
    });
  }

  setApprovalsRequired(inv: Invocation, n: number): void {
    const required = input.u32('n', n);
    this.#call(inv, () => {
      this.#authorizePrincipal(inv);
      this.#notRevoked();
      const s = this.#s;
      if (!approvalsFit(required, s.approvers.length, s.limits)) throw refusal('CONFIG_INVALID');
      s.approvalsRequired = required;
      this.#emit('approvals_required_set', { required });
    });
  }

  setRecoveryThreshold(inv: Invocation, n: number): void {
    const required = input.u32('n', n);
    this.#call(inv, () => {
      this.#authorizePrincipal(inv);
      this.#notRevoked();
      const s = this.#s;
      if (!recoveryFits(required, s.recovery.length)) throw refusal('CONFIG_INVALID');
      s.recoveryThreshold = required;
      this.#bumpRecoveryEpoch();
      this.#emit('recovery_threshold_set', { required, recovery_epoch: s.recoveryEpoch });
    });
  }

  allowRecipients(inv: Invocation, entries: readonly EngineAllowEntry[]): void {
    this.#changeAllowlist(inv, entries, true);
  }

  disallowRecipients(inv: Invocation, entries: readonly EngineAllowEntry[]): void {
    this.#changeAllowlist(inv, entries, false);
  }

  setAttestationPolicy(inv: Invocation, attester: Uint8Array, countryPolicyHash: string): void {
    const key = input.bytes('attester', attester);
    const hash = input.bytes32('countryPolicyHash', countryPolicyHash);
    this.#call(inv, () => {
      this.#authorizePrincipal(inv);
      this.#notRevoked();
      const s = this.#s;
      if (this.recipientMode === 'ALLOWLIST') throw refusal('WRONG_RECIPIENT_MODE');
      if (!attesterWellFormed(key)) throw refusal('CONFIG_INVALID');
      if (keyHeldBy(key, [s.principal, this.feeAddress, ...this.#everyMember()])) {
        throw refusal('ROLE_CONFLICT');
      }
      s.attester = key;
      s.countryPolicyHash = hash;
      s.policyEpoch += 1n;
      this.#emit('attestation_policy_set', {
        attester: key,
        country_policy_hash: hash,
        policy_epoch: s.policyEpoch,
      });
    });
  }

  lowerFeeCap(inv: Invocation, newBps: number): void {
    const bps = input.u32('newBps', newBps);
    this.#call(inv, () => {
      this.#authorizePrincipal(inv);
      this.#notRevoked();
      if (bps >= this.#s.maxFeeBps) throw refusal('CONFIG_INVALID');
      this.#s.maxFeeBps = bps;
      this.#emit('fee_cap_lowered', { max_fee_bps: bps });
    });
  }

  // -------------------------------------------------------------------------
  // Principal transfer

  proposePrincipal(inv: Invocation, proposed: string): void {
    const next = input.destination('proposed', { address: proposed, tag: null }).address;
    this.#call(inv, () => {
      const current = this.#authorizePrincipal(inv);
      const s = this.#s;
      if (isZeroAddress(next)) throw refusal('CONFIG_INVALID');
      if (this.#holdsPrincipalConflict(next) || next === this.feeAddress) {
        throw refusal('ROLE_CONFLICT');
      }
      if (s.attester !== null && keyHeldBy(s.attester, [next])) throw refusal('ROLE_CONFLICT');
      s.proposedPrincipal = next;
      this.#emit('principal_proposed', { current, proposed: next });
    });
  }

  acceptPrincipal(inv: Invocation): void {
    this.#call(inv, () => {
      const s = this.#s;
      // With no proposal there is no address to authorize.
      if (s.proposedPrincipal === null) throw refusal('UNAUTHORIZED');
      const next = s.proposedPrincipal;
      this.#authorize(inv, next);
      if (this.#holdsPrincipalConflict(next)) throw refusal('ROLE_CONFLICT');
      if (s.attester !== null && keyHeldBy(s.attester, [next])) throw refusal('ROLE_CONFLICT');
      const previous = s.principal;
      s.principal = next;
      s.proposedPrincipal = null;
      this.#emit('principal_transferred', { previous, current: next });
    });
  }

  cancelPrincipalProposal(inv: Invocation): void {
    this.#call(inv, () => {
      const current = this.#authorizePrincipal(inv);
      const proposed = this.#s.proposedPrincipal;
      if (proposed === null) throw refusal('CONFIG_INVALID');
      this.#s.proposedPrincipal = null;
      this.#emit('principal_proposal_cancelled', { current, proposed });
    });
  }

  // -------------------------------------------------------------------------
  // Recovery

  /** recovery_revoke: 1 when the vote was recorded, 2 when the revoke ran. */
  recoveryRevoke(inv: Invocation): 1 | 2 {
    return this.#call(inv, () => {
      const by = this.#authorizeCaller(inv);
      this.#recoveryMember(by);
      this.#notRevoked();
      return this.#vote(by, RECOVERY_ACTION.REVOKE, null, null, () => {
        this.#revokeEffects(by);
      });
    });
  }

  /** recovery_rotate_agent: 1 when the vote was recorded, 2 when the rotation ran. */
  recoveryRotateAgent(inv: Invocation, old: string, next: string | null): 1 | 2 {
    const out = input.destination('old', { address: old, tag: null }).address;
    const into =
      next === null ? null : input.destination('new', { address: next, tag: null }).address;
    return this.#call(inv, () => {
      const by = this.#authorizeCaller(inv);
      this.#recoveryMember(by);
      this.#notRevoked();
      const s = this.#s;
      if (!this.#isAgent(out) || (into !== null && (this.#isAgent(into) || isZeroAddress(into)))) {
        throw refusal('CONFIG_INVALID');
      }
      if (
        into !== null &&
        (s.approvers.includes(into) ||
          s.executors.includes(into) ||
          s.recovery.includes(into) ||
          into === s.principal ||
          into === this.feeAddress)
      ) {
        throw refusal('ROLE_CONFLICT');
      }
      if (into !== null && s.attester !== null && keyHeldBy(s.attester, [into])) {
        throw refusal('ROLE_CONFLICT');
      }
      return this.#vote(by, RECOVERY_ACTION.ROTATE_AGENT, out, into, () => {
        this.#releaseAgent(out);
        this.#remove(ROLE.AGENT, out);
        this.#emit('role_removed', { role: ROLE.AGENT, account: out });
        if (into !== null) {
          this.#append(ROLE.AGENT, into);
          this.#emit('role_added', { role: ROLE.AGENT, account: into });
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Views

  version(): number {
    return this.#view(() => SPEC_VERSION);
  }

  config(): EngineConfigView {
    return this.#view(() => {
      const s = this.#s;
      return {
        principal: s.principal,
        asset: this.asset,
        recipientMode: this.recipientMode,
        tenantTag: this.tenantTag,
        agents: s.agents.map((a) => a.account),
        approvers: [...s.approvers],
        approvalsRequired: s.approvalsRequired,
        guardians: [...s.guardians],
        executors: [...s.executors],
        recovery: [...s.recovery],
        recoveryThreshold: s.recoveryThreshold,
        limits: { ...s.limits },
        attester: s.attester === null ? null : Uint8Array.from(s.attester),
        countryPolicyHash: s.countryPolicyHash,
        maxFeeBps: s.maxFeeBps,
        factory: this.factory,
        feeAddress: this.feeAddress,
        proposedPrincipal: s.proposedPrincipal,
        recoveryEpoch: s.recoveryEpoch,
        agentEpoch: s.agentEpoch,
        approverEpoch: s.approverEpoch,
      };
    });
  }

  state(): EngineStateView {
    return this.#view(() => {
      const s = this.#s;
      return {
        spent: s.spent,
        pending: s.pending,
        committed: s.committed,
        balance: this.#balance(),
        free: this.#free(),
        paused: s.paused,
        revoked: s.revoked,
        expired: this.#expired(),
        policyEpoch: s.policyEpoch,
      };
    });
  }

  /** The record, the tombstone, or null when the ID was never used. */
  payout(payoutId: string): EnginePayoutView | null {
    const id = input.bytes32('payoutId', payoutId);
    return this.#view(() => {
      const entry = this.#s.payouts.get(id);
      if (entry === undefined) return null;
      if (!isOpen(entry)) return { payoutId: entry.payoutId, status: entry.status };
      const record: EnginePayoutRecord = {
        ...entry,
        legs: copyLegs(entry.legs),
        approvals: entry.approvals.map((a) => ({ ...a })),
      };
      return record;
    });
  }

  /** How many approvals on an open payout still count, by the rule execute goes by. */
  liveApprovals(payoutId: string): number {
    const id = input.bytes32('payoutId', payoutId);
    return this.#view(() => {
      const entry = this.#s.payouts.get(id);
      return entry !== undefined && isOpen(entry) ? this.#liveApprovals(entry) : 0;
    });
  }

  /** Today's executed total for a recipient; a stored day that is not today counts as nothing. */
  dailyUsed(recipientRef: string): EngineDailyUsage {
    const ref = input.bytes32('recipientRef', recipientRef);
    return this.#view(() => ({ day: this.#today(), used: this.#usedToday(ref) }));
  }

  isAllowed(recipientRef: string, destination: EngineDestination): boolean {
    const ref = input.bytes32('recipientRef', recipientRef);
    const d = input.destination('destination', destination);
    return this.#view(() => this.#s.allowlist.has(allowKey(ref, d)));
  }

  // -------------------------------------------------------------------------
  // Calls and authorization

  #call<T>(inv: Invocation, body: () => T): T {
    input.invocation(inv);
    return this.#ledger.invoke(this.address, 'call', body);
  }

  #view<T>(body: () => T): T {
    return this.#ledger.invoke(this.address, 'view', body);
  }

  #emit(name: string, fields: Readonly<Record<string, EventValue>>): void {
    this.#ledger.emit(this.address, name, fields);
  }

  /** A call that takes a caller argument authorizes it before anything else. */
  #authorizeCaller(inv: Invocation): string {
    this.#authorize(inv, inv.caller);
    return inv.caller;
  }

  #authorizePrincipal(inv: Invocation): string {
    this.#authorize(inv, this.#s.principal);
    return this.#s.principal;
  }

  #authorize(inv: Invocation, required: string): void {
    const signer = inv.signedBy ?? inv.caller;
    if (signer !== required) throw new HostAuthFailure(required, signer);
  }

  #notRevoked(): void {
    if (this.#s.revoked) throw refusal('MANDATE_REVOKED');
  }

  /** Revoked, expired, paused: the shared prefix of every call that does new work. */
  #activeChecks(): void {
    this.#notRevoked();
    if (this.#expired()) throw refusal('MANDATE_EXPIRED');
    if (this.#s.paused) throw refusal('MANDATE_PAUSED');
  }

  #batchLength(n: number): void {
    if (n < 1 || n > MAX_BATCH) throw refusal('BATCH_INVALID');
  }

  #mayExecute(inv: Invocation): void {
    const by = this.#authorizeCaller(inv);
    const s = this.#s;
    if (by !== s.principal && !this.#isAgent(by) && !s.executors.includes(by)) {
      throw refusal('UNAUTHORIZED');
    }
  }

  #recoveryMember(by: string): void {
    if (!this.#s.recovery.includes(by)) throw refusal('UNAUTHORIZED');
  }

  // -------------------------------------------------------------------------
  // Derived values

  #expired(): boolean {
    return this.#ledger.now >= this.#s.limits.expiresAt;
  }

  #active(): boolean {
    return !this.#s.revoked && !this.#expired();
  }

  #today(): bigint {
    return this.#ledger.now / SECONDS_PER_DAY;
  }

  #usedToday(ref: string): bigint {
    const entry = this.#s.daily.get(ref);
    return entry?.day === this.#today() ? entry.used : 0n;
  }

  #headroom(ref: string): bigint {
    const left = this.#s.limits.perRecipientDailyCap - this.#usedToday(ref);
    return left > 0n ? left : 0n;
  }

  /**
   * The settlement balance, read from the token. A read that fails is the
   * host's failure, never a mandate code, so it is not caught here.
   */
  #balance(): bigint {
    const token = this.#ledger.contract(this.asset);
    if (!(token instanceof FakeToken)) {
      throw new TransportFailure('the settlement asset is not a token on this ledger');
    }
    const held = token.balance(this.address);
    return held > I128_MAX ? I128_MAX : held;
  }

  #free(): bigint {
    const balance = this.#balance();
    if (!this.#active()) return balance;
    const left = balance - this.#s.pending - this.#s.committed;
    return left > 0n ? left : 0n;
  }

  // -------------------------------------------------------------------------
  // Roles

  #isAgent(account: string): boolean {
    return this.#s.agents.some((a) => a.account === account);
  }

  #sets(): RoleSets {
    const s = this.#s;
    return {
      [ROLE.AGENT]: s.agents.map((a) => a.account),
      [ROLE.APPROVER]: s.approvers,
      [ROLE.GUARDIAN]: s.guardians,
      [ROLE.EXECUTOR]: s.executors,
      [ROLE.RECOVERY]: s.recovery,
    };
  }

  #members(role: RoleCode): readonly string[] {
    return this.#sets()[role];
  }

  #everyMember(): string[] {
    const sets = this.#sets();
    return [ROLE.AGENT, ROLE.APPROVER, ROLE.GUARDIAN, ROLE.EXECUTOR, ROLE.RECOVERY].flatMap(
      (role) => sets[role],
    );
  }

  /** Appends, so every set reports its members in the order they joined. */
  #append(role: RoleCode, account: string): void {
    const s = this.#s;
    switch (role) {
      case ROLE.AGENT:
        // The counter goes up first and the agent stores the new value.
        s.agentEpoch += 1;
        s.agents.push({ account, epoch: s.agentEpoch, pending: 0n, committed: 0n });
        return;
      case ROLE.APPROVER:
        // The same again: an approver added back holds a value no earlier approval has.
        s.approverEpoch += 1;
        s.approverEpochs.set(account, s.approverEpoch);
        s.approvers.push(account);
        return;
      case ROLE.GUARDIAN:
        s.guardians.push(account);
        return;
      case ROLE.EXECUTOR:
        s.executors.push(account);
        return;
      case ROLE.RECOVERY:
        s.recovery.push(account);
        return;
    }
  }

  /** Removes without reordering the members that stay. */
  #remove(role: RoleCode, account: string): void {
    const s = this.#s;
    switch (role) {
      case ROLE.AGENT:
        s.agents = s.agents.filter((a) => a.account !== account);
        return;
      case ROLE.APPROVER:
        s.approverEpochs.delete(account);
        s.approvers = s.approvers.filter((a) => a !== account);
        return;
      case ROLE.GUARDIAN:
        s.guardians = s.guardians.filter((a) => a !== account);
        return;
      case ROLE.EXECUTOR:
        s.executors = s.executors.filter((a) => a !== account);
        return;
      case ROLE.RECOVERY:
        s.recovery = s.recovery.filter((a) => a !== account);
        return;
    }
  }

  /** The principal never sits among the agents, the executors or the recovery set. */
  #holdsPrincipalConflict(account: string): boolean {
    const s = this.#s;
    return this.#isAgent(account) || s.executors.includes(account) || s.recovery.includes(account);
  }

  #bumpRecoveryEpoch(): void {
    // Votes are kept per epoch, so a change between votes starts a new tally.
    this.#s.recoveryEpoch += 1;
    this.#s.votes.clear();
  }

  #vote(
    by: string,
    kind: RecoveryActionKind,
    old: string | null,
    next: string | null,
    action: () => void,
  ): 1 | 2 {
    const s = this.#s;
    const key = `${String(kind)}|${old ?? '-'}|${next ?? '-'}`;
    const voters = s.votes.get(key) ?? [];
    if (voters.includes(by)) throw refusal('ALREADY_APPROVED');
    voters.push(by);
    s.votes.set(key, voters);
    this.#emit('recovery_vote_added', {
      kind,
      old,
      new: next,
      votes: voters.length,
      required: s.recoveryThreshold,
      recovery_epoch: s.recoveryEpoch,
    });
    if (voters.length < s.recoveryThreshold) return 1;
    action();
    this.#bumpRecoveryEpoch();
    this.#emit('recovery_executed', { kind, old, new: next, by });
    return 2;
  }

  // -------------------------------------------------------------------------
  // Payout internals

  /** The seat that queued this payout, or undefined once that agent was removed. */
  #seatOf(p: PayoutRecord): AgentSeat | undefined {
    return this.#s.agents.find((a) => a.account === p.agent && a.epoch === p.agentEpoch);
  }

  #agentStillSame(p: PayoutRecord): boolean {
    return this.#seatOf(p) !== undefined;
  }

  #liveApprovals(p: PayoutRecord): number {
    return p.approvals.filter((a) => this.#s.approverEpochs.get(a.approver) === a.epoch).length;
  }

  // A leaked key must not go on holding the balance after the key is gone, and these
  // payouts can never execute, so what they reserve comes back at once.
  #releaseAgent(account: string): void {
    const s = this.#s;
    const seat = s.agents.find((a) => a.account === account);
    if (seat === undefined) return;
    s.pending -= seat.pending;
    s.committed -= seat.committed;
  }

  /** A payout leaving by reject or cancel, unless removing its agent already released it. */
  #releasePayout(p: PayoutRecord): void {
    const s = this.#s;
    const seat = this.#seatOf(p);
    if (seat === undefined) return;
    if (p.status === 'PENDING') {
      s.pending -= charged(p);
      seat.pending -= charged(p);
    } else {
      s.committed -= charged(p);
      seat.committed -= charged(p);
    }
  }

  #pendingPayout(id: string): PayoutRecord {
    const entry = this.#s.payouts.get(id);
    if (entry === undefined) throw refusal('PAYOUT_NOT_FOUND');
    if (entry.status !== 'PENDING') throw refusal('PAYOUT_WRONG_STATUS');
    return entry;
  }

  /** request_payout checks 6 to 28 and the effects, for one request. */
  #requestItem(agent: string, r: CheckedRequest): OpenStatus {
    const s = this.#s;
    const now = this.#ledger.now;
    if (s.payouts.has(r.payoutId)) throw refusal('PAYOUT_ID_EXISTS');
    if (now >= r.deadline) throw refusal('REQUEST_DEADLINE_PASSED');
    if (r.total < 1n || r.fee < 0n || r.fee > I128_MAX - r.total) {
      throw refusal('AMOUNT_INVALID');
    }
    this.#checkLegs(r);
    const attested = this.recipientMode !== 'ALLOWLIST';
    const listed = this.recipientMode !== 'ATTESTED';
    if (!attested && r.attestations.length > 0) throw refusal('ATTESTATION_INVALID');
    if (attested && r.attestations.length !== r.legs.length) {
      throw refusal('ATTESTATION_INVALID');
    }
    // Within one time to live of the largest time the sum does not fit. It is
    // capped rather than refused: a wrapped value would read as already lapsed
    // and let anyone cancel the payout.
    let expiresAt = now + s.limits.payoutTtlSeconds;
    if (expiresAt > U64_MAX) expiresAt = U64_MAX;
    // Every check of one leg runs before the next leg starts.
    r.legs.forEach((leg, i) => {
      if (listed && !s.allowlist.has(allowKey(r.recipientRef, leg.destination))) {
        throw refusal('RECIPIENT_NOT_ALLOWED');
      }
      const a = r.attestations[i];
      if (attested && a !== undefined) {
        this.#checkAttestation(r.recipientRef, leg.destination, a);
        if (a.validUntil < expiresAt) expiresAt = a.validUntil;
      }
    });
    const charge = r.total + r.fee;
    if (r.fee > feeCap(r.total, s.maxFeeBps)) throw refusal('FEE_EXCEEDS_CAP');
    if (charge > s.limits.perPaymentCap) throw refusal('PAYMENT_CAP_EXCEEDED');
    if (charge > s.limits.totalBudget - (s.spent + s.pending + s.committed)) {
      throw refusal('BUDGET_EXCEEDED');
    }
    if (r.total > this.#headroom(r.recipientRef)) throw refusal('DAILY_CAP_EXCEEDED');
    if (charge > this.#free()) throw refusal('INSUFFICIENT_FUNDS');

    const seat = s.agents.find((a) => a.account === agent);
    const agentEpoch = seat?.epoch ?? 0;
    const status: OpenStatus = charge >= s.limits.approvalThreshold ? 'PENDING' : 'APPROVED';
    s.payouts.set(r.payoutId, {
      payoutId: r.payoutId,
      status,
      agent,
      agentEpoch,
      recipientRef: r.recipientRef,
      total: r.total,
      fee: r.fee,
      legs: copyLegs(r.legs),
      createdAt: now,
      expiresAt,
      policyEpoch: s.policyEpoch,
      approvals: [],
    });
    if (status === 'PENDING') {
      s.pending += charge;
      if (seat !== undefined) seat.pending += charge;
    } else {
      s.committed += charge;
      if (seat !== undefined) seat.committed += charge;
    }
    this.#emit('payout_requested', {
      payout_id: r.payoutId,
      agent,
      recipient_ref: r.recipientRef,
      total: r.total,
      fee: r.fee,
      legs: legsField(r.legs),
      task_ref: r.taskRef,
      status,
      expires_at: expiresAt,
    });
    return status;
  }

  /** Leg count, amounts, the fee address, duplicates and the running sum. */
  #checkLegs(r: CheckedRequest): void {
    if (r.legs.length < 1 || r.legs.length > MAX_LEGS) throw refusal('LEGS_INVALID');
    if (r.legs.some((leg) => leg.amount < 1n)) throw refusal('LEGS_INVALID');
    if (r.legs.some((leg) => this.#unpayable(leg.destination.address))) {
      throw refusal('LEGS_INVALID');
    }
    if (r.legs.some((leg) => leg.destination.address === this.feeAddress)) {
      throw refusal('LEGS_INVALID');
    }
    const duplicate = r.legs.some((leg, i) =>
      r.legs.slice(i + 1).some((other) => sameDestination(leg.destination, other.destination)),
    );
    if (duplicate) throw refusal('LEGS_INVALID');
    // The running form fails on the same edge as the contract's checked
    // arithmetic, without ever forming a sum above the total.
    let running = 0n;
    for (const leg of r.legs) {
      if (leg.amount > r.total - running) throw refusal('LEGS_SUM_MISMATCH');
      running += leg.amount;
    }
    if (running !== r.total) throw refusal('LEGS_SUM_MISMATCH');
  }

  /**
   * An address money sent to can never pay out: the mandate, its factory, the asset's
   * own contract, or one nobody holds the key to. The asset's issuer burns a transfer
   * too, but checking it here would mean asking the asset on every leg, so onboarding
   * and the attester refuse that one.
   */
  #unpayable(address: string): boolean {
    return (
      address === this.address ||
      address === this.factory ||
      address === this.asset ||
      isZeroAddress(address)
    );
  }

  #checkAttestation(
    recipientRef: string,
    destination: EngineDestination,
    a: EngineAttestation,
  ): void {
    const s = this.#s;
    const { validUntil, policyEpoch } = a;
    const now = this.#ledger.now;
    if (now >= validUntil) throw refusal('ATTESTATION_EXPIRED');
    if (validUntil - now > MAX_ATTESTATION_VALIDITY) throw refusal('ATTESTATION_INVALID');
    if (a.signature.length !== ATTESTATION_SIGNATURE_BYTES) throw refusal('ATTESTATION_INVALID');
    // The epoch is compared before the signature, so a stale attestation
    // gets a per-item code instead of a trap that aborts an honest batch.
    if (policyEpoch !== s.policyEpoch) throw refusal('POLICY_CHANGED');
    const message = attestationMessage({
      networkId: this.#ledger.networkId,
      mandate: this.address,
      recipientRef,
      countryPolicyHash: s.countryPolicyHash,
      policyEpoch,
      validUntil,
      destination,
    });
    // An attested mode always holds an attester (checked at creation and
    // on every change), so the empty key only ever fails verification.
    if (!ed25519Verify(s.attester ?? new Uint8Array(), message, a.signature)) {
      throw new HostAbort('Crypto.InvalidInput');
    }
  }

  #cancelItem(by: string, id: string): void {
    const s = this.#s;
    const now = this.#ledger.now;
    const entry = s.payouts.get(id);
    if (entry === undefined) throw refusal('PAYOUT_NOT_FOUND');
    if (!isOpen(entry)) throw refusal('PAYOUT_WRONG_STATUS');
    let reason: CancelReason;
    if (by === s.principal) {
      reason = CANCEL_REASON.PRINCIPAL;
    } else if (by === entry.agent && this.#agentStillSame(entry)) {
      reason = CANCEL_REASON.AGENT;
    } else if (
      now >= entry.expiresAt ||
      (this.#expired() && now - s.limits.expiresAt >= SWEEP_GRACE_SECONDS)
    ) {
      reason = CANCEL_REASON.LAPSED;
    } else {
      throw refusal('UNAUTHORIZED');
    }
    s.payouts.set(id, { payoutId: id, status: 'CANCELLED' });
    this.#releasePayout(entry);
    this.#emit('payout_cancelled', { payout_id: id, by, reason });
  }

  /** execute checks 6 to 15 for one payout, against the state as it is now. */
  #executeChecks(id: string): PayoutRecord {
    const s = this.#s;
    const entry = s.payouts.get(id);
    if (entry === undefined) throw refusal('PAYOUT_NOT_FOUND');
    if (entry.status !== 'APPROVED') throw refusal('PAYOUT_WRONG_STATUS');
    const p = entry;
    if (this.#ledger.now >= p.expiresAt) throw refusal('PAYOUT_LAPSED');
    if (!this.#agentStillSame(p)) throw refusal('AGENT_REMOVED');
    if (p.fee > feeCap(p.total, s.maxFeeBps)) throw refusal('FEE_EXCEEDS_CAP');
    if (charged(p) > s.limits.perPaymentCap) throw refusal('PAYMENT_CAP_EXCEEDED');
    if (
      this.recipientMode !== 'ATTESTED' &&
      p.legs.some((leg) => !s.allowlist.has(allowKey(p.recipientRef, leg.destination)))
    ) {
      throw refusal('RECIPIENT_NOT_ALLOWED');
    }
    if (this.recipientMode !== 'ALLOWLIST' && p.policyEpoch !== s.policyEpoch) {
      throw refusal('POLICY_CHANGED');
    }
    if (p.total > this.#headroom(p.recipientRef)) throw refusal('DAILY_CAP_EXCEEDED');
    if (charged(p) > this.#balance()) throw refusal('INSUFFICIENT_FUNDS');
    return p;
  }

  /** Tombstone, totals, daily usage and the event, then every leg and last the fee. */
  #executeEffects(p: PayoutRecord): void {
    const s = this.#s;
    const charge = charged(p);
    const day = this.#today();
    const used = this.#usedToday(p.recipientRef);
    s.payouts.set(p.payoutId, { payoutId: p.payoutId, status: 'EXECUTED' });
    s.committed -= charge;
    s.spent += charge;
    const seat = this.#seatOf(p);
    if (seat !== undefined) seat.committed -= charge;
    s.daily.set(p.recipientRef, { day, used: used + p.total });
    this.#emit('payout_executed', {
      payout_id: p.payoutId,
      recipient_ref: p.recipientRef,
      total: p.total,
      fee: p.fee,
      legs: legsField(p.legs),
      day,
      spent: s.spent,
    });
    for (const leg of p.legs) this.#pay(this.asset, leg.destination, leg.amount);
    if (p.fee > 0n) this.#pay(this.asset, { address: this.feeAddress, tag: null }, p.fee);
  }

  #revokeEffects(by: string): bigint {
    const s = this.#s;
    // The only token call is this read, so nothing a token or an issuer
    // does can stop a revoke.
    const frozen = this.#balance();
    s.revoked = true;
    s.pending = 0n;
    s.committed = 0n;
    this.#emit('revoked', { by, frozen });
    return frozen;
  }

  /**
   * A transfer out, made as a guarded call: any failure of the token, a
   * returned value where none is expected, or a refused nested call becomes
   * TRANSFER_FAILED, and the ledger then reverts the whole call. A failure
   * the host cannot catch, such as a failed read, passes through unchanged.
   */
  #pay(token: string, to: EngineDestination, amount: bigint): void {
    const contract = this.#ledger.contract(token);
    if (!(contract instanceof FakeToken)) throw refusal('TRANSFER_FAILED');
    let returned: unknown;
    try {
      returned = contract.transfer(this.address, to, amount);
    } catch (error) {
      if (error instanceof TransportFailure) throw error;
      if (error instanceof FakeHostFailure || error instanceof MandateRuleError) {
        throw refusal('TRANSFER_FAILED');
      }
      throw error;
    }
    if (returned !== undefined) throw refusal('TRANSFER_FAILED');
  }

  #changeAllowlist(inv: Invocation, entries: readonly EngineAllowEntry[], allow: boolean): void {
    const list = input.allowEntries(entries);
    this.#call(inv, () => {
      this.#authorizePrincipal(inv);
      this.#notRevoked();
      if (this.recipientMode === 'ATTESTED') throw refusal('WRONG_RECIPIENT_MODE');
      this.#batchLength(list.length);
      const refused = (address: string) => this.#unpayable(address) || address === this.feeAddress;
      if (list.some((e) => refused(e.destination.address))) throw refusal('CONFIG_INVALID');
      // Counting duplicates within the call: the second of two equal
      // entries finds the first already applied.
      const next = new Set(this.#s.allowlist);
      for (const e of list) {
        const key = allowKey(e.recipientRef, e.destination);
        if (next.has(key) === allow) throw refusal('CONFIG_INVALID');
        if (allow) next.add(key);
        else next.delete(key);
      }
      this.#s.allowlist = next;
      for (const e of list) {
        this.#emit(allow ? 'recipient_allowed' : 'recipient_disallowed', {
          recipient_ref: e.recipientRef,
          destination: destinationField(e.destination),
        });
      }
    });
  }
}

/** The spec name of a mandate refusal; anything else is not an item's code and propagates. */
function ruleName(error: unknown): NonNullable<EngineItemResult['error']> {
  if (error instanceof MandateRuleError && isMandateErrorName(error.specName)) {
    return error.specName;
  }
  throw error;
}
