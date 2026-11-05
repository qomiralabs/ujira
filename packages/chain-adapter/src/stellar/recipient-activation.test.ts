// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for buildRecipientActivation (recipient-activation.ts).
 *
 * One transaction with the fee sponsor as source and fee payer:
 * BeginSponsoringFutureReserves(recipient) as the sponsor, CreateAccount
 * (recipient, 0) as the sponsor only when the account is missing,
 * ChangeTrust to the payout asset as the recipient, and
 * EndSponsoringFutureReserves as the recipient, with time bounds from now
 * to now plus 300 seconds. It comes back as a signing request for the
 * recipient. A network without reserve sponsorship gets UnsupportedError.
 */

import { describe, expect, it } from 'vitest';

import { decodeTransactionEnvelope } from '../codecs/envelope.js';
import {
  STRKEY_VERSION,
  decodeAccountAddress,
  encodeAccountAddress,
  encodeMuxedAddress,
  encodeStrkey,
} from '../codecs/strkey.js';
import { InvalidInputError, UnsupportedError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import { buildRecipientActivation } from './recipient-activation.js';
import type { StellarRecipientActivationRequest } from './recipient-activation.js';

const NETWORK: StellarNetworkId = 'stellar:testnet';
const G = (fill: number) => encodeAccountAddress(new Uint8Array(32).fill(fill));
const SPONSOR = G(1);
const RECIPIENT = G(2);
const ISSUER = G(3);
const NOW = 1_793_520_000n;
const sponsored = { reserveSponsorship: true };

function request(
  overrides: Partial<StellarRecipientActivationRequest> = {},
): StellarRecipientActivationRequest {
  return {
    requestId: '3a7b9c1d-2e4f-4a6b-8c0d-1e2f3a4b5c6d',
    sponsor: SPONSOR,
    sponsorSequence: 41n,
    recipient: RECIPIENT,
    asset: { code: 'USDC', issuer: ISSUER },
    createAccount: true,
    baseFeeStroops: 100n,
    maxFeePerTxStroops: 1_000_000n,
    nowSeconds: NOW,
    ...overrides,
  };
}

function shape(xdr: string) {
  const tx = decodeTransactionEnvelope(xdr, NETWORK);
  return {
    source: tx.source.account,
    fee: tx.fee,
    sequence: tx.sequence,
    timeBounds: tx.timeBounds,
    operations: tx.operations.map((op) => [op.type, op.source?.account ?? null]),
  };
}

describe('buildRecipientActivation', () => {
  it('four operations (three when the account exists) with the right sources and 300 s time bounds', () => {
    const created = buildRecipientActivation(NETWORK, request(), sponsored);
    expect(shape(created.xdr)).toEqual({
      source: SPONSOR,
      fee: 400n,
      sequence: 42n,
      timeBounds: { minTime: NOW, maxTime: NOW + 300n },
      operations: [
        ['beginSponsoringFutureReserves', SPONSOR],
        ['createAccount', SPONSOR],
        ['changeTrust', RECIPIENT],
        ['endSponsoringFutureReserves', RECIPIENT],
      ],
    });
    const existing = buildRecipientActivation(
      NETWORK,
      request({ createAccount: false }),
      sponsored,
    );
    expect(shape(existing.xdr)).toMatchObject({
      fee: 300n,
      timeBounds: { minTime: NOW, maxTime: NOW + 300n },
      operations: [
        ['beginSponsoringFutureReserves', SPONSOR],
        ['changeTrust', RECIPIENT],
        ['endSponsoringFutureReserves', RECIPIENT],
      ],
    });
  });

  it('is a signing request for the recipient, paid by UJIRA', () => {
    expect(buildRecipientActivation(NETWORK, request(), sponsored)).toMatchObject({
      kind: 'stellar_transaction',
      network: NETWORK,
      signer: { network: NETWORK, value: RECIPIENT },
      validUntil: NOW + 300n,
      sponsored: true,
      summary: { action: 'activate_recipient', feePaidBy: 'ujira' },
      requestId: '3a7b9c1d-2e4f-4a6b-8c0d-1e2f3a4b5c6d',
    });
  });

  it('activates the G behind an M', () => {
    const muxed = encodeMuxedAddress(decodeAccountAddress(RECIPIENT), 12n);
    const built = buildRecipientActivation(NETWORK, request({ recipient: muxed }), sponsored);
    expect(built.signer.value).toBe(RECIPIENT);
  });

  it('is unsupported where reserves cannot be sponsored', () => {
    expect(() =>
      buildRecipientActivation(NETWORK, request(), { reserveSponsorship: false }),
    ).toThrow(UnsupportedError);
  });

  it('refuses a request that could never land', () => {
    const contract = encodeStrkey(STRKEY_VERSION.contract, new Uint8Array(32).fill(4));
    const cases: [Partial<StellarRecipientActivationRequest>, string][] = [
      [{ sponsor: contract }, 'activation.sponsor (invalid)'],
      [{ recipient: contract }, 'activation.recipient (not_an_account)'],
      [{ recipient: SPONSOR }, 'activation.recipient (is_sponsor)'],
      [{ recipient: ISSUER }, 'activation.recipient (is_issuer)'],
      [{ asset: { code: 'USD C', issuer: ISSUER } }, 'activation.asset (invalid)'],
      [{ asset: { code: 'USDC', issuer: contract } }, 'activation.asset (invalid)'],
      [{ sponsorSequence: -1n }, 'activation.sponsorSequence (invalid)'],
      [{ nowSeconds: -1n }, 'activation.nowSeconds (invalid)'],
      [{ baseFeeStroops: 99n }, 'activation.baseFeeStroops (out_of_range)'],
      [{ maxFeePerTxStroops: 399n }, 'activation.baseFeeStroops (over_cap)'],
    ];
    for (const [override, issue] of cases) {
      let error: unknown;
      try {
        buildRecipientActivation(NETWORK, request(override), sponsored);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(InvalidInputError);
      expect((error as InvalidInputError).issues).toEqual([issue]);
    }
    // Three operations fit under a cap that four would break.
    expect(() =>
      buildRecipientActivation(
        NETWORK,
        request({ createAccount: false, maxFeePerTxStroops: 300n }),
        sponsored,
      ),
    ).not.toThrow();
  });
});
