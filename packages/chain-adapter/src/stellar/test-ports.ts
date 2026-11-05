// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Ports for testing the Stellar adapter: a store that fences executor leases
// the way the database store must, a sponsorship policy that records what it
// was asked, and a signer over local keypairs. Test code only: the signer
// holds raw keys in memory, which nothing outside a test may do.

import { randomUUID } from 'node:crypto';

import { TransactionBuilder } from '@stellar/stellar-sdk/base';
import type { Keypair } from '@stellar/stellar-sdk/base';

import { InvalidInputError, SignerDeniedError } from '../errors.js';
import { canMoveSubmission } from '../submission-states.js';
import type { NetworkId, StellarNetworkId } from '../networks.js';
import type { SignerProvider, SignerRef } from '../signer.js';
import type {
  AdapterStore,
  ExecutorLease,
  SponsorshipPolicy,
  SubmissionRecord,
  UnixSeconds,
} from '../types.js';
import { PASSPHRASES } from './tx.js';

export interface MemoryStore extends AdapterStore {
  readonly submissions: Map<string, SubmissionRecord>;
  readonly releases: { readonly leaseId: string; readonly sequenceOrNonce: bigint }[];
}

/**
 * Executor accounts by address. Each lease gets a new lease id and makes
 * every earlier lease of the account stale, so a release with an old id is
 * refused, as the database store does after a takeover.
 */
export function memoryStore(
  network: NetworkId,
  executors: readonly { readonly address: string; readonly keyId: string }[],
  now: () => UnixSeconds,
): MemoryStore {
  const current = new Map<string, string>();
  let next = 0;
  const submissions = new Map<string, SubmissionRecord>();
  const releases: { leaseId: string; sequenceOrNonce: bigint }[] = [];
  const unsupported = (): Promise<never> => Promise.reject(new Error('not used by these tests'));
  return {
    submissions,
    releases,
    recordSubmission(s) {
      const key = `${s.network}:${s.txHash}`;
      if (submissions.has(key)) return Promise.reject(new Error('duplicate submission'));
      submissions.set(key, s);
      return Promise.resolve();
    },
    updateSubmission(scope, net, txHash, patch) {
      const key = `${net}:${txHash}`;
      const row = submissions.get(key);
      if (row?.scope.principalId !== scope.principalId || row.scope.projectId !== scope.projectId) {
        return Promise.reject(new Error('no such submission for this tenant'));
      }
      // The same refusal the database gives, so a test cannot pass on a move
      // that production would reject.
      if (patch.state !== undefined && !canMoveSubmission(row.state, patch.state)) {
        return Promise.reject(new Error(`no move from ${row.state} to ${patch.state}`));
      }
      submissions.set(key, { ...row, ...patch });
      return Promise.resolve();
    },
    findSubmission(scope, net, txHash) {
      const row = submissions.get(`${net}:${txHash}`);
      return Promise.resolve(
        row?.scope.principalId === scope.principalId && row.scope.projectId === scope.projectId
          ? row
          : null,
      );
    },
    leaseExecutor(net, leaseSeconds) {
      const account = executors[next % executors.length];
      next += 1;
      if (account === undefined || net !== network) {
        return Promise.reject(new Error('no executor'));
      }
      const leaseId = randomUUID();
      current.set(account.address, leaseId);
      const lease: ExecutorLease = {
        network,
        address: { network, value: account.address },
        keyId: account.keyId,
        sequenceOrNonce: 0n,
        leaseId,
        expiresAt: (now() + BigInt(leaseSeconds)) as UnixSeconds,
      };
      return Promise.resolve(lease);
    },
    releaseExecutor(lease, after) {
      if (current.get(lease.address.value) !== lease.leaseId) {
        return Promise.reject(new InvalidInputError({ issues: ['lease.leaseId (stale)'] }));
      }
      current.delete(lease.address.value);
      releases.push({ leaseId: lease.leaseId, sequenceOrNonce: after.sequenceOrNonce });
      return Promise.resolve();
    },
    liveSubmission: unsupported,
    unresolvedSubmissions: unsupported,
    upsertDelivery: unsupported,
    liveDelivery: unsupported,
  };
}

export interface RecordingSponsorship extends SponsorshipPolicy {
  readonly calls: {
    readonly kind: 'reserve' | 'settle' | 'release' | 'book';
    readonly id: string;
  }[];
}

export function recordingSponsorship(deny = false): RecordingSponsorship {
  const calls: { kind: 'reserve' | 'settle' | 'release' | 'book'; id: string }[] = [];
  return {
    calls,
    reserve(r) {
      calls.push({ kind: 'reserve', id: r.reservationId });
      return deny ? Promise.reject(new Error('denied')) : Promise.resolve();
    },
    settle(r) {
      calls.push({ kind: 'settle', id: r.reservationId });
      return Promise.resolve();
    },
    release(r) {
      calls.push({ kind: 'release', id: r.reservationId });
      return Promise.resolve();
    },
    book(r) {
      calls.push({ kind: 'book', id: r.reservationId });
      return Promise.resolve();
    },
  };
}

function refKey(ref: SignerRef): string {
  return ref.kind === 'executor' ? `executor:${ref.keyId}` : ref.kind;
}

/**
 * Signs transactions and fee bumps with local keypairs, keyed as
 * `executor:<keyId>` and `fee_sponsor`. Any other ref or payload is refused.
 */
export function keypairSigner(
  network: StellarNetworkId,
  keys: ReadonlyMap<string, Keypair>,
): SignerProvider {
  const keyFor = (ref: SignerRef): Keypair => {
    const key = keys.get(refKey(ref));
    if (key === undefined) throw new SignerDeniedError({ network });
    return key;
  };
  return {
    // Run inside a promise so a refusal is a rejection, as from a real signer.
    sign: (ref, payload) =>
      Promise.resolve().then(() => {
        const key = keyFor(ref);
        if (
          payload.kind !== 'stellar_tx' &&
          payload.kind !== 'stellar_fee_bump' &&
          payload.kind !== 'stellar_reserve_sandwich'
        ) {
          throw new SignerDeniedError({ network });
        }
        const hash = TransactionBuilder.fromXdr(payload.xdr, PASSPHRASES[network]).hash();
        return {
          kind: 'ed25519',
          signature: key.sign(hash),
          publicKey: key.rawPublicKey(),
        } as const;
      }),
    address: (ref) => Promise.resolve().then(() => ({ network, value: keyFor(ref).publicKey() })),
    health: () => Promise.reject(new Error('not used by these tests')),
  };
}
