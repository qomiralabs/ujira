// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the local signer (local-signer.ts).
 *
 * LocalSigner and LocalAttesterSigner derive every key from one 32 byte
 * seed, given as 64 lower case hex characters or read from
 * UJIRA_SIGNER_LOCAL_SEED by fromEnv. Both throw SignerDeniedError at
 * construction when NODE_ENV is production, and InvalidInputError naming the
 * variable, never the value, for a seed that is not one. The seed never
 * shows in JSON, inspection or an error. Health is healthy, with the 95th
 * percentile of signing latency, or null before the first signature. A ref
 * or payload of the wrong shape is refused with SignerDeniedError.
 */

import { inspect } from 'node:util';

import { InvalidInputError, SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';
import type { CallOptions, SignerRef } from '@ujira/chain-adapter';
import { testTransactionXdr } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { LOCAL_SEED_VARIABLE, LocalAttesterSigner, LocalSigner } from './index.js';

const SEED = '3c'.repeat(32);
const OPTS: CallOptions = { correlationId: 'local-signer-test' };
const EXECUTOR: SignerRef = { kind: 'executor', network: 'stellar:testnet', keyId: 'executor_0' };

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('LocalSigner', () => {
  it('NODE_ENV production throws at construction', () => {
    expect(thrown(() => new LocalSigner({ seed: SEED, nodeEnv: 'production' }))).toBeInstanceOf(
      SignerDeniedError,
    );
    expect(
      thrown(() => new LocalAttesterSigner({ seed: SEED, nodeEnv: 'production' })),
    ).toBeInstanceOf(SignerDeniedError);
    const env = { [LOCAL_SEED_VARIABLE]: SEED, NODE_ENV: 'production' };
    expect(thrown(() => LocalSigner.fromEnv(env))).toBeInstanceOf(SignerDeniedError);
    expect(thrown(() => LocalAttesterSigner.fromEnv(env))).toBeInstanceOf(SignerDeniedError);
  });

  it('health returns healthy with p95', async () => {
    // Every reading of the clock moves it 5 ms, so each signature takes 5.
    let clock = 1_700_000_000_000;
    const signer = new LocalSigner({ seed: SEED, nodeEnv: 'test', now: () => (clock += 5) });
    const before = await signer.health(OPTS);
    expect(before.state).toBe('healthy');
    expect(before.signP95Ms).toBeNull();
    expect(before.reasons).toEqual([]);

    const source = (await signer.address(EXECUTOR, OPTS)).value;
    const xdr = testTransactionXdr({ source });
    for (let i = 0; i < 3; i += 1) {
      await signer.sign(EXECUTOR, { kind: 'stellar_tx', network: 'stellar:testnet', xdr }, OPTS);
    }
    const after = await signer.health(OPTS);
    expect(after.state).toBe('healthy');
    expect(after.signP95Ms).toBe(5);
    expect(after.checkedAt).toBe(BigInt(Math.floor(clock / 1000)));
  });

  it('reads its seed from the environment, and the same seed gives the same keys', async () => {
    const env = { [LOCAL_SEED_VARIABLE]: SEED, NODE_ENV: 'development' };
    const a = await LocalSigner.fromEnv(env).address(EXECUTOR, OPTS);
    const b = await new LocalSigner({ seed: SEED, nodeEnv: 'test' }).address(EXECUTOR, OPTS);
    const c = await new LocalSigner({ seed: '4d'.repeat(32), nodeEnv: 'test' }).address(
      EXECUTOR,
      OPTS,
    );
    expect(a).toEqual(b);
    expect(a.value).not.toBe(c.value);
    const attester = LocalAttesterSigner.fromEnv(env);
    expect(await attester.publicKey('stellar:testnet', OPTS)).toHaveLength(32);
  });

  it('uses NODE_ENV from the process when none is given', () => {
    // Vitest runs with NODE_ENV=test.
    expect(new LocalSigner({ seed: SEED })).toBeInstanceOf(LocalSigner);
    expect(LocalSigner.fromEnv({ [LOCAL_SEED_VARIABLE]: SEED })).toBeInstanceOf(LocalSigner);
  });

  it.each([
    ['a missing seed', undefined],
    ['a short seed', 'ab'.repeat(31)],
    ['upper case hex', 'AB'.repeat(32)],
    ['a Stellar secret seed', `S${'A'.repeat(55)}`],
  ])('refuses %s without showing it', (_label, seed) => {
    const error = thrown(() =>
      LocalSigner.fromEnv({ [LOCAL_SEED_VARIABLE]: seed, NODE_ENV: 'test' }),
    );
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).issues).toEqual([`${LOCAL_SEED_VARIABLE} (invalid)`]);
    if (seed !== undefined) {
      expect(JSON.stringify(error)).not.toContain(seed);
      expect((error as Error).message).not.toContain(seed);
    }
  });

  it('never shows its seed', () => {
    for (const signer of [
      new LocalSigner({ seed: SEED, nodeEnv: 'test' }),
      new LocalAttesterSigner({ seed: SEED, nodeEnv: 'test' }),
    ]) {
      expect(JSON.stringify(signer)).not.toContain(SEED);
      expect(inspect(signer, { depth: 10, showHidden: true })).not.toContain(SEED);
      expect(inspect(signer, { depth: 10 })).not.toContain('3c, 3c');
    }
  });

  it('refuses a ref or payload of the wrong shape', async () => {
    const signer = new LocalSigner({ seed: SEED, nodeEnv: 'test' });
    const bad = [
      signer.address({ kind: 'executor', network: 'stellar:testnet' } as never, OPTS),
      signer.address({ ...EXECUTOR, extra: 1 } as never, OPTS),
      signer.address({ kind: 'executor', network: 'stellar:futurenet', keyId: 'a' } as never, OPTS),
      signer.sign(EXECUTOR, { kind: 'stellar_tx', network: 'stellar:testnet' } as never, OPTS),
      signer.sign(EXECUTOR, { kind: 'raw_bytes', network: 'stellar:testnet' } as never, OPTS),
    ];
    for (const run of bad) await expect(run).rejects.toBeInstanceOf(SignerDeniedError);
  });

  it('answers nothing for a caller that has given up', async () => {
    const controller = new AbortController();
    controller.abort();
    const opts: CallOptions = { ...OPTS, signal: controller.signal };
    const signer = new LocalSigner({ seed: SEED, nodeEnv: 'test' });
    const attester = new LocalAttesterSigner({ seed: SEED, nodeEnv: 'test' });
    await expect(signer.address(EXECUTOR, opts)).rejects.toBeInstanceOf(SignerUnavailableError);
    await expect(signer.health(opts)).rejects.toBeInstanceOf(SignerUnavailableError);
    await expect(attester.publicKey('stellar:testnet', opts)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
  });
});
