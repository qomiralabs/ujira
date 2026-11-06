// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { Address, Keypair, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import type { Transaction } from '@stellar/stellar-sdk/base';
import { tokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import {
  InternalError,
  InvalidInputError,
  MandateRuleError,
  MandateUntrustedError,
  SponsorDeniedError,
  SubmissionRejectedError,
} from '../errors.js';
import { tenantRefOf, tenantTagOf } from '../tenant-ref.js';
import { PUBLIC_TEST_ATTESTER_KEYS } from '../test-attester-keys.js';
import type {
  Bytes32,
  ChainAddress,
  MandateAction,
  MandateActionRequest,
  PayoutId,
  SigningRequest,
  UnixSeconds,
} from '../types.js';
import { addressXdr } from './address-xdr.js';
import { mandateAddressOf } from './mandate-address.js';
import { asBytes32, field, fieldsOf } from './scval.js';
import { NETWORK, OPTS, addAccount, setup } from './test-adapter.js';
import type { TestSetup } from './test-adapter.js';
import { FIXTURE_FACTORY, FIXTURE_USDC, invoked } from './test-rpc.js';
import { PASSPHRASES } from './tx.js';

const at = (value: string): ChainAddress => ({ network: NETWORK, value });
const ID = `0x${'ab'.repeat(32)}` as PayoutId;
const REF = `0x${'cd'.repeat(32)}` as Bytes32;
const usdc = (n: bigint) => tokenAmount(n, 'USDC', 'stellar');
const LIMITS = {
  totalBudget: usdc(1000n),
  perPaymentCap: usdc(100n),
  perRecipientDailyCap: usdc(200n),
  approvalThreshold: usdc(10n),
  payoutTtlSeconds: 86_400,
  expiresAt: 1_800_000_000n as UnixSeconds,
};

function request(
  t: TestSetup,
  action: MandateAction,
  signer = t.principal.publicKey(),
): MandateActionRequest {
  return {
    scope: t.scope,
    mandate: action.op === 'create' ? null : t.mandate,
    action,
    signer: { kind: 'external', network: NETWORK, role: 'principal', address: at(signer) },
  };
}

function callOf(signing: SigningRequest) {
  if (signing.kind !== 'stellar_transaction') throw new Error('expected a transaction');
  return invoked(TransactionBuilder.fromXdr(signing.xdr, PASSPHRASES[NETWORK]) as Transaction);
}

function settingAttester(t: TestSetup, attester: Uint8Array): readonly MandateAction[] {
  return [
    { op: 'set_attestation_policy', attester, countryPolicyHash: REF },
    {
      op: 'create',
      factory: at(FIXTURE_FACTORY),
      salt: REF,
      config: {
        principal: at(t.principal.publicKey()),
        asset: 'USDC',
        recipientMode: 'both',
        agents: [],
        approvers: [],
        approvalsRequired: 0,
        guardians: [],
        executors: [],
        recovery: [],
        recoveryThreshold: 0,
        limits: LIMITS,
        attester,
        countryPolicyHash: REF,
        maxFeeBps: 100,
      },
    },
  ];
}

describe('an allowlist entry that can never pay out', { timeout: 30_000 }, () => {
  const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const entry = (value: string, tag: bigint | null = null) => ({
    recipientRef: REF,
    destination: { address: at(value), tag },
  });
  const allow = (value: string, tag: bigint | null = null) => ({
    op: 'allow_recipients' as const,
    entries: [entry(value, tag)],
  });

  // The contract refuses every one of these but the issuer, and in allowlist mode no
  // attester looks at the destination, so a transfer to the issuer would be burned.
  it.each([
    ['the settlement asset issuer', () => allow(ISSUER)],
    ['the issuer under a tag', () => allow(ISSUER, 7n)],
    ['the settlement asset contract', () => allow(FIXTURE_USDC)],
    ['a trusted factory', () => allow(FIXTURE_FACTORY)],
  ])('is refused, with nothing built to sign: %s', async (_label, action) => {
    const t = setup();
    const simulated = t.rpc.simulated.length;
    const run = t.adapter.prepareMandateAction(request(t, action()), OPTS);
    await expect(run).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run).rejects.toMatchObject({ issues: ['entries.destination (unpayable)'] });
    expect(t.rpc.simulated).toHaveLength(simulated);
  });

  it('is refused when it is the mandate itself', async () => {
    const t = setup();
    await expect(
      t.adapter.prepareMandateAction(request(t, allow(t.mandate.address.value)), OPTS),
    ).rejects.toMatchObject({ issues: ['entries.destination (unpayable)'] });
  });

  // A principal can list the issuer by calling the contract directly. Refusing this
  // too would leave them no way through UJIRA to take it back off.
  it('can still be taken off the list', async () => {
    const t = setup();
    const signing = await t.adapter.prepareMandateAction(
      request(t, { op: 'disallow_recipients', entries: [entry(ISSUER)] }),
      OPTS,
    );
    expect(signing.kind).toBe('stellar_transaction');
  });
});

describe.each(PUBLIC_TEST_ATTESTER_KEYS)(
  'preparing an action that sets the public test key %s as the attester',
  { timeout: 30_000 },
  (key) => {
    const attester = Uint8Array.from(Buffer.from(key, 'hex'));

    it.each([
      ['production', 'production'],
      ['staging', 'staging'],
      ['an environment left out', undefined],
    ])('is refused in %s, with nothing built to sign', async (_label, nodeEnv) => {
      const t = setup(nodeEnv === undefined ? {} : { nodeEnv });
      for (const action of settingAttester(t, attester)) {
        const simulated = t.rpc.simulated.length;
        const run = t.adapter.prepareMandateAction(request(t, action), OPTS);
        await expect(run, action.op).rejects.toBeInstanceOf(InvalidInputError);
        await expect(run, action.op).rejects.toMatchObject({
          issues: ['attester (test_key)'],
          network: NETWORK,
        });
        expect(t.rpc.simulated.length, action.op).toBe(simulated);
      }
    });

    it('builds in a test', async () => {
      const t = setup({ nodeEnv: 'test' });
      for (const action of settingAttester(t, attester)) {
        const signing = await t.adapter.prepareMandateAction(request(t, action), OPTS);
        expect(signing.summary.action, action.op).toBe(action.op);
      }
    });
  },
);

describe('preparing an action with an attester of its own', { timeout: 30_000 }, () => {
  it('builds in production', async () => {
    const t = setup({ nodeEnv: 'production' });
    for (const action of settingAttester(t, new Uint8Array(32).fill(9))) {
      const signing = await t.adapter.prepareMandateAction(request(t, action), OPTS);
      expect(signing.summary.action, action.op).toBe(action.op);
    }
  });
});

// Building and parsing XDR is slow on a loaded machine, so each test gets
// more than the default five seconds.
describe('prepareMandateAction', { timeout: 30_000 }, () => {
  it('each of the five new actions and the recovery role build and simulate', async () => {
    const t = setup();
    const member = Keypair.random();
    addAccount(t.rpc, member.publicKey(), 7n);
    const agent = 'GAKNCMAXVSDXSSCG544P4E4CADBRGDHCCQX75U5KCTPHHOGDW6RPQQFG';
    const cases: [MandateAction, string, string, number][] = [
      [
        { op: 'set_recovery_threshold', n: 2 },
        t.principal.publicKey(),
        'set_recovery_threshold',
        1,
      ],
      [{ op: 'lower_fee_cap', maxFeeBps: 40 }, t.principal.publicKey(), 'lower_fee_cap', 1],
      [
        { op: 'cancel_principal_proposal' },
        t.principal.publicKey(),
        'cancel_principal_proposal',
        0,
      ],
      [{ op: 'recovery_revoke' }, member.publicKey(), 'recovery_revoke', 1],
      [
        { op: 'recovery_rotate_agent', old: at(agent), new: null },
        member.publicKey(),
        'recovery_rotate_agent',
        3,
      ],
      [
        { op: 'recovery_rotate_agent', old: at(agent), new: at(member.publicKey()) },
        member.publicKey(),
        'recovery_rotate_agent',
        3,
      ],
      [
        { op: 'add_role', role: 'recovery', account: at(member.publicKey()) },
        t.principal.publicKey(),
        'add_role',
        2,
      ],
      [
        { op: 'remove_role', role: 'recovery', account: at(member.publicKey()) },
        t.principal.publicKey(),
        'remove_role',
        2,
      ],
    ];
    for (const [action, signer, fn, argCount] of cases) {
      const before = t.rpc.simulated.length;
      const signing = await t.adapter.prepareMandateAction(request(t, action, signer), OPTS);
      const call = callOf(signing);
      expect(call.fn).toBe(fn);
      expect(call.contract).toBe(t.mandate.address.value);
      expect(call.args).toHaveLength(argCount);
      expect(t.rpc.simulated.length).toBe(before + 1);
      expect(signing).toMatchObject({ signer: at(signer), sponsored: true });
      // Recovery calls name their signer as the caller, so the signer's own
      // transaction authorizes them.
      if (fn.startsWith('recovery_')) {
        const [caller] = call.args;
        expect(
          caller?.type === 'scvAddress' && Address.fromScAddress(caller.address).toString(),
        ).toBe(signer);
      }
    }
    const role = callOf(
      await t.adapter.prepareMandateAction(
        request(t, { op: 'add_role', role: 'recovery', account: at(member.publicKey()) }),
        OPTS,
      ),
    ).args[0];
    expect(role?.type === 'scvU32' && role.u32).toBe(5);
  });

  it('builds every other action as the mandate call it names', async () => {
    const t = setup();
    t.rpc.options.proposed = t.principal.publicKey();
    const tagged = { address: at(t.principal.publicKey()), tag: 7n };
    const plain = { address: at(t.principal.publicKey()), tag: null };
    const cases: [MandateAction, string][] = [
      [{ op: 'pause' }, 'pause'],
      [{ op: 'resume' }, 'resume'],
      [{ op: 'revoke' }, 'revoke'],
      [{ op: 'approve', payoutId: ID }, 'approve'],
      [{ op: 'reject', payoutId: ID }, 'reject'],
      [{ op: 'cancel', payoutId: ID }, 'cancel'],
      [{ op: 'cancel_batch', payoutIds: [ID, ID] }, 'cancel_batch'],
      [{ op: 'withdraw', amount: usdc(5n) }, 'withdraw'],
      [{ op: 'sweep' }, 'sweep'],
      [{ op: 'recover_token', token: at(FIXTURE_FACTORY), amount: 3n }, 'recover_token'],
      [{ op: 'update_limits', limits: LIMITS }, 'update_limits'],
      [{ op: 'set_approvals_required', n: 1 }, 'set_approvals_required'],
      [
        {
          op: 'allow_recipients',
          entries: [
            { recipientRef: REF, destination: tagged },
            { recipientRef: REF, destination: plain },
          ],
        },
        'allow_recipients',
      ],
      [
        { op: 'disallow_recipients', entries: [{ recipientRef: REF, destination: plain }] },
        'disallow_recipients',
      ],
      [
        {
          op: 'set_attestation_policy',
          attester: new Uint8Array(32).fill(9),
          countryPolicyHash: REF,
        },
        'set_attestation_policy',
      ],
      [
        { op: 'propose_principal', proposed: at(Keypair.random().publicKey()) },
        'propose_principal',
      ],
      [{ op: 'accept_principal' }, 'accept_principal'],
    ];
    for (const [action, fn] of cases) {
      const signing = await t.adapter.prepareMandateAction(request(t, action), OPTS);
      expect(callOf(signing).fn).toBe(fn);
      expect(signing.summary.action).toBe(action.op);
    }
    const withdraw = await t.adapter.prepareMandateAction(
      request(t, { op: 'withdraw', amount: usdc(5n) }),
      OPTS,
    );
    expect(withdraw.summary).toMatchObject({ amount: usdc(5n), feePaidBy: 'ujira' });
  });

  it('builds create on the trusted factory and keeps the address it will deploy at', async () => {
    const t = setup();
    const action: MandateAction = {
      op: 'create',
      factory: at(FIXTURE_FACTORY),
      salt: REF,
      config: {
        principal: at(t.principal.publicKey()),
        asset: 'USDC',
        recipientMode: 'both',
        agents: [],
        approvers: [],
        approvalsRequired: 0,
        guardians: [],
        executors: [],
        recovery: [],
        recoveryThreshold: 0,
        limits: LIMITS,
        attester: new Uint8Array(32).fill(1),
        countryPolicyHash: REF,
        maxFeeBps: 100,
      },
    };
    const signing = await t.adapter.prepareMandateAction(request(t, action), OPTS);
    const call = callOf(signing);
    expect(call).toMatchObject({ contract: FIXTURE_FACTORY, fn: 'create' });
    expect(signing.summary.mandate).toBeUndefined();
    const deployed = mandateAddressOf(NETWORK, FIXTURE_FACTORY, t.principal.publicKey(), REF);
    const stored = await t.requests.load(t.scope, signing.requestId);
    expect(stored?.request.mandate).toBe(deployed);

    // The tag goes on chain, bound to that address. The reference never does.
    const reference = tenantRefOf(t.scope);
    const [configArg] = call.args;
    if (configArg === undefined) throw new Error('create takes a config');
    const fields = fieldsOf(configArg);
    expect(asBytes32(field(fields, 'tenant_tag'))).toBe(
      tenantTagOf(reference, addressXdr(deployed)),
    );
    expect(fields.has('tenant_ref')).toBe(false);
    if (signing.kind !== 'stellar_transaction') throw new Error('expected a transaction');
    expect(Buffer.from(signing.xdr, 'base64').toString('hex')).not.toContain(reference.slice(2));

    // A factory that would deploy elsewhere would strand the tag, so nothing is handed out.
    const elsewhere = setup();
    const moved = {
      ...action,
      config: { ...action.config, principal: at(elsewhere.principal.publicKey()) },
    };
    elsewhere.rpc.onSimulate = (tx) =>
      elsewhere.rpc.success(tx, Address.contract(Buffer.alloc(32, 7)).toScVal());
    await expect(
      elsewhere.adapter.prepareMandateAction(request(elsewhere, moved), OPTS),
    ).rejects.toBeInstanceOf(InternalError);
    expect(await elsewhere.requests.load(elsewhere.scope, 'req-1')).toBeNull();

    await expect(
      t.adapter.prepareMandateAction(request(t, { ...action, salt: '0x12' as Bytes32 }), OPTS),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      t.adapter.prepareMandateAction(
        request(t, { ...action, config: { ...action.config, principal: at('Gnope') } }),
        OPTS,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);

    await expect(
      t.adapter.prepareMandateAction(
        request(t, {
          ...action,
          factory: at('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'),
        }),
        OPTS,
      ),
    ).rejects.toBeInstanceOf(MandateUntrustedError);
    await expect(
      t.adapter.prepareMandateAction(
        request(t, { ...action, factory: { network: 'stellar:pubnet', value: FIXTURE_FACTORY } }),
        OPTS,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      t.adapter.prepareMandateAction({ ...request(t, action), mandate: t.mandate }, OPTS),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      t.adapter.prepareMandateAction(
        request(t, { ...action, config: { ...action.config, recipientMode: 'none' as 'both' } }),
        OPTS,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('refuses malformed input before anything reaches the chain', async () => {
    const t = setup();
    const bad: MandateAction[] = [
      { op: 'approve', payoutId: '0x12' as PayoutId },
      { op: 'withdraw', amount: { ...usdc(1n), asset: 'EURC' as 'USDC' } },
      { op: 'set_approvals_required', n: -1 },
      { op: 'recover_token', token: at('not an address'), amount: 1n },
      { op: 'recover_token', token: at(FIXTURE_FACTORY), amount: 1n << 127n },
      { op: 'update_limits', limits: { ...LIMITS, expiresAt: -1n as UnixSeconds } },
      {
        op: 'allow_recipients',
        entries: [{ recipientRef: REF, destination: { address: at(FIXTURE_FACTORY), tag: 1n } }],
      },
      {
        op: 'set_attestation_policy',
        attester: 'raw' as unknown as Uint8Array,
        countryPolicyHash: REF,
      },
      { op: 'add_role', role: 'owner' as 'agent', account: at(FIXTURE_FACTORY) },
      { op: 'bogus' } as unknown as MandateAction,
    ];
    for (const action of bad) {
      await expect(t.adapter.prepareMandateAction(request(t, action), OPTS)).rejects.toBeInstanceOf(
        InvalidInputError,
      );
    }
    await expect(
      t.adapter.prepareMandateAction({ ...request(t, { op: 'pause' }), mandate: null }, OPTS),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(t.rpc.simulated).toHaveLength(0);
  });

  it('refuses a signer on another network, a malformed one, and an account that does not exist', async () => {
    const t = setup();
    const base = request(t, { op: 'pause' });
    await expect(
      t.adapter.prepareMandateAction(
        { ...base, signer: { ...base.signer, network: 'stellar:pubnet' } },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      t.adapter.prepareMandateAction(request(t, { op: 'pause' }, 'Mxyz'), OPTS),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      t.adapter.prepareMandateAction(
        request(t, { op: 'pause' }, Keypair.random().publicKey()),
        OPTS,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('resolves a key UJIRA holds through the signer port', async () => {
    const t = setup();
    addAccount(t.rpc, t.channel.publicKey(), 5n);
    const signing = await t.adapter.prepareMandateAction(
      {
        scope: t.scope,
        mandate: t.mandate,
        action: { op: 'approve', payoutId: ID },
        signer: { kind: 'executor', network: NETWORK, keyId: 'channel-1' },
      },
      OPTS,
    );
    expect(signing.kind === 'stellar_transaction' && signing.signer.value).toBe(
      t.channel.publicKey(),
    );
  });

  it('carries a mandate refusal under its spec name and refuses a fee over the cap', async () => {
    const t = setup();
    t.rpc.onSimulate = () => ({
      id: '1',
      latestLedger: 1,
      error: 'HostError: Error(Contract, #23)',
      events: [
        new xdr.DiagnosticEvent({
          inSuccessfulContractCall: false,
          event: new xdr.ContractEvent({
            ext: xdr.ExtensionPoint.v0(),
            contractId: new xdr.ContractId(Address.fromString(t.mandate.address.value).toBuffer()),
            type: xdr.ContractEventType.diagnostic,
            body: xdr.ContractEventBody.v0(
              new xdr.ContractEventV0({
                topics: [
                  xdr.ScVal.scvSymbol('error'),
                  xdr.ScVal.scvError(xdr.ScError.sceContract(23)),
                ],
                data: xdr.ScVal.scvVoid(),
              }),
            ),
          }),
        }).toXdr('base64'),
      ],
    });
    const refused = t.adapter.prepareMandateAction(request(t, { op: 'pause' }), OPTS);
    await expect(refused).rejects.toBeInstanceOf(MandateRuleError);
    await expect(refused).rejects.toMatchObject({ specCode: 23, specName: 'ALREADY_PAUSED' });

    const capped = setup({ maxFeePerTxStroops: '1000' });
    await expect(
      capped.adapter.prepareMandateAction(request(capped, { op: 'pause' }), OPTS),
    ).rejects.toBeInstanceOf(SponsorDeniedError);
  });

  it('refuses a call that needs another address to authorize it', async () => {
    const t = setup();
    t.rpc.options.principal = Keypair.random().publicKey();
    await expect(
      t.adapter.prepareMandateAction(request(t, { op: 'resume' }), OPTS),
    ).rejects.toBeInstanceOf(SubmissionRejectedError);
  });
});
