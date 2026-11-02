// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Runs one shared vector against the in-memory mandate and records its
// trace in the format the contracts' runner writes: each step as the vector
// wrote it plus its index, the time, the call's result, the mandate's and
// the factory's events in canonical form, the token events, and the state
// after it. The comparator then reads the trace exactly as it reads one
// from the Soroban runner.
//
// Actors get the same keys as there: an account's ed25519 seed is the
// SHA-256 of "ujira-test-actor:" and its name, and an attester label names
// the test key whose seed is the label's bytes.

import { accountAddress, addressXdr, contractAddress } from '../address.js';
import { encodeAttestationFields, attestationMessageOf } from '../attestation.js';
import { bytesOf, ed25519Sign, hexOf, sha256, utf8 } from '../bytes.js';
import type { MandateEngine } from '../engine.js';
import { MandateFactory } from '../factory.js';
import {
  HostAbort,
  HostAuthFailure,
  MandateRuleError,
  NestedCallRefused,
  TokenFailure,
  TransportFailure,
} from '../failures.js';
import { FakeLedger } from '../ledger.js';
import { FakeToken } from '../token.js';
import type { TransferHook } from '../token.js';
import type {
  EngineAttestation,
  EngineConfig,
  EngineDestination,
  EngineItemResult,
  EnginePayoutRequest,
  Invocation,
} from '../types.js';

import { actorKey, actorSeed, attesterBytes, bytes32Of, isName, labelBytes } from './canon.js';
import { compareVector } from './compare.js';
import type { Mismatch } from './compare.js';
import * as f from './format.js';
import type { LoadedVector } from './format.js';
import { isObject } from './json.js';
import type { Json, JsonObject } from './json.js';

const TOKENS = ['asset', 'other_token'] as const;
type TokenName = (typeof TOKENS)[number];

const STATE_FIELDS = [
  'spent',
  'pending',
  'committed',
  'balance',
  'free',
  'paused',
  'revoked',
  'expired',
  'policy_epoch',
];
const CONFIG_FIELDS = [
  'recovery_epoch',
  'agent_epoch',
  'approvals_required',
  'recovery_threshold',
  'max_fee_bps',
  'principal',
  'proposed_principal',
  'agents',
  'approvers',
  'guardians',
  'executors',
  'recovery',
  'limits',
  'attester',
  'country_policy_hash',
];
const TEXT_KEYS: ReadonlySet<string> = new Set(['id', 'rules', 'description']);
const ACTOR_KEYS: ReadonlySet<string> = new Set([
  'principal',
  'caller',
  'signed_by',
  'from',
  'to',
  'account',
  'address',
  'proposed',
  'old',
  'new',
  'by',
  'current',
  'previous',
  'approver',
  'agent',
  'account_key',
  'proposed_principal',
  'mandate',
  'fee_address',
]);
const ACTOR_LISTS: ReadonlySet<string> = new Set([
  'agents',
  'approvers',
  'guardians',
  'executors',
  'recovery',
  'approvals',
]);
const NOT_ACTORS: ReadonlySet<string> = new Set(['mandate', 'asset', 'other_token']);

// The order of the ed25519 group, little endian, for the non_canonical_s tamper.
const GROUP_ORDER_LE = Uint8Array.from([
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
]);

/** The vector cannot run on this fake chain, or a step that must not fail did. */
export class RunAborted extends Error {
  override readonly name = 'RunAborted';
}

/** Every actor name the vector mentions, wherever it can stand. */
function collectActors(v: Json, out: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) collectActors(x, out);
    return;
  }
  if (!isObject(v)) return;
  for (const [k, val] of Object.entries(v)) {
    if (TEXT_KEYS.has(k)) continue;
    if (k === 'balances') {
      for (const holders of isObject(val) ? Object.values(val) : []) {
        if (isObject(holders)) for (const h of Object.keys(holders)) out.add(h);
      }
      continue;
    }
    if (ACTOR_KEYS.has(k) && typeof val === 'string' && isName(val)) out.add(val);
    if (ACTOR_LISTS.has(k) && Array.isArray(val)) {
      for (const s of val) if (typeof s === 'string') out.add(s);
    }
    collectActors(val, out);
  }
}

/** The payout IDs and recipient refs the run reads back after each step, as hex. */
function collectMentions(v: Json, ids: Set<string>, refs: Set<string>): void {
  const as32 = (s: Json | undefined): string | undefined => {
    if (typeof s !== 'string') return undefined;
    try {
      return hexOf(bytes32Of(s));
    } catch {
      return undefined;
    }
  };
  const add = (set: Set<string>, s: Json | undefined): void => {
    const hex = as32(s);
    if (hex !== undefined) set.add(hex);
  };
  if (Array.isArray(v)) {
    for (const x of v) collectMentions(x, ids, refs);
    return;
  }
  if (!isObject(v)) return;
  for (const [k, val] of Object.entries(v)) {
    if (k === 'payout_id') add(ids, val);
    if (k === 'recipient_ref') add(refs, val);
    if (k === 'ids' && Array.isArray(val)) for (const s of val) add(ids, s);
    if (k === 'payouts' && isObject(val)) for (const s of Object.keys(val)) add(ids, s);
    if (k === 'daily' && isObject(val)) for (const s of Object.keys(val)) add(refs, s);
    collectMentions(val, ids, refs);
  }
}

function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function flipLast(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  const last = out.length - 1;
  out[last] = (out[last] ?? 0) ^ 1;
  return out;
}

/** S + L in 32 bytes little endian: the same scalar, written the way a strict verifier refuses. */
export function addGroupOrder(s: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  let carry = 0;
  for (let i = 0; i < 32; i += 1) {
    const sum = (s[i] ?? 0) + (GROUP_ORDER_LE[i] ?? 0) + carry;
    out[i] = sum & 0xff;
    carry = sum >> 8;
  }
  return out;
}

export class VectorWorld {
  readonly ledger: FakeLedger;
  readonly #v: LoadedVector;
  readonly #addresses = new Map<string, string>();
  readonly #names = new Map<string, string>();
  readonly #tokens = new Map<TokenName, FakeToken>();
  readonly #factory: MandateFactory;
  readonly #payoutIds = new Set<string>();
  readonly #refs = new Set<string>();
  readonly #attestations = new Map<string, EngineAttestation>();
  #mandate: MandateEngine | null = null;

  constructor(v: LoadedVector) {
    this.#v = v;
    const setup = v.parsed.setup;
    this.ledger = new FakeLedger({ now: BigInt(setup.now) });
    const actors = new Set<string>(['fee_address']);
    collectActors(v.raw, actors);
    if (actors.has('zero')) throw new RunAborted('the zero address cannot be expressed on Stellar');
    const contracts = new Set(
      Object.entries(setup.actors ?? {})
        .filter(([, spec]) => spec.kind === 'contract')
        .map(([name]) => name),
    );
    for (const name of [...actors].filter((n) => !NOT_ACTORS.has(n)).sort()) {
      const address = contracts.has(name)
        ? contractAddress(actorSeed(name))
        : accountAddress(actorKey(name));
      this.#bind(name, address);
    }
    for (const name of TOKENS) {
      this.#bind(name, contractAddress(sha256(utf8(`ujira-test-token:${name}`))));
    }
    this.#bind('factory', contractAddress(sha256(utf8('ujira-test-factory'))));
    for (const name of TOKENS) this.#tokens.set(name, this.#makeToken(name, setup.tokens?.[name]));
    this.#factory = new MandateFactory(this.ledger, {
      address: this.address('factory'),
      feeAddress: this.address('fee_address'),
      assets: [this.address('asset')],
    });
    collectMentions(v.raw, this.#payoutIds, this.#refs);
  }

  #bind(name: string, address: string): void {
    this.#addresses.set(name, address);
    this.#names.set(address, name);
  }

  #makeToken(name: TokenName, spec: f.TokenSpec | undefined): FakeToken {
    const address = this.address(name);
    switch (spec?.kind ?? 'standard') {
      case 'standard':
        return new FakeToken(this.ledger, { address });
      case 'reentrant':
        return new FakeToken(this.ledger, { address, onTransfer: this.#reentry(name, spec) });
      case 'moves_settlement':
        // On Stellar a second token address cannot move the mandate's
        // settlement balance: the attempt fails the token's own transfer.
        return new FakeToken(this.ledger, {
          address,
          kind: 'contract',
          onTransfer: () => {
            throw new TokenFailure(address, 'settlement_move_refused');
          },
        });
      case 'returns_value':
        return new FakeToken(this.ledger, { address, kind: 'contract', transferReturns: true });
      default:
        throw new RunAborted(`an ${name} of kind ${String(spec?.kind)} cannot run on Stellar`);
    }
  }

  /** A token whose transfer calls back into the mandate, with the token as the caller. */
  #reentry(name: TokenName, spec: f.TokenSpec | undefined): TransferHook {
    return () => {
      const mandate = this.mandate();
      const inv: Invocation = { caller: this.address(name) };
      const id = spec?.payout_id === undefined ? '' : hexOf(bytes32Of(spec.payout_id));
      try {
        if (spec?.reenters === 'sweep') mandate.sweep(inv);
        else if (spec?.reenters === 'cancel') mandate.cancel(inv, id);
        else mandate.execute(inv, id);
      } catch (error) {
        if (spec?.variant === 'propagate') throw error;
      }
    };
  }

  address(name: string): string {
    if (name === 'mandate') return this.mandate().address;
    const address = this.#addresses.get(name);
    if (address === undefined) throw new RunAborted(`${name} is not an actor of this vector`);
    return address;
  }

  /** A vector has one mandate: the first create that succeeds. */
  #setMandate(mandate: MandateEngine): void {
    if (this.#mandate !== null) return;
    this.#mandate = mandate;
    this.#names.set(mandate.address, 'mandate');
  }

  mandate(): MandateEngine {
    if (this.#mandate === null) throw new RunAborted('the mandate does not exist yet');
    return this.#mandate;
  }

  #token(name: TokenName): FakeToken {
    const token = this.#tokens.get(name);
    if (token === undefined) throw new RunAborted(`${name} is not a token`);
    return token;
  }

  // -------------------------------------------------------------------------
  // Written forms in, engine values out

  #destination(d: f.Destination): EngineDestination {
    if (d.tag !== null && typeof d.tag !== 'string') {
      throw new RunAborted(
        'a tag marked absent that carries a value cannot be expressed on Stellar',
      );
    }
    return { address: this.address(d.address), tag: d.tag === null ? null : BigInt(d.tag) };
  }

  #config(c: f.Config): EngineConfig {
    const list = (names: readonly string[]): string[] => names.map((n) => this.address(n));
    return {
      principal: this.address(c.principal),
      asset: this.address(c.asset),
      recipientMode: c.recipient_mode,
      tenantTag: hexOf(bytes32Of(c.tenant_tag)),
      agents: list(c.agents),
      approvers: list(c.approvers),
      approvalsRequired: c.approvals_required,
      guardians: list(c.guardians),
      executors: list(c.executors),
      recovery: list(c.recovery),
      recoveryThreshold: c.recovery_threshold,
      limits: {
        totalBudget: BigInt(c.limits.total_budget),
        perPaymentCap: BigInt(c.limits.per_payment_cap),
        perRecipientDailyCap: BigInt(c.limits.per_recipient_daily_cap),
        approvalThreshold: BigInt(c.limits.approval_threshold),
        payoutTtlSeconds: BigInt(c.limits.payout_ttl_seconds),
        expiresAt: BigInt(c.limits.expires_at),
      },
      attester: c.attester === null ? null : attesterBytes(c.attester),
      countryPolicyHash: hexOf(bytes32Of(c.country_policy_hash)),
      maxFeeBps: c.max_fee_bps,
    };
  }

  #request(raw: Json): EnginePayoutRequest {
    const r = f.request.parse(raw);
    return {
      payoutId: hexOf(bytes32Of(r.payout_id)),
      recipientRef: hexOf(bytes32Of(r.recipient_ref)),
      total: BigInt(r.total),
      fee: BigInt(r.fee),
      legs: r.legs.map((leg) => ({
        destination: this.#destination(leg.destination),
        amount: BigInt(leg.amount),
      })),
      deadline: BigInt(r.deadline),
      taskRef: hexOf(bytes32Of(r.task_ref)),
      attestations: r.attestations.map((name) => {
        const a = this.#attestations.get(name);
        if (a === undefined) throw new RunAborted(`no attest step made ${name}`);
        return a;
      }),
    };
  }

  #entries(raw: Json): { recipientRef: string; destination: EngineDestination }[] {
    return f.allowEntry
      .array()
      .parse(raw)
      .map((e) => ({
        recipientRef: hexOf(bytes32Of(e.recipient_ref)),
        destination: this.#destination(e.destination),
      }));
  }

  /** An engine value in the vector's written form. */
  written(value: unknown): Json {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return hexOf(value);
    if (typeof value === 'string') return this.#names.get(value) ?? value;
    if (Array.isArray(value)) return value.map((x) => this.written(x));
    if (typeof value === 'object' && value !== null) {
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(value)) out[snake(k)] = this.written(v);
      return out;
    }
    return value as Json;
  }

  // -------------------------------------------------------------------------
  // Setup and steps

  /** The vector's setup in the format's order: create, allowlist, mints, transfers. */
  setup(): void {
    const setup = this.#v.parsed.setup;
    if (setup.mandate !== undefined) {
      const principal = this.address(setup.mandate.principal);
      const mandate = this.#factory.create(
        { caller: principal },
        this.#config(setup.mandate),
        hexOf(bytes32Of(setup.salt ?? '#salt')),
      );
      this.#setMandate(mandate);
      const list = setup.allowlist ?? [];
      if (list.length > 0) mandate.allowRecipients({ caller: principal }, this.#entries(list));
    }
    for (const m of setup.mints ?? []) {
      this.#token(m.token).mint(this.address(m.to), BigInt(m.amount));
    }
    for (const t of setup.transfers ?? []) {
      this.#token(t.token).transfer(
        this.address(t.from),
        { address: this.address(t.to), tag: null },
        BigInt(t.amount),
      );
    }
  }

  /** Runs one step and returns its trace record. */
  step(index: number, raw: JsonObject, step: f.Step): JsonObject {
    const rec: JsonObject = { ...raw };
    delete rec['expect'];
    rec['index'] = index;
    const events = this.ledger.events.length;
    const tokenEvents = this.ledger.tokenEvents.length;
    switch (step.step) {
      case 'call':
        rec['result'] = this.#call(step);
        rec['events'] = this.#eventsSince(events);
        rec['token_events'] = this.#tokenEventsSince(tokenEvents);
        break;
      case 'advance_time':
        this.ledger.advance(BigInt(step.seconds));
        break;
      case 'set_time':
        this.ledger.setTime(BigInt(step.now));
        break;
      case 'transfer':
        this.#token(step.token).transfer(
          this.address(step.from),
          { address: this.address(step.to), tag: null },
          BigInt(step.amount),
        );
        rec['events'] = this.#eventsSince(events);
        rec['token_events'] = this.#tokenEventsSince(tokenEvents);
        break;
      case 'mint':
        this.#token(step.token).mint(this.address(step.to), BigInt(step.amount));
        break;
      case 'attest':
        rec['attestation'] = this.#attest(step);
        break;
      case 'set_receiving':
        this.#token('asset').setReceiving(this.address(step.account), step.state);
        break;
      case 'clawback':
        this.#token('asset').clawback(this.address(step.from), BigInt(step.amount));
        break;
    }
    rec['now'] = this.ledger.now.toString();
    rec['state'] = this.captureState();
    return rec;
  }

  #eventsSince(from: number): Json {
    return this.ledger.events
      .slice(from)
      .map((e) => ({ name: e.name, fields: this.written(e.fields) }));
  }

  #tokenEventsSince(from: number): Json {
    return this.ledger.tokenEvents
      .slice(from)
      .map((e) => ({ token: this.#names.get(e.token) ?? e.token, name: e.name }));
  }

  #call(step: f.CallStep): Json {
    const args: JsonObject = step.args ?? {};
    const inv: Invocation =
      step.signed_by === undefined
        ? { caller: this.address(step.caller) }
        : { caller: this.address(step.caller), signedBy: this.address(step.signed_by) };
    try {
      const value = this.#invoke(step.fn, inv, args);
      return { ok: true, return: value };
    } catch (error) {
      return failureResult(error, (address) => this.#names.get(address));
    }
  }

  #items(items: readonly EngineItemResult[]): Json {
    return items.map((i) => ({ payout_id: i.payoutId, code: i.error ?? 0, status: i.status }));
  }

  #invoke(fn: string, inv: Invocation, args: JsonObject): Json {
    const id = (): string => hexOf(bytes32Of(f.bytes32.parse(args['payout_id'])));
    const ids = (): string[] =>
      f.bytes32
        .array()
        .parse(args['ids'])
        .map((s) => hexOf(bytes32Of(s)));
    const amount = (): bigint => BigInt(f.amount.parse(args['amount']));
    const n = (key: string): number => f.u32.parse(args[key]);
    const who = (key: string): string => this.address(f.actor.parse(args[key]));
    if (fn === 'create') {
      const created = this.#factory.create(
        inv,
        this.#config(f.config.parse(args['config'])),
        hexOf(bytes32Of(f.bytes32.parse(args['salt']))),
      );
      this.#setMandate(created);
      return this.written(created.address);
    }
    const m = this.mandate();
    switch (fn) {
      case 'request_payout':
        return m.requestPayout(inv, this.#request(args['req'] ?? null));
      case 'request_payouts': {
        const reqs = Array.isArray(args['reqs']) ? args['reqs'] : [];
        return this.#items(
          m.requestPayouts(
            inv,
            reqs.map((r) => this.#request(r)),
          ),
        );
      }
      case 'approve':
        return m.approve(inv, id());
      case 'reject':
        m.reject(inv, id());
        return null;
      case 'cancel':
        m.cancel(inv, id());
        return null;
      case 'cancel_batch':
        return this.#items(m.cancelBatch(inv, ids()));
      case 'execute':
        m.execute(inv, id());
        return null;
      case 'execute_batch':
        m.executeBatch(inv, ids());
        return null;
      case 'pause':
        m.pause(inv);
        return null;
      case 'resume':
        m.resume(inv);
        return null;
      case 'revoke':
        return this.written(m.revoke(inv));
      case 'withdraw':
        m.withdraw(inv, amount());
        return null;
      case 'sweep':
        return this.written(m.sweep(inv));
      case 'recover_token':
        m.recoverToken(inv, who('token'), amount());
        return null;
      case 'update_limits': {
        const l = f.limits.parse(args['limits']);
        m.updateLimits(inv, {
          totalBudget: BigInt(l.total_budget),
          perPaymentCap: BigInt(l.per_payment_cap),
          perRecipientDailyCap: BigInt(l.per_recipient_daily_cap),
          approvalThreshold: BigInt(l.approval_threshold),
          payoutTtlSeconds: BigInt(l.payout_ttl_seconds),
          expiresAt: BigInt(l.expires_at),
        });
        return null;
      }
      case 'add_role':
        m.addRole(inv, n('role'), who('account'));
        return null;
      case 'remove_role':
        m.removeRole(inv, n('role'), who('account'));
        return null;
      case 'set_approvals_required':
        m.setApprovalsRequired(inv, n('n'));
        return null;
      case 'set_recovery_threshold':
        m.setRecoveryThreshold(inv, n('n'));
        return null;
      case 'allow_recipients':
        m.allowRecipients(inv, this.#entries(args['entries'] ?? null));
        return null;
      case 'disallow_recipients':
        m.disallowRecipients(inv, this.#entries(args['entries'] ?? null));
        return null;
      case 'set_attestation_policy':
        m.setAttestationPolicy(
          inv,
          attesterBytes(f.attesterKey.parse(args['attester'])),
          hexOf(bytes32Of(f.bytes32.parse(args['country_policy_hash']))),
        );
        return null;
      case 'propose_principal':
        m.proposePrincipal(inv, who('proposed'));
        return null;
      case 'accept_principal':
        m.acceptPrincipal(inv);
        return null;
      case 'cancel_principal_proposal':
        m.cancelPrincipalProposal(inv);
        return null;
      case 'lower_fee_cap':
        m.lowerFeeCap(inv, n('new_bps'));
        return null;
      case 'recovery_revoke':
        return m.recoveryRevoke(inv);
      case 'recovery_rotate_agent': {
        const next = args['new'] ?? null;
        return m.recoveryRotateAgent(inv, who('old'), next === null ? null : who('new'));
      }
      default:
        return this.#view(fn, args);
    }
  }

  #view(fn: string, args: JsonObject): Json {
    const m = this.mandate();
    const ref = (): string => hexOf(bytes32Of(f.bytes32.parse(args['recipient_ref'])));
    switch (fn) {
      case 'version':
        return m.version();
      case 'config':
        return this.written(m.config());
      case 'state':
        return this.written(m.state());
      case 'payout':
        return this.written(m.payout(hexOf(bytes32Of(f.bytes32.parse(args['payout_id'])))));
      case 'daily_used':
        return this.written(m.dailyUsed(ref()));
      case 'is_allowed':
        return m.isAllowed(ref(), this.#destination(f.destination.parse(args['destination'])));
      default:
        throw new RunAborted(`unknown function ${fn}`);
    }
  }

  #attest(step: Extract<f.Step, { step: 'attest' }>): Json {
    const m = this.mandate();
    const tamper = step.tamper;
    const destination = this.#destination(step.destination);
    const validUntil = BigInt(step.valid_until);
    const policyEpoch =
      step.policy_epoch === undefined ? m.state().policyEpoch : BigInt(step.policy_epoch);
    let fields = {
      networkId: this.ledger.networkId,
      mandate: addressXdr(m.address),
      recipientRef: bytes32Of(step.recipient_ref),
      countryPolicyHash: bytesOf(m.config().countryPolicyHash),
      policyEpoch,
      validUntil,
      destination: addressXdr(destination.address),
      tag: destination.tag,
    };
    // The tamper kinds that sign something other than what the mandate checks.
    switch (tamper) {
      case 'wrong_chain':
        fields = { ...fields, networkId: flipLast(fields.networkId) };
        break;
      case 'wrong_mandate':
        fields = { ...fields, mandate: flipLast(fields.mandate) };
        break;
      case 'wrong_destination':
        fields = { ...fields, destination: flipLast(fields.destination) };
        break;
      case 'wrong_policy':
        fields = { ...fields, countryPolicyHash: flipLast(fields.countryPolicyHash) };
        break;
      case 'wrong_ref':
        fields = { ...fields, recipientRef: flipLast(fields.recipientRef) };
        break;
      case 'wrong_valid_until':
        fields = { ...fields, validUntil: validUntil ^ 1n };
        break;
      case 'wrong_tag':
        fields = { ...fields, tag: fields.tag === null ? 0n : fields.tag ^ 1n };
        break;
      default:
        break;
    }
    const seed = labelBytes(tamper === 'wrong_signer' ? '#wrong_signer' : step.signer);
    let signature = ed25519Sign(seed, attestationMessageOf(encodeAttestationFields(fields)));
    signature = tamperSignature(signature, tamper);
    this.#attestations.set(step.name, { validUntil, policyEpoch, signature });
    return {
      name: step.name,
      valid_until: validUntil.toString(),
      policy_epoch: policyEpoch.toString(),
      signature: hexOf(signature),
    };
  }

  /**
   * The state after a step, in the shape of a vector's state: the mandate's
   * views, every payout and recipient the vector names, and every holder's
   * balance of both tokens. Null before the mandate exists.
   */
  captureState(): Json {
    const m = this.#mandate;
    if (m === null) return null;
    const views = { ...asObject(this.written(m.state())), ...asObject(this.written(m.config())) };
    const mandate: JsonObject = {};
    for (const k of [...STATE_FIELDS, ...CONFIG_FIELDS]) mandate[k] = views[k] ?? null;
    const payouts: JsonObject = {};
    for (const id of this.#payoutIds) payouts[id] = this.written(m.payout(id));
    const daily: JsonObject = {};
    for (const ref of this.#refs) daily[ref] = this.written(m.dailyUsed(ref));
    const holders = [...this.#addresses.entries()].filter(
      ([name]) => !NOT_ACTORS.has(name) && name !== 'factory',
    );
    holders.push(['mandate', m.address]);
    const balances: JsonObject = {};
    for (const token of TOKENS) {
      const per: JsonObject = {};
      for (const [name, address] of holders) {
        per[name] = this.#token(token).balance(address).toString();
      }
      balances[token] = per;
    }
    return { mandate, payouts, balances, daily };
  }
}

/**
 * How a refused call is written in a trace. A token's own failure is never
 * written as a mandate error: its code is the token's and may collide with
 * one of the mandate's. Anything that is not a failure of the chain is a bug
 * in the run and is rethrown.
 */
export function failureResult(
  error: unknown,
  nameOf: (address: string) => string | undefined,
): Json {
  if (error instanceof MandateRuleError) return { error: error.specName };
  if (error instanceof HostAuthFailure) return { host_auth_failure: true };
  if (error instanceof HostAbort) return { host_abort: error.hostError };
  if (error instanceof TokenFailure) {
    return { escaped_error: { from: nameOf(error.token) ?? 'unknown', code: error.reason } };
  }
  if (error instanceof NestedCallRefused) return { host_error: 'Context.InvalidAction' };
  if (error instanceof TransportFailure) return { host_error: error.message };
  throw error;
}

function asObject(value: Json): JsonObject {
  return isObject(value) ? value : {};
}

/** Damages a finished signature, for the tamper kinds that do. */
export function tamperSignature(sig: Uint8Array, tamper: string | undefined): Uint8Array {
  switch (tamper) {
    case 'flipped_bit': {
      const out = Uint8Array.from(sig);
      out[0] = (out[0] ?? 0) ^ 1;
      return out;
    }
    case 'non_canonical_s': {
      const out = Uint8Array.from(sig);
      out.set(addGroupOrder(sig.subarray(32, 64)), 32);
      return out;
    }
    case 'empty':
      return new Uint8Array();
    case 'truncated':
      return sig.slice(0, 32);
    case 'short_signature':
      return sig.slice(0, 63);
    case 'long_signature':
      return Uint8Array.from([...sig, 0]);
    case 'extended':
      return Uint8Array.from([...sig, ...new Uint8Array(64)]);
    default:
      return sig;
  }
}

export interface VectorRun {
  readonly trace: JsonObject;
  readonly mismatch: Mismatch | undefined;
}

/** Runs one vector on the in-memory mandate and compares its trace with the vector. */
export function runVector(v: LoadedVector): VectorRun {
  const trace: JsonObject = { id: v.parsed.id, file: v.file, status: 'ran' };
  const steps: Json[] = [];
  try {
    const world = new VectorWorld(v);
    world.setup();
    trace['setup_state'] = world.captureState();
    v.parsed.steps.forEach((step, i) => {
      const raw = v.raw['steps'];
      const rawStep = Array.isArray(raw) ? raw[i] : undefined;
      steps.push(world.step(i + 1, isObject(rawStep) ? rawStep : {}, step));
    });
  } catch (error) {
    trace['status'] = 'aborted';
    trace['reason'] =
      `step ${String(steps.length + 1)}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    trace['setup_state'] ??= null;
  }
  trace['steps'] = steps;
  return { trace, mismatch: compareVector(v.raw, trace, 'stellar') };
}
