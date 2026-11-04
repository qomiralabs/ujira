// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A contract cannot attach a transaction memo, and a muxed tag is only a
// 64 bit number, so a destination that needs a text or hash memo can never
// be paid from a mandate. These tests pin that it is refused when the
// destination is captured, and that a numeric memo becomes the M address
// that carries it.

import { describe, expect, it } from 'vitest';

import {
  UNSUPPORTED_MEMO_DESTINATION_MESSAGE,
  readBindableDestination,
  readProviderDepositInstruction,
} from '../destination.js';
import { InvalidInputError, UnsupportedMemoDestinationError } from '../errors.js';
import * as index from '../index.js';

const NETWORK = 'stellar:testnet';

// The SEP-23 strkey vectors.
const ACCOUNT_A = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const MUXED_A_0 = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ';
const MUXED_A_2_63 = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';
const ACCOUNT_B = 'GA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQHES5';
const MUXED_B_123456 = 'MA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAAAAAAAAAPCICBKU';
const CONTRACT = 'CDUKSTCG3XKTPTHMNRJZIW23J3T5DKHASDPQ3CIRKQ4YJH3PDOFFULZA';

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

function expectUnsupportedMemo(run: () => unknown): void {
  const err = thrown(run);
  expect(err).toBeInstanceOf(UnsupportedMemoDestinationError);
  expect(err).toBeInstanceOf(InvalidInputError);
  const typed = err as UnsupportedMemoDestinationError;
  expect(typed.name).toBe('UnsupportedMemoDestinationError');
  expect(typed.code).toBe('INVALID_INPUT');
  expect(typed.reason).toBe('MEMO_NOT_ID');
  expect(typed.network).toBe(NETWORK);
  expect(typed.retryable).toBe(false);
}

describe('destination.test.ts', () => {
  it('rejects text and hash memo destinations', () => {
    for (const memoType of ['text', 'hash', 'return'] as const) {
      expectUnsupportedMemo(() =>
        readBindableDestination(NETWORK, { address: ACCOUNT_A, memoType, memo: '1234' }),
      );
    }
    // A memo typed as an id that is not one is a text memo in disguise.
    for (const memo of ['ref-1234', '007', ' 12', '1e3', '']) {
      expectUnsupportedMemo(() =>
        readBindableDestination(NETWORK, { address: ACCOUNT_A, memoType: 'id', memo }),
      );
    }
    // The message the recipient sees names the problem and the way out.
    expect(UNSUPPORTED_MEMO_DESTINATION_MESSAGE).toMatch(/memo/);
    expect(UNSUPPORTED_MEMO_DESTINATION_MESSAGE).toMatch(/another/);
  });

  it('G plus id memo becomes the matching M address', () => {
    const cases: [string, string, string, bigint][] = [
      [ACCOUNT_A, '0', MUXED_A_0, 0n],
      [ACCOUNT_A, '9223372036854775808', MUXED_A_2_63, 2n ** 63n],
      [ACCOUNT_B, '123456', MUXED_B_123456, 123_456n],
    ];
    for (const [account, memo, muxed, tag] of cases) {
      const read = readBindableDestination(NETWORK, { address: account, memoType: 'id', memo });
      expect(read.address).toBe(muxed);
      expect(read.destination).toEqual({ address: { network: NETWORK, value: account }, tag });
      // The M address read back gives the same pair, so both spellings bind alike.
      const again = readBindableDestination(NETWORK, { address: muxed });
      expect(again).toEqual(read);
    }
    expect(Object.isFrozen(readBindableDestination(NETWORK, { address: MUXED_A_0 }))).toBe(true);
  });

  it('accepts G, C and M with no memo, as given', () => {
    for (const address of [ACCOUNT_A, CONTRACT, MUXED_B_123456]) {
      expect(readBindableDestination(NETWORK, { address }).address).toBe(address);
      expect(readBindableDestination(NETWORK, { address, memoType: 'none' }).address).toBe(address);
    }
    expect(readBindableDestination(NETWORK, { address: CONTRACT }).destination.tag).toBeNull();
  });

  it('rejects an id above 2^64 - 1', () => {
    const max = readBindableDestination(NETWORK, {
      address: ACCOUNT_A,
      memoType: 'id',
      memo: '18446744073709551615',
    });
    expect(max.destination.tag).toBe(2n ** 64n - 1n);
    for (const memo of ['18446744073709551616', '99999999999999999999999']) {
      const err = thrown(() =>
        readBindableDestination(NETWORK, { address: ACCOUNT_A, memoType: 'id', memo }),
      );
      expect(err).toBeInstanceOf(InvalidInputError);
      expect((err as InvalidInputError).reason).toBe('TAG_OUT_OF_RANGE');
    }
  });

  it('refuses a memo on a C or M address, and a memo with no type', () => {
    for (const address of [CONTRACT, MUXED_A_0]) {
      const err = thrown(() =>
        readBindableDestination(NETWORK, { address, memoType: 'id', memo: '5' }),
      );
      expect((err as InvalidInputError).reason).toBe('TAG_NOT_SUPPORTED');
    }
    for (const input of [
      { address: ACCOUNT_A, memo: '5' },
      { address: ACCOUNT_A, memoType: 'none', memo: '5' },
      { address: ACCOUNT_A, memoType: 'id' },
      { address: ACCOUNT_A, memoType: 'picture', memo: '5' },
      { address: ACCOUNT_A, memoType: 'id', memo: 5 },
      { address: 42 },
      { address: ACCOUNT_A, extra: true },
      null,
      Object.create({ address: ACCOUNT_A }) as unknown,
    ]) {
      const err = thrown(() => readBindableDestination(NETWORK, input as never));
      expect(err).toBeInstanceOf(InvalidInputError);
      expect(err).not.toBeInstanceOf(UnsupportedMemoDestinationError);
    }
  });

  it('refuses a network it does not know', () => {
    expect(
      thrown(() => readBindableDestination('stellar:mainnet' as never, { address: ACCOUNT_A })),
    ).toBeInstanceOf(InvalidInputError);
  });

  it('rejects an anchor deposit instruction with memo type text', () => {
    // SEP-6 withdraw, SEP-24 transaction and SEP-31 send responses each name
    // where to send the funds and the memo to send with them.
    const instructions: Record<string, string>[] = [
      { account_id: ACCOUNT_A, memo_type: 'text', memo: 'order 1234' },
      { withdraw_anchor_account: ACCOUNT_A, withdraw_memo_type: 'text', withdraw_memo: 'x' },
      { stellar_account_id: ACCOUNT_A, stellar_memo_type: 'text', stellar_memo: 'x' },
      {
        account_id: ACCOUNT_A,
        memo_type: 'hash',
        memo: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
      },
      { stellar_account_id: ACCOUNT_A, stellar_memo_type: 'hash', stellar_memo: 'x' },
    ];
    for (const instruction of instructions) {
      expectUnsupportedMemo(() =>
        readProviderDepositInstruction(NETWORK, { ...instruction, id: 'tx-1', status: 'pending' }),
      );
    }
  });

  it('turns an anchor instruction with an id memo into its M address', () => {
    const forms: Record<string, string>[] = [
      { account_id: ACCOUNT_B, memo_type: 'id', memo: '123456' },
      { withdraw_anchor_account: ACCOUNT_B, withdraw_memo_type: 'id', withdraw_memo: '123456' },
      { stellar_account_id: ACCOUNT_B, stellar_memo_type: 'id', stellar_memo: '123456' },
    ];
    for (const form of forms) {
      expect(readProviderDepositInstruction(NETWORK, form).address).toBe(MUXED_B_123456);
    }
    expect(readProviderDepositInstruction(NETWORK, { account_id: ACCOUNT_A }).address).toBe(
      ACCOUNT_A,
    );
  });

  it('refuses an anchor instruction it cannot read', () => {
    for (const instruction of [
      {},
      { memo_type: 'id', memo: '1' },
      { account_id: ACCOUNT_A, withdraw_anchor_account: ACCOUNT_B },
      { account_id: ACCOUNT_A, memo: '1' },
      { account_id: ACCOUNT_A, memo_type: 'id' },
      { account_id: ACCOUNT_A, memo_type: 'picture', memo: '1' },
      { account_id: 7 },
      'GA7Q',
      null,
    ]) {
      const err = thrown(() => readProviderDepositInstruction(NETWORK, instruction));
      expect(err).toBeInstanceOf(InvalidInputError);
      expect(err).not.toBeInstanceOf(UnsupportedMemoDestinationError);
    }
  });

  it('names fields and reasons in its issues, never the value', () => {
    const err = thrown(() =>
      readBindableDestination(NETWORK, { address: ACCOUNT_A, memoType: 'text', memo: 'alice' }),
    ) as InvalidInputError;
    expect(err.issues).toEqual(['destination.memo (memo_not_id)']);
    expect(JSON.stringify(err.toJSON())).not.toContain('alice');
  });

  it('exports the readers and the error from the package root', () => {
    const root = index as Record<string, unknown>;
    expect(root['readBindableDestination']).toBe(readBindableDestination);
    expect(root['readProviderDepositInstruction']).toBe(readProviderDepositInstruction);
    expect(root['UnsupportedMemoDestinationError']).toBe(UnsupportedMemoDestinationError);
    expect(root['UNSUPPORTED_MEMO_DESTINATION_MESSAGE']).toBe(UNSUPPORTED_MEMO_DESTINATION_MESSAGE);
  });
});
