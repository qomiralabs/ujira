// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The runner itself: what it writes for each way a call can end, the tamper
// kinds, and a vector it cannot run, which is recorded as aborted and never
// counted as a pass.

import { describe, expect, it } from 'vitest';

import {
  HostAbort,
  HostAuthFailure,
  MandateRuleError,
  NestedCallRefused,
  TokenFailure,
  TransportFailure,
} from '../failures.js';

import { appliesTo } from './format.js';
import type { LoadedVector } from './format.js';
import { describeMismatch } from './compare.js';
import { show } from './json.js';
import { loadVectors, parseVectorFile, vectorFiles } from './load.js';
import { addGroupOrder, failureResult, runVector, tamperSignature } from './world.js';

const all = loadVectors();

function byId(id: string): LoadedVector {
  const v = all.find((x) => x.parsed.id === id);
  if (v === undefined) throw new Error(`no vector ${id}`);
  return v;
}

describe('the vector runner', () => {
  it('writes each ending of a call in the trace form, a token error never as a mandate code', () => {
    const names = (address: string): string | undefined => (address === 'T' ? 'asset' : undefined);
    expect(failureResult(new MandateRuleError(10, 'UNAUTHORIZED'), names)).toEqual({
      error: 'UNAUTHORIZED',
    });
    expect(failureResult(new HostAuthFailure('a', 'b'), names)).toEqual({
      host_auth_failure: true,
    });
    expect(failureResult(new HostAbort('Crypto.InvalidInput'), names)).toEqual({
      host_abort: 'Crypto.InvalidInput',
    });
    expect(failureResult(new TokenFailure('T', 'not_authorized'), names)).toEqual({
      escaped_error: { from: 'asset', code: 'not_authorized' },
    });
    expect(failureResult(new TokenFailure('U', 'not_authorized'), names)).toEqual({
      escaped_error: { from: 'unknown', code: 'not_authorized' },
    });
    expect(failureResult(new NestedCallRefused('M'), names)).toEqual({
      host_error: 'Context.InvalidAction',
    });
    expect(failureResult(new TransportFailure('read failed'), names)).toEqual({
      host_error: 'read failed',
    });
    expect(() => failureResult(new RangeError('bug'), names)).toThrow(RangeError);
  });

  it('damages signatures exactly as the tamper kinds say', () => {
    const sig = new Uint8Array(64).fill(7);
    expect(tamperSignature(sig, 'empty')).toHaveLength(0);
    expect(tamperSignature(sig, 'truncated')).toHaveLength(32);
    expect(tamperSignature(sig, 'short_signature')).toHaveLength(63);
    expect(tamperSignature(sig, 'long_signature')).toHaveLength(65);
    expect(tamperSignature(sig, 'extended')).toHaveLength(128);
    expect(tamperSignature(sig, 'flipped_bit')[0]).toBe(6);
    expect(tamperSignature(sig, undefined)).toBe(sig);
    const s = new Uint8Array(32);
    s[0] = 0x20;
    const sum = addGroupOrder(s);
    expect([sum[0], sum[1], sum[31]]).toEqual([0x0d, 0xd4, 0x10]);
    expect(tamperSignature(sig, 'non_canonical_s').subarray(0, 32)).toEqual(sig.subarray(0, 32));
  });

  it('records a vector it cannot express as aborted, never as a pass', () => {
    const zero = all.find(
      (v) => !appliesTo(v, 'stellar') && JSON.stringify(v.raw).includes('"zero"'),
    );
    if (zero === undefined) throw new Error('no vector naming the zero address');
    const { trace, mismatch } = runVector(zero);
    expect(trace['status']).toBe('aborted');
    expect(show(trace['reason'])).toContain('the zero address cannot be expressed on Stellar');
    expect(mismatch === undefined ? '' : describeMismatch(mismatch)).toContain(
      'the run stopped before this step',
    );

    const noData = byId('recover_token_returning_no_data_succeeds');
    expect(runVector(noData).trace['status']).toBe('aborted');
    const noncanonical = byId('split_noncanonical_tag_refused');
    expect(show(runVector(noncanonical).trace['reason'])).toContain('a tag marked absent');
  });

  it('aborts on an unknown function and on a call before the mandate exists', () => {
    const base = byId('pause_blocks_requests_until_resume');
    const unknown: LoadedVector = {
      ...base,
      parsed: {
        ...base.parsed,
        steps: [
          { step: 'call', fn: 'teleport', caller: 'guardian', expect: { ok: true, events: [] } },
        ],
      },
    };
    expect(show(runVector(unknown).trace['reason'])).toContain('unknown function teleport');
    const noMandate: LoadedVector = {
      ...base,
      parsed: { ...base.parsed, setup: { now: '1767225600' } },
    };
    expect(show(runVector(noMandate).trace['reason'])).toContain('the mandate does not exist yet');
  });

  it('finds every vendored vector file and refuses a file of another format', () => {
    expect(vectorFiles(['vectors/a.json', 'vectors/schema.json', 'errors.json'])).toEqual([
      'vectors/a.json',
    ]);
    expect(() => parseVectorFile('x.json', { format: 'other', vectors: [] })).toThrow();
  });

  // Celo-only by the format, because only an EVM token can call back into
  // the mandate. Every nested call in them is state-changing, so the
  // Stellar host's refusal of every nested call gives the same outcome, and
  // they prove the engine's nested-call handling end to end. They are not
  // counted among the Stellar vector results.
  const nested = all.filter((v) => !appliesTo(v, 'stellar') && v.parsed.setup.tokens !== undefined);
  const reentrant = nested.filter((v) =>
    [v.parsed.setup.tokens?.asset?.kind, v.parsed.setup.tokens?.other_token?.kind].includes(
      'reentrant',
    ),
  );

  it('has the twenty reentrant token vectors to run', () => {
    expect(reentrant).toHaveLength(20);
  });

  it.each(reentrant.map((v) => [v.parsed.id, v] as const))(
    'refuses the nested call of %s as the spec says',
    (_id, v) => {
      const { mismatch } = runVector(v);
      expect(mismatch === undefined ? 'passed' : describeMismatch(mismatch)).toBe('passed');
    },
  );
});
