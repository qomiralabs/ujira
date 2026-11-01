// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Address, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { InternalError, MandateRuleError, SubmissionRejectedError } from '../errors.js';
import { callFailure } from './sim-errors.js';
import { SPEC_ERRORS } from './spec-errors.js';

const MANDATE = Address.contract(Buffer.alloc(32, 1)).toString();
const TOKEN = Address.contract(Buffer.alloc(32, 2)).toString();
const NETWORK = 'stellar:testnet' as const;

function event(emitter: string | null, error: xdr.ScError, name = 'error'): string {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: emitter === null ? null : new xdr.ContractId(Address.fromString(emitter).toBuffer()),
      type: xdr.ContractEventType.diagnostic,
      body: xdr.ContractEventBody.v0(
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol(name), xdr.ScVal.scvError(error)],
          data: xdr.ScVal.scvVoid(),
        }),
      ),
    }),
  }).toXdr('base64');
}

const contract = (code: number) => xdr.ScError.sceContract(code);

describe('callFailure', () => {
  it('reads a refusal the mandate raised under its spec name', () => {
    const error = callFailure(NETWORK, MANDATE, [event(MANDATE, contract(43))]);
    expect(error).toBeInstanceOf(MandateRuleError);
    expect(error).toMatchObject({ specCode: 43, specName: 'INSUFFICIENT_FUNDS', waitFor: 'funding' });
  });

  it('maps any contract error from the token to TRANSFER_FAILED, never to a mandate code', () => {
    // The token's own code 10 would read as UNAUTHORIZED if taken for the mandate's.
    for (const events of [
      [event(TOKEN, contract(10))],
      [event(TOKEN, contract(10)), event(MANDATE, contract(10))],
      [event(TOKEN, contract(12)), event(MANDATE, contract(72))],
    ]) {
      expect(callFailure(NETWORK, MANDATE, events)).toMatchObject({
        code: 'MANDATE_RULE',
        specCode: 72,
        specName: 'TRANSFER_FAILED',
      });
    }
  });

  it('treats host failures, unreadable events and unknown codes as rejections or internal errors', () => {
    expect(callFailure(NETWORK, MANDATE, [])).toBeInstanceOf(SubmissionRejectedError);
    expect(callFailure(NETWORK, MANDATE, ['garbage'])).toBeInstanceOf(SubmissionRejectedError);
    expect(
      callFailure(NETWORK, MANDATE, [event(MANDATE, xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction))]),
    ).toBeInstanceOf(SubmissionRejectedError);
    expect(callFailure(NETWORK, MANDATE, [event(null, contract(22))])).toBeInstanceOf(SubmissionRejectedError);
    expect(callFailure(NETWORK, MANDATE, [event(MANDATE, contract(22), 'log')])).toBeInstanceOf(
      SubmissionRejectedError,
    );
    expect(callFailure(NETWORK, MANDATE, [event(MANDATE, contract(99))])).toBeInstanceOf(InternalError);
  });
});

describe('the spec error table', () => {
  it('matches the vendored errors.json exactly', () => {
    const vendored = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../spec/errors.json'), 'utf8'),
    ) as { name: string; code: number }[];
    expect([...SPEC_ERRORS.entries()]).toEqual(vendored.map((e) => [e.code, e.name]));
  });
});
