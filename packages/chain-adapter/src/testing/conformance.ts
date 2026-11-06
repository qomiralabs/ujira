// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The conformance suite every chain adapter passes: the fake here, the
// Stellar adapter against a local network later. It reaches the chain only
// through the ChainAdapter interface and a small harness that can create
// wallets, sign as them, move tokens in from outside and move time, so a
// difference in behaviour between two adapters is a failing test, not a
// surprise in production.
//
// Each case builds its own world, so cases never depend on each other.

import { createHash } from 'node:crypto';

import { tokenAmount } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import { ChainAdapterError } from '../errors.js';
import { NETWORK_IDS } from '../networks.js';
import type { ExternalSignerRole, SignerRef } from '../signer.js';
import type {
  AdapterStore,
  Bytes32,
  CallOptions,
  ChainAdapter,
  ChainAddress,
  ChainReceipt,
  CountryCode,
  Destination,
  ExecutorLease,
  LegKey,
  MandateAction,
  MandateConfigInput,
  MandateRef,
  PayRequest,
  PayStep,
  SigningRequest,
  SubmissionRef,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '../types.js';

import { SUBMISSION_TRANSITIONS } from './fake-store.js';
import type { SubmissionMove } from './fake-store.js';
import type { AnchorScript } from './faults.js';

/** Fault controls a harness offers when its network can fail on demand. */
export interface ChainFaults {
  timeoutAfterLanding(count?: number): void;
  chainDown(on?: boolean): void;
  rpcLag(seconds: number): void;
  signerDown(on?: boolean): void;
  sponsorDenied(on?: boolean): void;
  transferFails(destination: ChainAddress, on?: boolean): void;
  anchorScript(script: AnchorScript | null): void;
}

/** What the suite needs around an adapter. Everything else goes through the adapter. */
export interface AdapterHarness {
  readonly adapter: ChainAdapter;
  readonly store: AdapterStore;
  readonly scope: TenantScope;
  readonly otherScope: TenantScope;
  /** The trusted mandate factory. */
  readonly factory: ChainAddress;
  /** UJIRA's executor accounts; every mandate the suite deploys lists them. */
  readonly executors: readonly ChainAddress[];
  /** An agent key UJIRA holds for `scope`. */
  readonly managedAgent: { readonly ref: SignerRef; readonly address: ChainAddress };
  /** A wallet per name, made on first use. */
  wallet(name: string): ChainAddress;
  /** Signs a text as the wallet would, in the network's message signing scheme. */
  signMessage(wallet: ChainAddress, text: string): Promise<string>;
  /** Signs a request as the wallet would. */
  sign(request: SigningRequest, wallet: ChainAddress): Promise<string>;
  /** Credits the settlement asset in raw units, as a deposit from outside. */
  fund(to: ChainAddress, amount: bigint): Promise<void>;
  balance(of: ChainAddress): Promise<bigint>;
  advance(seconds: bigint): Promise<void>;
  /** Registers a destination as a recipient method and returns its ID. */
  recipientMethod(destination: Destination): Uuid;
  /** Where the factory puts the mandate a principal creates with a salt. */
  mandateAddress(principal: ChainAddress, salt: Bytes32): ChainAddress;
  /** Every submission state move the store accepted, oldest first. */
  moves(): readonly SubmissionMove[];
  /** A new adapter on the same chain and store, as after a process restart. */
  restart(): ChainAdapter;
  readonly faults: ChainFaults | null;
}

export type AdapterHarnessFactory = () => AdapterHarness | Promise<AdapterHarness>;

export interface SuiteMandate {
  readonly ref: MandateRef;
  readonly principal: ChainAddress;
  readonly approvers: readonly ChainAddress[];
  readonly recovery: readonly ChainAddress[];
  readonly recipients: readonly {
    readonly recipientRef: Bytes32;
    readonly methodId: Uuid;
    readonly address: ChainAddress;
  }[];
  readonly expiresAt: UnixSeconds;
}

export interface SuiteMandateOptions {
  readonly approvers?: number;
  /** How many of them a payout needs; all of them by default. */
  readonly approvalsRequired?: number;
  readonly recovery?: number;
  readonly recoveryThreshold?: number;
  readonly maxFeeBps?: number;
  /** Raw units credited after deployment. */
  readonly fund?: bigint;
  /** Approval is needed at or above this charge; by default nothing needs one. */
  readonly approvalThreshold?: bigint;
  readonly salt?: string;
}

const DAY = 86_400n;
const CAP = 100_000_000n;
const OPTS: CallOptions = { correlationId: 'conformance' };

function bytes32(label: string): Bytes32 {
  return `0x${createHash('sha256').update(label).digest('hex')}` as Bytes32;
}

function usdc(amount: bigint): TokenAmount {
  return tokenAmount(amount, 'USDC', 'stellar');
}

/** `value`, or a thrown error naming what was missing. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what}`);
  return value;
}

/** The receipt of a final step, or a thrown error for any other step. */
export function finalReceipt(step: PayStep | undefined): ChainReceipt {
  if (step?.kind !== 'final') throw new Error('expected a final step');
  return step.receipt;
}

/** The error a promise rejects with, which must be an adapter error. */
export async function refusalOf(promise: Promise<unknown>): Promise<ChainAdapterError> {
  const outcome = await promise.then(
    () => new Error('expected the call to be refused'),
    (error: unknown) => error,
  );
  if (!(outcome instanceof ChainAdapterError)) throw outcome;
  return outcome;
}

async function now(h: AdapterHarness): Promise<UnixSeconds> {
  return (await h.adapter.health(OPTS)).checkedAt;
}

function external(
  h: AdapterHarness,
  address: ChainAddress,
  role: ExternalSignerRole = 'principal',
): SignerRef {
  return { kind: 'external', network: h.adapter.network, role, address };
}

/** Prepares, signs and submits an action as `wallet`. */
export async function act(
  h: AdapterHarness,
  mandate: MandateRef | null,
  action: MandateAction,
  wallet: ChainAddress,
  role: ExternalSignerRole = 'principal',
): Promise<SubmissionRef> {
  const request = await h.adapter.prepareMandateAction(
    { scope: h.scope, mandate, action, signer: external(h, wallet, role) },
    OPTS,
  );
  return h.adapter.submitSigned(
    {
      scope: h.scope,
      requestId: request.requestId,
      signed: await h.sign(request, wallet),
      correlationId: 'conformance',
    },
    OPTS,
  );
}

/** Deploys a mandate through the adapter, allowlists two recipients and funds it. */
export async function deployMandate(
  h: AdapterHarness,
  o: SuiteMandateOptions = {},
): Promise<SuiteMandate> {
  const network = h.adapter.network;
  const principal = h.wallet('principal');
  const approvers = Array.from({ length: o.approvers ?? 0 }, (_, i) =>
    h.wallet(`approver-${String(i)}`),
  );
  const recovery = Array.from({ length: o.recovery ?? 0 }, (_, i) =>
    h.wallet(`recovery-${String(i)}`),
  );
  const expiresAt = ((await now(h)) + 30n * DAY) as UnixSeconds;
  const config: MandateConfigInput = {
    principal,
    asset: 'USDC',
    recipientMode: 'allowlist',
    agents: [h.managedAgent.address],
    approvers,
    approvalsRequired: o.approvalsRequired ?? approvers.length,
    guardians: [],
    executors: [...h.executors],
    recovery,
    recoveryThreshold: recovery.length === 0 ? 0 : (o.recoveryThreshold ?? recovery.length),
    limits: {
      totalBudget: usdc(CAP * 100n),
      perPaymentCap: usdc(CAP),
      perRecipientDailyCap: usdc(CAP * 5n),
      approvalThreshold: usdc(o.approvalThreshold ?? CAP + 1n),
      payoutTtlSeconds: 86_400,
      expiresAt,
    },
    attester: null,
    countryPolicyHash: bytes32('countries'),
    maxFeeBps: o.maxFeeBps ?? 100,
  };
  const salt = bytes32(o.salt ?? 'salt');
  await act(h, null, { op: 'create', factory: h.factory, config, salt }, principal);
  const address = h.mandateAddress(principal, salt);
  const ref: MandateRef = { network, address, specVersion: 1 };
  const recipients = [0, 1].map((i) => {
    const wallet = h.wallet(`recipient-${String(i)}`);
    return {
      recipientRef: bytes32(`recipient-${String(i)}`),
      methodId: h.recipientMethod({ address: wallet, tag: null }),
      address: wallet,
    };
  });
  await act(
    h,
    ref,
    {
      op: 'allow_recipients',
      entries: recipients.map((r) => ({
        recipientRef: r.recipientRef,
        destination: { address: r.address, tag: null },
      })),
    },
    principal,
  );
  if ((o.fund ?? CAP * 10n) > 0n) await h.fund(address, o.fund ?? CAP * 10n);
  return { ref, principal, approvers, recovery, recipients, expiresAt };
}

export interface PayOptions {
  readonly total?: bigint;
  readonly fee?: bigint;
  readonly signer?: SignerRef;
  readonly execute?: 'auto' | 'hold';
  readonly deadline?: UnixSeconds;
  readonly attempt?: number;
  readonly recipient?: number;
}

export async function payRequest(
  h: AdapterHarness,
  m: SuiteMandate,
  label: string,
  o: PayOptions = {},
): Promise<PayRequest> {
  const payoutId = bytes32(`payout:${label}`) as PayRequest['payoutId'];
  const r = must(m.recipients[o.recipient ?? 0], 'a recipient');
  const total = o.total ?? 1_000_000n;
  return {
    scope: h.scope,
    mandate: m.ref,
    payoutId,
    attempt: o.attempt ?? 1,
    recipientRef: r.recipientRef,
    taskRef: bytes32(`task:${label}`),
    total: usdc(total),
    fee: usdc(o.fee ?? 0n),
    legs: [
      {
        index: 0,
        legKey: `${payoutId}00` as LegKey,
        rail: 'stellar.wallet',
        recipientMethodId: r.methodId,
        amount: usdc(total),
        deliveryCurrency: 'USDC',
      },
    ],
    deadline: o.deadline ?? (((await now(h)) + 600n) as UnixSeconds),
    attestations: [],
    execute: o.execute ?? 'auto',
    signer: o.signer ?? h.managedAgent.ref,
  };
}

const RESTING: ReadonlySet<PayStep['kind']> = new Set([
  'final',
  'settled',
  'dead',
  'awaiting_approval',
  'held',
  'signature_required',
]);

/** Calls pay until the payout rests, and returns every step. */
export async function drive(
  adapter: ChainAdapter,
  req: PayRequest,
  max = 6,
): Promise<readonly PayStep[]> {
  const steps: PayStep[] = [];
  for (let i = 0; i < max; i += 1) {
    const step = await adapter.pay(req, OPTS);
    steps.push(step);
    if (RESTING.has(step.kind)) break;
  }
  return steps;
}

function last(steps: readonly PayStep[]): PayStep | undefined {
  return steps.at(-1);
}

/**
 * Registers the conformance suite for an adapter. The factory is called
 * once per case and must return a fresh world each time.
 */
export interface ConformanceOptions {
  /** Whether the harness offers fault controls; the fault cases run only then. */
  readonly faults: boolean;
}

export function describeChainAdapter(
  name: string,
  factory: AdapterHarnessFactory,
  options: ConformanceOptions,
): void {
  const setup = async (o: SuiteMandateOptions = {}) => {
    const h = await factory();
    return { h, m: await deployMandate(h, o) };
  };

  describe(`chain adapter conformance: ${name}`, () => {
    describe('identity, health and parsing', () => {
      it('names its network and chain and reports what it can do', async () => {
        const h = await factory();
        const { adapter } = h;
        expect(adapter.interfaceVersion).toBe(1);
        const caps = adapter.capabilities();
        expect(caps.network).toBe(adapter.network);
        expect(caps.settlementAssets).toEqual(['USDC']);
        expect(caps.maxBatch).toBeGreaterThanOrEqual(1);
        expect(caps.rails.map((r) => r.rail)).toContain('stellar.wallet');
        const health = await adapter.health(OPTS);
        expect(health).toMatchObject({
          network: adapter.network,
          state: 'healthy',
          signerHealthy: true,
        });
      });

      it('parses its own addresses and destinations and refuses anything else', async () => {
        const h = await factory();
        const wallet = h.wallet('someone');
        expect(h.adapter.parseAddress(wallet.value)).toEqual(wallet);
        expect(
          (await refusalOf(Promise.resolve().then(() => h.adapter.parseAddress('nope')))).code,
        ).toBe('INVALID_INPUT');
        expect(h.adapter.parseDestination({ address: wallet.value, memoId: '7' })).toEqual({
          address: wallet,
          tag: 7n,
        });
        const bad = await refusalOf(
          Promise.resolve().then(() =>
            h.adapter.parseDestination({ address: wallet.value, memoId: 'x' }),
          ),
        );
        expect(bad.toJSON()).toMatchObject({ code: 'INVALID_INPUT', reason: 'MEMO_NOT_ID' });
      });
    });

    describe('wallet proofs and destinations', () => {
      const requestFor = (h: AdapterHarness, wallet: ChainAddress) =>
        h.adapter.walletProofChallenge({
          network: h.adapter.network,
          address: wallet.value,
          purpose: 'payout_destination',
          recipientRef: `0x${'ab'.repeat(32)}`,
          tag: null,
          requestId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        });

      it('says what it can do', async () => {
        const caps = (await factory()).adapter.capabilities();
        expect(caps.walletProof).toBe(true);
        for (const flag of [caps.partnerAuth, caps.agentRegistry, caps.reserveSponsorship]) {
          expect(typeof flag).toBe('boolean');
        }
      });

      it('issues a challenge bound to the address, the network and a fresh nonce', async () => {
        const h = await factory();
        const wallet = h.wallet('prover');
        const first = requestFor(h, wallet);
        expect(first.text).toContain(wallet.value);
        expect(first.text).toContain(`Chain ID: ${h.adapter.network}`);
        expect(requestFor(h, wallet).nonce).not.toBe(first.nonce);
        const forged = await refusalOf(
          Promise.resolve().then(() =>
            h.adapter.walletProofChallenge({
              network: h.adapter.network,
              address: wallet.value,
              purpose: 'payout_destination',
              recipientRef: `0x${'ab'.repeat(32)}`,
              tag: null,
              requestId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
              host: 'evil.example',
            } as Parameters<typeof h.adapter.walletProofChallenge<'payout_destination'>>[0]),
          ),
        );
        expect(forged.code).toBe('INVALID_INPUT');
      });

      it('verifies a proof and refuses a changed text, another key and an expired challenge', async () => {
        const h = await factory();
        const wallet = h.wallet('prover');
        const challenge = requestFor(h, wallet);
        const signature = await h.signMessage(wallet, challenge.text);
        const verify = (signedText: string, signed: string) =>
          h.adapter.verifyWalletProof({ challenge, signedText, signature: signed }, OPTS);
        expect(await verify(challenge.text, signature)).toMatchObject({
          status: 'valid',
          signer: wallet.value,
        });
        const changed = `${challenge.text} `;
        expect(await verify(changed, await h.signMessage(wallet, changed))).toEqual({
          status: 'invalid',
          reason: 'MESSAGE_MISMATCH',
        });
        const other = await h.signMessage(h.wallet('someone else'), challenge.text);
        expect(await verify(challenge.text, other)).toEqual({
          status: 'invalid',
          reason: 'BAD_SIGNATURE',
        });
        await h.advance(3600n);
        expect(await verify(challenge.text, signature)).toEqual({
          status: 'invalid',
          reason: 'EXPIRED',
        });
      });

      it('checks a destination and whether a proof signer is current', async () => {
        const h = await factory();
        const wallet = h.wallet('recipient');
        expect(
          await h.adapter.checkDestination(
            { destination: { address: wallet, tag: null }, asset: 'USDC' },
            OPTS,
          ),
        ).toEqual({ receivable: true, proofSigner: 'not_applicable' });
        const check = (proofSigner: string) =>
          h.adapter.checkDestination(
            { destination: { address: wallet, tag: null }, asset: 'USDC', proofSigner },
            OPTS,
          );
        expect((await check(wallet.value)).proofSigner).toBe('current');
        expect((await check(h.wallet('stranger').value)).proofSigner).toBe('not_current');
        const bad = await refusalOf(
          h.adapter.checkDestination(
            {
              destination: { address: { network: h.adapter.network, value: 'nope' }, tag: null },
              asset: 'USDC',
            },
            OPTS,
          ),
        );
        expect(bad.code).toBe('INVALID_INPUT');
      });

      it('prepares a recipient activation for the recipient to sign, or says it cannot', async () => {
        const h = await factory();
        const wallet = h.wallet('new recipient');
        const req = {
          scope: h.scope,
          destination: { address: wallet, tag: null },
          asset: 'USDC',
          createAccount: false,
          reservationIds: [],
        } as const;
        if (!h.adapter.capabilities().reserveSponsorship) {
          const refused = await refusalOf(h.adapter.prepareRecipientActivation(req, OPTS));
          expect(refused.code).toBe('UNSUPPORTED');
          return;
        }
        const request = await h.adapter.prepareRecipientActivation(req, OPTS);
        expect(request).toMatchObject({ signer: wallet, summary: { feePaidBy: 'ujira' } });
        const signed = await h.sign(request, wallet);
        const submitted = await h.adapter.submitSigned(
          {
            scope: h.scope,
            requestId: request.requestId,
            signed,
            correlationId: OPTS.correlationId,
          },
          OPTS,
        );
        expect(submitted.network).toBe(h.adapter.network);
      });
    });

    describe('attestation messages', () => {
      it('builds the 47 byte message for its own network only', async () => {
        const { h, m } = await setup();
        const recipient = must(m.recipients[0], 'a recipient');
        const fields = {
          mandate: m.ref,
          recipientRef: recipient.recipientRef,
          countryPolicyHash: bytes32('countries'),
          policyEpoch: 0n,
          validUntil: await now(h),
          destination: { address: recipient.address, tag: 7n },
        };
        const message = h.adapter.attestationMessage(fields);
        expect(message.length).toBe(47);
        expect(h.adapter.attestationMessage(fields)).toEqual(message);
        const untagged = h.adapter.attestationMessage({
          ...fields,
          destination: { address: recipient.address, tag: null },
        });
        expect(untagged).not.toEqual(message);
        const other = must(
          NETWORK_IDS.find((n) => n !== h.adapter.network),
          'another network',
        );
        const elsewhere = { ...fields, mandate: { ...m.ref, network: other } };
        const refused = await refusalOf(
          Promise.resolve().then(() => h.adapter.attestationMessage(elsewhere)),
        );
        expect(refused.code).toBe('INVALID_INPUT');
      });
    });

    describe('mandates', () => {
      it('reads back the mandate it deployed', async () => {
        const { h, m } = await setup({ approvers: 1, recovery: 2 });
        const snap = await h.adapter.readMandate({ scope: h.scope, mandate: m.ref }, OPTS);
        expect(snap.trustedFactory).toBe(true);
        expect(snap.tenantTagMatches).toBe(true);
        expect(snap.config.principal).toEqual(m.principal);
        expect(snap.config.approvers).toEqual(m.approvers);
        expect(snap.config.recovery).toEqual(m.recovery);
        expect(snap.config.limits.perPaymentCap.amount).toBe(CAP);
        expect(snap.state.balance.amount).toBe(CAP * 10n);
        expect(snap.state.paused).toBe(false);
      });

      it('refuses every tenant scoped call from another tenant', async () => {
        const { h, m } = await setup();
        const other = h.otherScope;
        const req = { ...(await payRequest(h, m, 'tenant')), scope: other };
        const calls: Promise<unknown>[] = [
          h.adapter.readMandate({ scope: other, mandate: m.ref }, OPTS),
          h.adapter.fundingInstructions({ scope: other, mandate: m.ref }, OPTS),
          h.adapter.prepareFunding(
            { scope: other, mandate: m.ref, from: m.principal, amount: usdc(1n) },
            OPTS,
          ),
          h.adapter.prepareMandateAction(
            {
              scope: other,
              mandate: m.ref,
              action: { op: 'pause' },
              signer: external(h, m.principal),
            },
            OPTS,
          ),
          h.adapter.pay(req, OPTS),
          h.adapter.payBatch({ scope: other, mandate: m.ref, items: [req] }, OPTS),
          h.adapter.status(
            { scope: other, mandate: m.ref, payoutId: req.payoutId, legs: [] },
            OPTS,
          ),
          h.adapter.proveDead(
            { scope: other, mandate: m.ref, payoutId: req.payoutId, deadline: req.deadline },
            OPTS,
          ),
          h.adapter.receipt({ scope: other, mandate: m.ref, payoutId: req.payoutId }, OPTS),
        ];
        for (const call of calls) expect((await refusalOf(call)).code).toBe('TENANT_MISMATCH');
        const request = await h.adapter.prepareMandateAction(
          {
            scope: h.scope,
            mandate: m.ref,
            action: { op: 'pause' },
            signer: external(h, m.principal),
          },
          OPTS,
        );
        const signed = await h.sign(request, m.principal);
        const stolen = h.adapter.submitSigned(
          { scope: other, requestId: request.requestId, signed, correlationId: 'x' },
          OPTS,
        );
        expect((await refusalOf(stolen)).code).toBe('TENANT_MISMATCH');
      });

      it('checks a signed payload against the request it built', async () => {
        const { h, m } = await setup();
        const prepare = (action: MandateAction = { op: 'pause' }) =>
          h.adapter.prepareMandateAction(
            { scope: h.scope, mandate: m.ref, action, signer: external(h, m.principal) },
            OPTS,
          );
        const request = await prepare();
        expect(request.summary).toMatchObject({ action: 'pause', feePaidBy: 'ujira' });
        const submit = (signed: string, requestId = request.requestId) =>
          h.adapter.submitSigned({ scope: h.scope, requestId, signed, correlationId: 'c' }, OPTS);
        const byStranger = await h.sign(request, h.wallet('stranger'));
        expect((await refusalOf(submit(byStranger))).code).toBe('SIGNED_PAYLOAD_MISMATCH');
        expect((await refusalOf(submit('garbage'))).code).toBe('SIGNED_PAYLOAD_MISMATCH');
        const other = await prepare();
        const crossed = await h.sign(other, m.principal);
        expect((await refusalOf(submit(crossed))).code).toBe('SIGNED_PAYLOAD_MISMATCH');
        const signed = await h.sign(request, m.principal);
        const first = await submit(signed);
        expect(first.finality).not.toBe('none');
        // The same signed payload again reports the same submission.
        expect(await submit(signed)).toEqual(first);
        expect((await refusalOf(submit(`${signed}x`))).code).toBe('SIGNED_PAYLOAD_MISMATCH');
        expect((await refusalOf(submit(signed, 'request-unknown'))).code).toBe('INVALID_INPUT');
        const late = await prepare({ op: 'resume' });
        await h.advance(3_600n);
        expect(
          (await refusalOf(submit(await h.sign(late, m.principal), late.requestId))).code,
        ).toBe('SIGNING_REQUEST_EXPIRED');
      });

      it('refuses callers the mandate does not authorize', async () => {
        const { h, m } = await setup();
        const stranger = h.wallet('stranger');
        // A call that takes a caller argument: the mandate's own refusal.
        const pause = await refusalOf(act(h, m.ref, { op: 'pause' }, stranger, 'guardian'));
        expect(pause).toMatchObject({ code: 'MANDATE_RULE', specCode: 10, retryable: false });
        // A call only the principal may make: the host refuses the signature.
        const limits = await refusalOf(
          act(h, m.ref, { op: 'set_approvals_required', n: 0 }, stranger),
        );
        expect(limits.code).toBe('SUBMISSION_REJECTED');
        const resume = await refusalOf(act(h, m.ref, { op: 'resume' }, m.principal));
        expect(resume).toMatchObject({ code: 'MANDATE_RULE', specName: 'NOT_PAUSED' });
      });

      it('runs the fee cap, principal proposal and recovery actions', async () => {
        const { h, m } = await setup({ recovery: 2, maxFeeBps: 50 });
        const read = () => h.adapter.readMandate({ scope: h.scope, mandate: m.ref }, OPTS);
        await act(h, m.ref, { op: 'lower_fee_cap', maxFeeBps: 20 }, m.principal);
        expect((await read()).config.maxFeeBps).toBe(20);
        const raise = await refusalOf(
          act(h, m.ref, { op: 'lower_fee_cap', maxFeeBps: 30 }, m.principal),
        );
        expect(raise).toMatchObject({ code: 'MANDATE_RULE', specName: 'CONFIG_INVALID' });

        const none = await refusalOf(
          act(h, m.ref, { op: 'cancel_principal_proposal' }, m.principal),
        );
        expect(none).toMatchObject({ code: 'MANDATE_RULE', specName: 'CONFIG_INVALID' });
        const next = h.wallet('next-principal');
        await act(h, m.ref, { op: 'propose_principal', proposed: next }, m.principal);
        expect((await read()).config.proposedPrincipal).toEqual(next);
        await act(h, m.ref, { op: 'cancel_principal_proposal' }, m.principal);
        expect((await read()).config.proposedPrincipal).toBe(null);

        await act(h, m.ref, { op: 'set_recovery_threshold', n: 1 }, m.principal);
        expect((await read()).config.recoveryThreshold).toBe(1);
        await act(h, m.ref, { op: 'set_recovery_threshold', n: 2 }, m.principal);
        const [first, second] = [must(m.recovery[0], 'a member'), must(m.recovery[1], 'a member')];
        const agent = h.managedAgent.address;
        const rotate: MandateAction = { op: 'recovery_rotate_agent', old: agent, new: null };
        await act(h, m.ref, rotate, first, 'recovery');
        expect((await read()).config.agents).toEqual([agent]);
        await act(h, m.ref, rotate, second, 'recovery');
        expect((await read()).config.agents).toEqual([]);
        const again = await refusalOf(
          act(h, m.ref, { op: 'recovery_revoke' }, h.wallet('stranger'), 'recovery'),
        );
        expect(again).toMatchObject({ code: 'MANDATE_RULE', specName: 'UNAUTHORIZED' });
        await act(h, m.ref, { op: 'recovery_revoke' }, first, 'recovery');
        expect((await read()).state.revoked).toBe(false);
        await act(h, m.ref, { op: 'recovery_revoke' }, second, 'recovery');
        expect((await read()).state.revoked).toBe(true);
      });
    });

    describe('the pay step function', () => {
      it('requests, executes and settles exactly once', async () => {
        const { h, m } = await setup();
        const req = await payRequest(h, m, 'happy', { fee: 5_000n });
        const recipient = must(m.recipients[0], 'a recipient').address;
        const before = await h.balance(recipient);
        const steps = await drive(h.adapter, req);
        expect(steps.map((s) => s.kind)).toEqual(['submitted', 'submitted', 'final']);
        expect(steps.slice(0, 2)).toMatchObject([
          { kind: 'submitted', op: 'request' },
          { kind: 'submitted', op: 'execute' },
        ]);
        const done = last(steps);
        const doneReceipt = finalReceipt(done);
        expect(doneReceipt.total.amount).toBe(1_000_000n);
        expect(doneReceipt.legs).toEqual([
          { index: 0, destination: recipient, amount: usdc(1_000_000n) },
        ]);
        // Every later call answers from the chain and pays nothing more.
        for (let i = 0; i < 3; i += 1) {
          expect(await h.adapter.pay(req, OPTS)).toEqual(done);
          expect(await h.restart().pay(req, OPTS)).toEqual(done);
        }
        expect((await h.balance(recipient)) - before).toBe(1_000_000n);
        const receipt = await h.adapter.receipt(
          { scope: h.scope, mandate: m.ref, payoutId: req.payoutId },
          OPTS,
        );
        expect(receipt).toEqual(doneReceipt);
        expect(await h.adapter.verifyReceipt(receipt.ref, OPTS)).toEqual({ ok: true, receipt });
      });

      it('moves every submission forward only and leaves none live', async () => {
        const { h, m } = await setup();
        await drive(h.adapter, await payRequest(h, m, 'forward'));
        const moves = h.moves();
        expect(moves.length).toBeGreaterThan(0);
        for (const move of moves) {
          if (move.from === null) expect(move.to).toBe('built');
          else expect(SUBMISSION_TRANSITIONS[move.from]).toContain(move.to);
        }
        expect(await h.store.unresolvedSubmissions(h.adapter.network, 0, 100)).toEqual([]);
      });

      it('releases every executor lease it takes', async () => {
        const { h, m } = await setup();
        await drive(h.adapter, await payRequest(h, m, 'lease'));
        const leases: ExecutorLease[] = [];
        while (leases.length < h.executors.length) {
          leases.push(await h.store.leaseExecutor(h.adapter.network, 30));
        }
        expect(new Set(leases.map((l) => l.address.value)).size).toBe(h.executors.length);
        for (const lease of leases) {
          await h.store.releaseExecutor(lease, { sequenceOrNonce: lease.sequenceOrNonce });
        }
      });

      it('waits for approval, then executes once approved', async () => {
        const { h, m } = await setup({ approvers: 1, approvalThreshold: 1n });
        const req = await payRequest(h, m, 'approval');
        expect(last(await drive(h.adapter, req))).toEqual({
          kind: 'awaiting_approval',
          approvals: { count: 0, required: 1 },
        });
        const approver = must(m.approvers[0], 'an approver');
        await act(h, m.ref, { op: 'approve', payoutId: req.payoutId }, approver, 'approver');
        expect(last(await drive(h.adapter, req))?.kind).toBe('final');
      });

      // The mandate voids an approval with its approver's seat, and adding them back does
      // not revive it, so counting the list would show a payout as closer than it is.
      it('counts only the approvals the mandate would count', async () => {
        const { h, m } = await setup({ approvers: 3, approvalsRequired: 2, approvalThreshold: 1n });
        const req = await payRequest(h, m, 'live approvals');
        const approver = must(m.approvers[0], 'an approver');
        const approve = () =>
          act(h, m.ref, { op: 'approve', payoutId: req.payoutId }, approver, 'approver');
        const stepShows = async (count: number) => {
          expect(last(await drive(h.adapter, req))).toEqual({
            kind: 'awaiting_approval',
            approvals: { count, required: 2 },
          });
          const status = await h.adapter.status(
            { scope: h.scope, mandate: m.ref, payoutId: req.payoutId, legs: [] },
            OPTS,
          );
          expect(status.approvals).toEqual({ count, required: 2 });
        };
        await stepShows(0);
        await approve();
        await stepShows(1);
        const change = { role: 'approver' as const, account: approver };
        await act(h, m.ref, { op: 'remove_role', ...change }, m.principal);
        await stepShows(0);
        await act(h, m.ref, { op: 'add_role', ...change }, m.principal);
        await stepShows(0);
        await approve();
        await stepShows(1);
      });

      it('holds an approved payout until asked to execute', async () => {
        const { h, m } = await setup();
        const req = await payRequest(h, m, 'hold', { execute: 'hold' });
        expect(last(await drive(h.adapter, req))).toEqual({ kind: 'held' });
        expect(last(await drive(h.adapter, { ...req, execute: 'auto' }))?.kind).toBe('final');
      });

      it('asks an agent wallet to sign, once, and continues after it does', async () => {
        const { h, m } = await setup();
        const agentWallet = h.wallet('agent-wallet');
        await act(h, m.ref, { op: 'add_role', role: 'agent', account: agentWallet }, m.principal);
        const req = await payRequest(h, m, 'wallet', { signer: external(h, agentWallet, 'agent') });
        const first = await h.adapter.pay(req, OPTS);
        expect(await h.adapter.pay(req, OPTS)).toEqual(first);
        const request = must('request' in first ? first.request : null, 'a signature request');
        expect(first.kind).toBe('signature_required');
        expect(request.summary).toMatchObject({ action: 'request_payout' });
        await h.adapter.submitSigned(
          {
            scope: h.scope,
            requestId: request.requestId,
            signed: await h.sign(request, agentWallet),
            correlationId: 'c',
          },
          OPTS,
        );
        expect(last(await drive(h.adapter, req))?.kind).toBe('final');
      });

      it('refuses a fee above the cap before anything is signed or recorded', async () => {
        const { h, m } = await setup({ maxFeeBps: 10 });
        const req = await payRequest(h, m, 'fee', { total: 1_000_000n, fee: 1_001n });
        const recorded = h.moves().length;
        const error = await refusalOf(h.adapter.pay(req, OPTS));
        expect(error).toMatchObject({
          code: 'MANDATE_RULE',
          specCode: 46,
          retryable: false,
          landed: 'no',
        });
        const live = await h.store.liveSubmission({
          scope: h.scope,
          network: h.adapter.network,
          mandate: m.ref.address.value,
          payoutId: req.payoutId,
          op: 'request',
        });
        expect(live).toBe(null);
        expect(h.moves().length).toBe(recorded);
      });

      it('checks the fee cap again before execution', async () => {
        const { h, m } = await setup({ maxFeeBps: 100 });
        const req = await payRequest(h, m, 'lowered', { fee: 10_000n, execute: 'hold' });
        expect(last(await drive(h.adapter, req))?.kind).toBe('held');
        await act(h, m.ref, { op: 'lower_fee_cap', maxFeeBps: 50 }, m.principal);
        const error = await refusalOf(h.adapter.pay({ ...req, execute: 'auto' }, OPTS));
        expect(error).toMatchObject({ code: 'MANDATE_RULE', specCode: 46, retryable: false });
      });

      it('gives errors 26, 27 and 65 no retry and no wait', async () => {
        const { h, m } = await setup();
        const req = await payRequest(h, m, 'removed', { execute: 'hold' });
        expect(last(await drive(h.adapter, req))?.kind).toBe('held');
        const agent = h.managedAgent.address;
        await act(h, m.ref, { op: 'remove_role', role: 'agent', account: agent }, m.principal);
        const removed = await refusalOf(h.adapter.pay({ ...req, execute: 'auto' }, OPTS));
        expect(removed).toMatchObject({
          code: 'MANDATE_RULE',
          specCode: 65,
          specName: 'AGENT_REMOVED',
        });
        expect(removed).toMatchObject({ retryable: false, waitFor: 'none', landed: 'no' });

        await h.advance(m.expiresAt - (await now(h)) + 1n);
        const sweeper = h.wallet('sweeper');
        const grace = await refusalOf(act(h, m.ref, { op: 'sweep' }, sweeper, 'guardian'));
        expect(grace).toMatchObject({ specCode: 27, specName: 'SWEEP_GRACE_PERIOD' });
        expect(grace).toMatchObject({ retryable: false, waitFor: 'none' });
        await act(h, m.ref, { op: 'propose_principal', proposed: h.wallet('heir') }, m.principal);
        await h.advance(31n * DAY);
        const pending = await refusalOf(act(h, m.ref, { op: 'sweep' }, sweeper, 'guardian'));
        expect(pending).toMatchObject({ specCode: 26, specName: 'PRINCIPAL_CHANGE_PENDING' });
        expect(pending).toMatchObject({ retryable: false, waitFor: 'none' });
        await act(h, m.ref, { op: 'cancel_principal_proposal' }, m.principal);
        await act(h, m.ref, { op: 'sweep' }, sweeper, 'guardian');
        expect(await h.balance(m.ref.address)).toBe(0n);
      });

      it('tells a job what to wait for when the mandate can recover', async () => {
        const { h, m } = await setup({ fund: 0n });
        const broke = await refusalOf(h.adapter.pay(await payRequest(h, m, 'broke'), OPTS));
        expect(broke).toMatchObject({
          specName: 'INSUFFICIENT_FUNDS',
          retryable: true,
          waitFor: 'funding',
        });
        await h.fund(m.ref.address, CAP);
        await act(h, m.ref, { op: 'pause' }, m.principal);
        const paused = await refusalOf(h.adapter.pay(await payRequest(h, m, 'paused'), OPTS));
        expect(paused).toMatchObject({
          specName: 'MANDATE_PAUSED',
          retryable: true,
          waitFor: 'resume',
        });
      });

      it('proves an attempt dead only when it can never land', async () => {
        const { h, m } = await setup();
        const req = await payRequest(h, m, 'late');
        const prove = (r: PayRequest) =>
          h.adapter.proveDead(
            { scope: h.scope, mandate: m.ref, payoutId: r.payoutId, deadline: r.deadline },
            OPTS,
          );
        expect(await prove(req)).toBe(null);
        await h.advance(601n);
        const dead = await prove(req);
        expect(dead).toMatchObject({ kind: 'deadline_passed', network: h.adapter.network });
        expect(last(await drive(h.adapter, req))).toEqual({ kind: 'dead', proof: dead });

        const held = await payRequest(h, m, 'cancelled', { execute: 'hold' });
        await drive(h.adapter, held);
        expect(await prove(held)).toBe(null);
        await act(h, m.ref, { op: 'cancel', payoutId: held.payoutId }, m.principal);
        const tombstone = await prove(held);
        expect(tombstone).toMatchObject({ kind: 'tombstone', status: 'cancelled' });
        expect(last(await drive(h.adapter, held))).toEqual({ kind: 'dead', proof: tombstone });
      });

      it('reports the payout status table', async () => {
        const { h, m } = await setup({ approvers: 1, approvalThreshold: 2_000_000n });
        const status = (r: PayRequest) =>
          h.adapter.status(
            {
              scope: h.scope,
              mandate: m.ref,
              payoutId: r.payoutId,
              legs: r.legs.map((l) => l.legKey),
            },
            OPTS,
          );
        const small = await payRequest(h, m, 'small', { execute: 'hold' });
        expect(await status(small)).toMatchObject({
          onChain: 'absent',
          finality: 'none',
          lapsed: false,
          legs: [],
        });
        await drive(h.adapter, small);
        expect(await status(small)).toMatchObject({ onChain: 'approved', lapsed: false });
        const big = await payRequest(h, m, 'big', { total: 3_000_000n });
        await drive(h.adapter, big);
        expect(await status(big)).toMatchObject({
          onChain: 'pending',
          approvals: { count: 0, required: 1 },
          legs: [{ legKey: big.legs[0]?.legKey, rail: 'stellar.wallet', state: 'not_applicable' }],
        });
        await act(h, m.ref, { op: 'reject', payoutId: big.payoutId }, m.principal);
        expect(await status(big)).toMatchObject({ onChain: 'rejected' });
        const done = await payRequest(h, m, 'done');
        await drive(h.adapter, done);
        const executed = await status(done);
        expect(executed).toMatchObject({ onChain: 'executed', finality: 'final' });
        expect(executed.receipt).toMatch(/^ujira:tx:v1:/);
        await h.advance(DAY + 1n);
        expect(await status(small)).toMatchObject({ onChain: 'approved', lapsed: true });
        const lapsed = await refusalOf(h.adapter.pay({ ...small, execute: 'auto' }, OPTS));
        expect(lapsed).toMatchObject({ specName: 'PAYOUT_LAPSED', retryable: false });
      });

      it('verifies receipts and refuses ones that do not hold', async () => {
        const { h, m } = await setup();
        const req = await payRequest(h, m, 'verify');
        const ref = finalReceipt(last(await drive(h.adapter, req))).ref;
        const tampered = ref.replace(/:(\d+)$/, ':9') as typeof ref;
        expect(await h.adapter.verifyReceipt(tampered, OPTS)).toEqual({
          ok: false,
          reason: 'mismatch',
        });
        const unknown = ref.replace(/:[0-9a-f]{64}:/, `:${'0'.repeat(64)}:`) as typeof ref;
        expect(await h.adapter.verifyReceipt(unknown, OPTS)).toEqual({
          ok: false,
          reason: 'not_found',
        });
        const missing = await refusalOf(
          h.adapter.receipt(
            {
              scope: h.scope,
              mandate: m.ref,
              payoutId: bytes32('never') as PayRequest['payoutId'],
            },
            OPTS,
          ),
        );
        expect(missing.code).toBe('INVALID_INPUT');
      });

      it('validates a pay request before it reaches the chain', async () => {
        const { h, m } = await setup();
        const req = await payRequest(h, m, 'invalid');
        const leg = must(req.legs[0], 'one leg');
        const bad: PayRequest[] = [
          { ...req, legs: [{ ...leg, amount: usdc(1n) }] },
          { ...req, legs: [] },
          { ...req, legs: [{ ...leg, legKey: `${bytes32('x')}00` as LegKey }] },
          { ...req, attempt: 0 },
        ];
        for (const r of bad)
          expect((await refusalOf(h.adapter.pay(r, OPTS))).code).toBe('INVALID_INPUT');
      });

      it('pays a batch: one request and one execution for every item', async () => {
        const { h, m } = await setup();
        const items = await Promise.all(
          ['b1', 'b2', 'b3'].map((label, i) => payRequest(h, m, label, { recipient: i % 2 })),
        );
        const first = await h.adapter.payBatch({ scope: h.scope, mandate: m.ref, items }, OPTS);
        expect(first.submissions.length).toBe(2);
        expect(first.items.map((i) => i.step.kind)).toEqual([
          'submitted',
          'submitted',
          'submitted',
        ]);
        const second = await h.adapter.payBatch({ scope: h.scope, mandate: m.ref, items }, OPTS);
        expect(second.submissions).toEqual([]);
        expect(second.items.map((i) => i.step.kind)).toEqual(['final', 'final', 'final']);
      });
    });

    describe('deposits and quotes', () => {
      it('finds deposits to watched mandates and pages through them', async () => {
        const { h, m } = await setup();
        const watched = (address: ChainAddress) =>
          Promise.resolve(
            address.value === m.ref.address.value
              ? { scope: h.scope, mandate: m.ref, asset: 'USDC' as const }
              : null,
          );
        const info = await h.adapter.fundingInstructions({ scope: h.scope, mandate: m.ref }, OPTS);
        expect(info).toMatchObject({ address: m.ref.address, asset: 'USDC', memoRequired: false });
        const page = await h.adapter.scanDeposits(
          { cursor: null, limit: 1000, isWatched: watched },
          OPTS,
        );
        expect(page.deposits.map((d) => d.amount)).toEqual([usdc(CAP * 10n)]);
        expect(page.deposits[0]?.scope).toEqual(h.scope);
        await h.fund(m.ref.address, 5n);
        const next = await h.adapter.scanDeposits(
          { cursor: page.nextCursor, limit: 10, isWatched: watched },
          OPTS,
        );
        expect(next.deposits.map((d) => d.amount.amount)).toEqual([5n]);
        const broke = h.adapter.prepareFunding(
          { scope: h.scope, mandate: m.ref, from: m.principal, amount: usdc(1n) },
          OPTS,
        );
        expect((await refusalOf(broke)).code).toBe('SUBMISSION_REJECTED');
        await h.fund(m.principal, 3n);
        const request = await h.adapter.prepareFunding(
          { scope: h.scope, mandate: m.ref, from: m.principal, amount: usdc(2n) },
          OPTS,
        );
        expect(request.summary).toMatchObject({ action: 'fund', feePaidBy: 'ujira' });
        await h.adapter.submitSigned(
          {
            scope: h.scope,
            requestId: request.requestId,
            signed: await h.sign(request, m.principal),
            correlationId: 'fund',
          },
          OPTS,
        );
        const funded = await h.adapter.scanDeposits(
          { cursor: next.nextCursor, limit: 10, isWatched: watched },
          OPTS,
        );
        expect(funded.deposits.map((d) => [d.from, d.amount.amount])).toEqual([[m.principal, 2n]]);
        const limit = h.adapter.scanDeposits({ cursor: null, limit: 0, isWatched: watched }, OPTS);
        expect((await refusalOf(limit)).code).toBe('INVALID_INPUT');
      });

      it('quotes the wallet rail at par', async () => {
        const h = await factory();
        const quote = await h.adapter.quote(
          {
            scope: h.scope,
            rail: 'stellar.wallet',
            country: 'NG' as CountryCode,
            sell: { asset: 'USDC' },
            buy: { currency: 'USDC' },
            amount: { side: 'sell', value: usdc(5_000_000n) },
            firm: true,
          },
          OPTS,
        );
        expect(quote).toMatchObject({ source: 'par', sell: usdc(5_000_000n), fees: [] });
        expect(quote.buy.amount).toBe(5_000_000n);
      });
    });

    describe.runIf(options.faults)('faults', () => {
      const withFaults = async () => {
        const { h, m } = await setup();
        return { h, m, faults: must(h.faults, 'fault controls') };
      };

      it('reports a chain outage without sending anything', async () => {
        const w = await withFaults();
        w.faults.chainDown();
        expect((await w.h.adapter.health(OPTS)).state).toBe('down');
        const error = await refusalOf(w.h.adapter.pay(await payRequest(w.h, w.m, 'down'), OPTS));
        expect(error).toMatchObject({ code: 'CHAIN_UNAVAILABLE', retryable: true, landed: 'no' });
        w.faults.chainDown(false);
        expect(last(await drive(w.h.adapter, await payRequest(w.h, w.m, 'up')))?.kind).toBe(
          'final',
        );
      });

      it('reconciles a timeout after landing without paying twice', async () => {
        const w = await withFaults();
        const req = await payRequest(w.h, w.m, 'timeout');
        const recipient = must(w.m.recipients[0], 'a recipient').address;
        const before = await w.h.balance(recipient);
        w.faults.timeoutAfterLanding(2);
        const first = await refusalOf(w.h.adapter.pay(req, OPTS));
        expect(first).toMatchObject({ code: 'RPC_TIMEOUT', landed: 'unknown', retryable: true });
        const second = await refusalOf(w.h.restart().pay(req, OPTS));
        expect(second.code).toBe('RPC_TIMEOUT');
        expect(last(await drive(w.h.restart(), req))?.kind).toBe('final');
        expect((await w.h.balance(recipient)) - before).toBe(1_000_000n);
        expect(w.h.moves().some((mv) => mv.from === 'unknown' && mv.to === 'landed')).toBe(true);
      });

      it('refuses reads while the RPC lags and degrades health', async () => {
        const w = await withFaults();
        w.faults.rpcLag(120);
        expect((await w.h.adapter.health(OPTS)).state).toBe('degraded');
        const error = await refusalOf(
          w.h.adapter.readMandate({ scope: w.h.scope, mandate: w.m.ref }, OPTS),
        );
        expect(error).toMatchObject({ code: 'RPC_LAGGING', retryable: true });
        w.faults.rpcLag(0);
      });

      it('reports a signer outage as retryable and degrades health', async () => {
        const w = await withFaults();
        w.faults.signerDown();
        const health = await w.h.adapter.health(OPTS);
        expect(health).toMatchObject({ state: 'degraded', signerHealthy: false });
        const error = await refusalOf(w.h.adapter.pay(await payRequest(w.h, w.m, 'signer'), OPTS));
        expect(error).toMatchObject({ code: 'SIGNER_UNAVAILABLE', retryable: true, landed: 'no' });
      });

      it('refuses a sponsored action when sponsorship is denied', async () => {
        const w = await withFaults();
        w.faults.sponsorDenied();
        const error = await refusalOf(act(w.h, w.m.ref, { op: 'pause' }, w.m.principal));
        expect(error).toMatchObject({ code: 'SPONSOR_DENIED', retryable: false });
      });

      it('maps a refused transfer to TRANSFER_FAILED', async () => {
        const w = await withFaults();
        const recipient = must(w.m.recipients[0], 'a recipient').address;
        w.faults.transferFails(recipient);
        const req = await payRequest(w.h, w.m, 'refused');
        const error = await refusalOf(drive(w.h.adapter, req));
        expect(error).toMatchObject({ code: 'MANDATE_RULE', specCode: 72, retryable: false });
        w.faults.transferFails(recipient, false);
        expect(last(await drive(w.h.adapter, req))?.kind).toBe('final');
      });
    });
  });
}
