// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The fake chain as other packages drive it. The shared vectors cover the
// mandate's rules; these cover what the vectors cannot express on Stellar:
// nested calls from a token, a balance read that fails, a token moving the
// settlement balance during recovery, and the fake's own input checks.

import { describe, expect, it } from 'vitest';

import { InvalidInputError, MandateRuleError } from '../errors.js';

import {
  ATTESTATION_PREFIX,
  FakeLedger,
  FakeToken,
  HostAbort,
  HostAuthFailure,
  MandateFactory,
  NestedCallRefused,
  TokenFailure,
  TransportFailure,
  accountAddress,
  accountFromSeed,
  accountKeyOf,
  addressXdr,
  attestationFieldBytes,
  attestationMessage,
  contractAddress,
  ed25519PublicKey,
  ed25519Verify,
  encodeAttestationFields,
  feeCap,
  hexOf,
  isAddress,
  isBytes32,
  sha256,
  signAttestation,
} from './index.js';
import type { EngineConfig, EnginePayoutRequest, MandateEngine } from './index.js';
import { bytesOf, utf8 } from './bytes.js';
import { checkAddress } from './address.js';
import { mandateErrorName } from './spec.js';

const NOW = 1_767_225_600n;
const account = (name: string): string => accountFromSeed(sha256(utf8(`test:${name}`)));
const contract = (name: string): string => contractAddress(sha256(utf8(`contract:${name}`)));
const ref = (name: string): string => hexOf(sha256(utf8(name)));

const principal = account('principal');
const agent = account('agent');
const bob = account('bob');
const feeAddress = account('fee');
const stranger = account('stranger');

interface World {
  readonly ledger: FakeLedger;
  readonly asset: FakeToken;
  readonly other: FakeToken;
  readonly factory: MandateFactory;
  readonly mandate: MandateEngine;
}

function config(asset: string, overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    principal,
    asset,
    recipientMode: 'ALLOWLIST',
    tenantRef: ref('tenant'),
    agents: [agent],
    approvers: [],
    approvalsRequired: 0,
    guardians: [],
    executors: [],
    recovery: [],
    recoveryThreshold: 0,
    limits: {
      totalBudget: 10_000n,
      perPaymentCap: 1_000n,
      perRecipientDailyCap: 1_000n,
      approvalThreshold: 1_001n,
      payoutTtlSeconds: 86_400n,
      expiresAt: NOW + 86_400n * 30n,
    },
    attester: null,
    countryPolicyHash: ref('countries'),
    maxFeeBps: 0,
    ...overrides,
  };
}

function world(options: { nestedViews?: 'refuse' | 'answer' } = {}): World {
  const ledger = new FakeLedger({ now: NOW, ...options });
  const asset = new FakeToken(ledger, { address: contract('asset') });
  const other = new FakeToken(ledger, { address: contract('other'), kind: 'contract' });
  const factory = new MandateFactory(ledger, {
    address: contract('factory'),
    feeAddress,
    assets: [asset.address],
  });
  const mandate = factory.create({ caller: principal }, config(asset.address), ref('salt'));
  mandate.allowRecipients({ caller: principal }, [
    { recipientRef: ref('bob'), destination: { address: bob, tag: null } },
  ]);
  asset.mint(mandate.address, 1_000n);
  return { ledger, asset, other, factory, mandate };
}

function request(id: string, total = 100n): EnginePayoutRequest {
  return {
    payoutId: ref(id),
    recipientRef: ref('bob'),
    total,
    legs: [{ destination: { address: bob, tag: null }, amount: total }],
    deadline: NOW + 600n,
    taskRef: ref('task'),
    attestations: [],
  };
}

function ruleOf(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (error) {
    if (error instanceof MandateRuleError) return error.specName;
    throw error;
  }
}

describe('a payout through the engine API', () => {
  it('requests, executes and reports events, tokens and views', () => {
    const w = world();
    const before = w.ledger.events.length;
    expect(w.mandate.requestPayout({ caller: agent }, request('p1'))).toBe('APPROVED');
    w.mandate.execute({ caller: agent }, ref('p1'));
    expect(w.ledger.events.slice(before).map((e) => e.name)).toEqual([
      'payout_requested',
      'payout_executed',
    ]);
    expect(w.ledger.tokenEvents.at(-1)).toMatchObject({ name: 'transfer', amount: 100n });
    expect(w.asset.balance(bob)).toBe(100n);
    expect(w.mandate.payout(ref('p1'))).toEqual({ payoutId: ref('p1'), status: 'EXECUTED' });
    expect(w.mandate.state()).toMatchObject({ spent: 100n, balance: 900n, free: 900n });
    expect(w.mandate.dailyUsed(ref('bob'))).toEqual({ day: NOW / 86_400n, used: 100n });
    expect(w.mandate.version()).toBe(1);
    expect(w.mandate.config()).toMatchObject({ feeAddress, factory: w.factory.address });
    expect(w.mandate.address).toBe(w.factory.mandateAddress(principal, ref('salt')));
  });

  it('refuses with the spec code and changes nothing', () => {
    const w = world();
    const state = w.mandate.state();
    expect(ruleOf(() => w.mandate.requestPayout({ caller: agent }, request('p1', 2_000n)))).toBe(
      'PAYMENT_CAP_EXCEEDED',
    );
    expect(w.mandate.state()).toEqual(state);
    expect(w.mandate.payout(ref('p1'))).toBe(null);
    expect(() => w.mandate.revoke({ caller: stranger })).toThrow(HostAuthFailure);
    expect(() => {
      w.mandate.pause({ caller: principal, signedBy: stranger });
    }).toThrow(HostAuthFailure);
    expect(mandateErrorName(46)).toBe('FEE_EXCEEDS_CAP');
    expect(mandateErrorName(1)).toBe(undefined);
  });
});

describe('nested calls from a token', () => {
  function reentrant(w: World, propagate: boolean, call: () => unknown): void {
    w.asset.setTransferHook(() => {
      try {
        call();
      } catch (error) {
        if (propagate) throw error;
      }
    });
  }

  it('fails the outer call with TRANSFER_FAILED when the token propagates the refusal', () => {
    const w = world();
    w.mandate.requestPayout({ caller: agent }, request('p1'));
    w.mandate.requestPayout({ caller: agent }, request('p2'));
    const state = w.mandate.state();
    reentrant(w, true, () => {
      w.mandate.execute({ caller: agent }, ref('p2'));
    });
    expect(
      ruleOf(() => {
        w.mandate.execute({ caller: agent }, ref('p1'));
      }),
    ).toBe('TRANSFER_FAILED');
    expect(w.mandate.state()).toEqual(state);
    expect(w.mandate.payout(ref('p1'))).toMatchObject({ status: 'APPROVED' });
  });

  it('completes the outer call with no nested effect when the token catches it', () => {
    const w = world();
    w.mandate.requestPayout({ caller: agent }, request('p1'));
    w.mandate.requestPayout({ caller: agent }, request('p2'));
    const seen: unknown[] = [];
    w.asset.setTransferHook(() => {
      try {
        w.mandate.execute({ caller: agent }, ref('p2'));
      } catch (error) {
        seen.push(error);
      }
    });
    w.mandate.execute({ caller: agent }, ref('p1'));
    expect(seen[0]).toBeInstanceOf(NestedCallRefused);
    expect(w.mandate.payout(ref('p2'))).toMatchObject({ status: 'APPROVED' });
    expect(w.mandate.state()).toMatchObject({ spent: 100n, committed: 100n, balance: 900n });
  });

  it('refuses views too on Stellar, and answers them with mid-call state where views answer', () => {
    const refusing = world();
    refusing.mandate.requestPayout({ caller: agent }, request('p1'));
    reentrant(refusing, true, () => refusing.mandate.payout(ref('p1')));
    expect(
      ruleOf(() => {
        refusing.mandate.execute({ caller: agent }, ref('p1'));
      }),
    ).toBe('TRANSFER_FAILED');

    const answering = world({ nestedViews: 'answer' });
    answering.mandate.requestPayout({ caller: agent }, request('p1'));
    const views: unknown[] = [];
    answering.asset.setTransferHook(() => {
      views.push(answering.mandate.payout(ref('p1')));
      views.push(answering.mandate.state().spent);
    });
    answering.mandate.execute({ caller: agent }, ref('p1'));
    // Mid-call state, never final: the tombstone is written before the legs pay.
    expect(views).toEqual([{ payoutId: ref('p1'), status: 'EXECUTED' }, 100n]);
    reentrant(answering, true, () => answering.mandate.sweep({ caller: principal }));
    answering.mandate.requestPayout({ caller: agent }, request('p2'));
    expect(
      ruleOf(() => {
        answering.mandate.execute({ caller: agent }, ref('p2'));
      }),
    ).toBe('TRANSFER_FAILED');
  });

  it('passes an error that is not the host refusing through unchanged', () => {
    const w = world();
    w.mandate.requestPayout({ caller: agent }, request('p1'));
    w.asset.setTransferHook(() => {
      throw new RangeError('a bug in the test token');
    });
    expect(() => {
      w.mandate.execute({ caller: agent }, ref('p1'));
    }).toThrow(RangeError);
    w.asset.setTransferHook(null);
    w.mandate.execute({ caller: agent }, ref('p1'));
  });
});

describe('balance reads and token recovery', () => {
  it('treats a failed balance read as a transport failure, never TRANSFER_FAILED', () => {
    const w = world();
    const state = w.mandate.state();
    w.asset.setBalanceReadFailure(true);
    expect(() => w.mandate.requestPayout({ caller: agent }, request('p1'))).toThrow(
      TransportFailure,
    );
    expect(() => w.mandate.revoke({ caller: principal })).toThrow(TransportFailure);
    expect(() => w.mandate.state()).toThrow(TransportFailure);
    w.asset.setBalanceReadFailure(false);
    expect(w.mandate.state()).toEqual(state);
  });

  it('refuses recovery that moves the settlement balance, with WRONG_ASSET', () => {
    const w = world();
    w.other.mint(w.mandate.address, 50n);
    w.other.setTransferHook(() => {
      w.asset.clawback(w.mandate.address, 1n);
    });
    expect(
      ruleOf(() => {
        w.mandate.recoverToken({ caller: principal }, w.other.address, 10n);
      }),
    ).toBe('WRONG_ASSET');
    expect(w.asset.balance(w.mandate.address)).toBe(1_000n);
    w.other.setTransferHook(null);
    w.mandate.recoverToken({ caller: principal }, w.other.address, 10n);
    expect(w.other.balance(principal)).toBe(10n);
  });

  it('fails a transfer of something that is not a token as TRANSFER_FAILED', () => {
    const w = world();
    expect(
      ruleOf(() => {
        w.mandate.recoverToken({ caller: principal }, stranger, 1n);
      }),
    ).toBe('TRANSFER_FAILED');
  });

  it('cannot read a settlement asset that is no token on the ledger', () => {
    const ledger = new FakeLedger({ now: NOW });
    const missing = contract('missing');
    const factory = new MandateFactory(ledger, {
      address: contract('factory'),
      feeAddress,
      assets: [missing],
    });
    const mandate = factory.create({ caller: principal }, config(missing), ref('salt'));
    expect(() => mandate.state()).toThrow(TransportFailure);
  });
});

describe('the factory', () => {
  it('puts a mandate where principal and salt say, once', () => {
    const w = world();
    expect(() =>
      w.factory.create({ caller: principal }, config(w.asset.address), ref('salt')),
    ).toThrow(TransportFailure);
    expect(ruleOf(() => w.factory.create({ caller: principal }, config(stranger), ref('x')))).toBe(
      'ASSET_NOT_SUPPORTED',
    );
    expect(() => w.factory.create({ caller: stranger }, config(w.asset.address), ref('y'))).toThrow(
      HostAuthFailure,
    );
    // The factory keeps no state, so its restore is a no-op that must still run.
    const restore = w.factory.checkpoint();
    restore();
    expect(w.ledger.contract(w.factory.address)).toBe(w.factory);
  });
});

describe('the attestation message', () => {
  it('builds the worked example of spec/ENCODING.md byte for byte', () => {
    const seed = sha256(utf8('UJIRA/TEST-ONLY/S18/attester-ed25519'));
    const subject = {
      networkId: sha256(utf8('Test SDF Network ; September 2015')),
      mandate: 'CDUKSTCG3XKTPTHMNRJZIW23J3T5DKHASDPQ3CIRKQ4YJH3PDOFFULZA',
      recipientRef: '0x187204dacf1b6ae9830406f0405b3710d69d86df034cf3fe3753e7b460c8e97d',
      countryPolicyHash: '0x343fb1d75ee948735be1a836a29a40ecd0612986ab9bd1183f8271ccca830415',
      policyEpoch: 0n,
      validUntil: 1_767_229_200n,
      destination: {
        address: 'GDTYAUMMX45E2SU2Q7JRJHCXDIYTEUAXVBHZ7DVCVXZGMAKMWFL7SOY4',
        tag: null,
      },
    };
    const fields = encodeAttestationFields(attestationFieldBytes(subject));
    expect(fields).toHaveLength(207);
    expect(hexOf(sha256(fields))).toBe(
      '0x6786dd0154eaa55fca26d77da8952c91df2fcc0927e381771667f4c37a7f115e',
    );
    const message = attestationMessage(subject);
    expect(message).toHaveLength(47);
    expect(Buffer.from(message.subarray(0, 15)).toString()).toBe(ATTESTATION_PREFIX);
    expect(hexOf(ed25519PublicKey(seed))).toBe(
      '0x421adb50c10fe73fb1fc0d4211a16911a188bb001eaf0391b479316026141d48',
    );
    const signature = signAttestation(seed, subject);
    expect(hexOf(signature)).toBe(
      '0x043dcca5e9a6dfd41320f9ecf7b4778bf00ff706ac26d865f4c1ff6366a49e0497e63ef43e2a0e6404218231d10d11aa030f954d9eb799ff92f0328e1cae2208',
    );
    expect(ed25519Verify(ed25519PublicKey(seed), message, signature)).toBe(true);
    expect(ed25519Verify(new Uint8Array(32), message, signature)).toBe(false);
    expect(ed25519Verify(ed25519PublicKey(seed), message, signature.subarray(1))).toBe(false);
    expect(() =>
      encodeAttestationFields({ ...attestationFieldBytes(subject), mandate: new Uint8Array(256) }),
    ).toThrow(InvalidInputError);
  });

  it('traps a request whose attestation does not verify, as the host does', () => {
    const seed = sha256(utf8('attester'));
    const ledger = new FakeLedger({ now: NOW });
    const asset = new FakeToken(ledger, { address: contract('asset') });
    const factory = new MandateFactory(ledger, {
      address: contract('factory'),
      feeAddress,
      assets: [asset.address],
    });
    const mandate = factory.create(
      { caller: principal },
      config(asset.address, { recipientMode: 'ATTESTED', attester: ed25519PublicKey(seed) }),
      ref('salt'),
    );
    asset.mint(mandate.address, 1_000n);
    const subject = {
      networkId: ledger.networkId,
      mandate: mandate.address,
      recipientRef: ref('bob'),
      countryPolicyHash: ref('countries'),
      policyEpoch: 0n,
      validUntil: NOW + 3_600n,
      destination: { address: bob, tag: null },
    };
    const good = signAttestation(seed, subject);
    const bad = signAttestation(sha256(utf8('someone else')), subject);
    const withSig = (id: string, signature: Uint8Array): EnginePayoutRequest => ({
      ...request(id),
      attestations: [{ validUntil: NOW + 3_600n, policyEpoch: 0n, signature }],
    });
    expect(() => mandate.requestPayout({ caller: agent }, withSig('p1', bad))).toThrow(HostAbort);
    expect(mandate.requestPayout({ caller: agent }, withSig('p1', good))).toBe('APPROVED');
    expect(mandate.payout(ref('p1'))).toMatchObject({ expiresAt: NOW + 3_600n });
  });
});

describe('the ledger, tokens and inputs', () => {
  it('keeps time moving forward only', () => {
    const ledger = new FakeLedger({ now: NOW });
    ledger.advance(5n);
    expect(ledger.now).toBe(NOW + 5n);
    expect(() => {
      ledger.setTime(NOW);
    }).toThrow(InvalidInputError);
    expect(() => new FakeLedger({ now: -1n })).toThrow(InvalidInputError);
    const token = new FakeToken(ledger, { address: contract('t') });
    expect(() => new FakeToken(ledger, { address: contract('t') })).toThrow(InvalidInputError);
    expect(ledger.contract(token.address)).toBe(token);
    expect(ledger.isExecuting(token.address)).toBe(false);
  });

  it('gates a classic token on trustlines and balances', () => {
    const ledger = new FakeLedger({ now: NOW });
    const token = new FakeToken(ledger, { address: contract('t') });
    const holder = contract('holder');
    token.mint(holder, 10n);
    const to = { address: bob, tag: 7n };
    expect(() => token.transfer(holder, to, -1n)).toThrow(TokenFailure);
    expect(() => token.transfer(holder, to, 11n)).toThrow(TokenFailure);
    token.setReceiving(bob, 'deauthorized');
    expect(token.trustline(bob)).toBe('deauthorized');
    expect(() => token.transfer(holder, to, 1n)).toThrow(TokenFailure);
    token.setReceiving(bob, 'no_trustline');
    expect(() => token.transfer(holder, to, 1n)).toThrow(TokenFailure);
    expect(token.balance(bob)).toBe(0n);
    token.setReceiving(bob, 'receivable');
    token.transfer(holder, to, 4n);
    expect(() => {
      token.setReceiving(bob, 'no_trustline');
    }).toThrow(InvalidInputError);
    expect(() => {
      token.setReceiving(holder, 'deauthorized');
    }).toThrow(InvalidInputError);
    token.clawback(bob, 4n);
    expect(token.balance(bob)).toBe(0n);
    const plain = new FakeToken(ledger, { address: contract('p'), kind: 'contract' });
    expect(() => {
      plain.setReceiving(bob, 'deauthorized');
    }).toThrow(InvalidInputError);
    const failure = new TokenFailure(token.address, 'no_trustline');
    expect([failure.token, failure.reason, failure.name]).toEqual([
      token.address,
      'no_trustline',
      'TokenFailure',
    ]);
  });

  it('refuses input the chain cannot carry, before any rule', () => {
    const w = world();
    const bad = (fn: () => unknown): void => {
      expect(fn).toThrow(InvalidInputError);
    };
    bad(() => w.mandate.requestPayout({ caller: agent }, request('p1', 1n << 127n)));
    bad(() => w.mandate.requestPayout({ caller: agent }, { ...request('p1'), deadline: -1n }));
    bad(() => w.mandate.requestPayout({ caller: agent }, { ...request('p1'), payoutId: '0x1' }));
    bad(() => {
      w.mandate.setApprovalsRequired({ caller: principal }, 1.5);
    });
    bad(() => {
      w.mandate.addRole({ caller: principal }, 1, 'not an address');
    });
    bad(() => {
      w.mandate.pause({ caller: agent, signedBy: 'nobody' });
    });
    bad(() => w.mandate.isAllowed(ref('bob'), { address: contract('c'), tag: 1n }));
    bad(() => {
      w.mandate.setAttestationPolicy({ caller: principal }, [] as never, ref('x'));
    });
    bad(() =>
      w.factory.create(
        { caller: principal },
        { ...config(w.asset.address), recipientMode: 'OTHER' as never },
        ref('z'),
      ),
    );
    bad(() => bytesOf('0xz'));
    bad(() => addressXdr('nope'));
    bad(() => checkAddress('x', 5));
    bad(() => ed25519PublicKey(new Uint8Array(3)));
  });

  it('reads addresses and keys the way the contract does', () => {
    const key = ed25519PublicKey(sha256(utf8('k')));
    const a = accountAddress(key);
    expect(isAddress(a)).toBe(true);
    expect(accountKeyOf(a)).toEqual(key);
    expect(accountKeyOf(contract('c'))).toBe(null);
    expect(addressXdr(a)).toHaveLength(44);
    expect(addressXdr(contract('c'))).toHaveLength(40);
    expect(isBytes32(ref('x'))).toBe(true);
    expect(feeCap(19_999n, 50)).toBe(99n);
    expect(new HostAuthFailure(principal, stranger).required).toBe(principal);
  });
});
