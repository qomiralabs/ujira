// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the served key check (service/registry.ts).
 *
 * verifyServedKeys asks the signer for the address of every active row of
 * the purposes a service serves and resolves with their count when each is
 * the recorded address. A local key in production is SIGNER_DENIED before
 * the signer is asked, a different address is SIGNER_ADDRESS_MISMATCH, no
 * row at all is SIGNER_DENIED, and a sep10 row with no anchor is
 * SIGNER_DENIED.
 */

import type { SignerProvider, SignerRef } from '@ujira/chain-adapter';
import { describe, expect, it, vi } from 'vitest';

import { LocalSigner } from '../local-signer.js';
import { OPTS, TEST_SEED, codeOf } from '../testing/service.js';
import { memorySigningKeyRegistry, refOfRow, verifyServedKeys } from './index.js';
import type { SigningKeyPurpose, SigningKeyRow } from './index.js';

const NETWORK = 'stellar:testnet';
const signer = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
const CHAIN = new Set<SigningKeyPurpose>(['executor', 'fee_sponsor', 'sep10']);

async function row(
  purpose: SigningKeyPurpose,
  extra: Partial<SigningKeyRow> = {},
): Promise<SigningKeyRow> {
  const base: SigningKeyRow = {
    purpose,
    network: NETWORK,
    anchorId: purpose === 'sep10' ? 'anchor.example' : null,
    provider: 'local',
    keyRef: purpose === 'executor' ? 'executor_0' : purpose,
    address: '',
    ...extra,
  };
  return { ...base, address: (await signer.address(refOfRow(base), OPTS)).value, ...extra };
}

describe('verifyServedKeys', () => {
  it('passes when every served key controls its recorded account', async () => {
    const rows = [
      await row('executor'),
      await row('fee_sponsor'),
      await row('sep10'),
      await row('attester'),
    ];
    const registry = memorySigningKeyRegistry(rows);
    expect(
      await verifyServedKeys({
        provider: signer,
        registry,
        purposes: CHAIN,
        nodeEnv: 'test',
        opts: OPTS,
      }),
    ).toBe(3);
    expect(
      await verifyServedKeys({
        provider: signer,
        registry,
        purposes: new Set(['attester']),
        opts: OPTS,
      }),
    ).toBe(1);
  });

  it('stops on a key that controls another account', async () => {
    const wrong = await row('fee_sponsor', { address: (await row('executor')).address });
    const registry = memorySigningKeyRegistry([await row('executor'), wrong]);
    expect(
      await codeOf(
        verifyServedKeys({
          provider: signer,
          registry,
          purposes: CHAIN,
          nodeEnv: 'test',
          opts: OPTS,
        }),
      ),
    ).toBe('SIGNER_ADDRESS_MISMATCH');
  });

  it('refuses a local key in production before asking the signer', async () => {
    const address = vi.fn<SignerProvider['address']>();
    const spy: SignerProvider = { sign: vi.fn(), health: vi.fn(), address };
    const registry = memorySigningKeyRegistry([
      await row('executor', { provider: 'aws_kms' }),
      await row('sep10'),
    ]);
    expect(
      await codeOf(
        verifyServedKeys({
          provider: spy,
          registry,
          purposes: CHAIN,
          nodeEnv: 'production',
          opts: OPTS,
        }),
      ),
    ).toBe('SIGNER_DENIED');
    expect(address).not.toHaveBeenCalled();
  });

  it('refuses a service with nothing to serve, and a sep10 row with no anchor', async () => {
    expect(
      await codeOf(
        verifyServedKeys({
          provider: signer,
          registry: memorySigningKeyRegistry(),
          purposes: CHAIN,
          opts: OPTS,
        }),
      ),
    ).toBe('SIGNER_DENIED');
    const orphan: SigningKeyRow = { ...(await row('sep10')), anchorId: null };
    expect(() => refOfRow(orphan)).toThrow();
    const ref: SignerRef = refOfRow(await row('attester'));
    expect(ref).toEqual({ kind: 'attester', network: NETWORK });
  });
});
