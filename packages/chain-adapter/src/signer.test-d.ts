// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Compile time checks on the signer port, run by typecheck. Payloads are
// typed intents and results are raw ed25519 bytes, so no key manager's
// encoding can cross the port: a DER blob, a recovery ID or a vendor field
// on SignatureResult fails here.

import type { TokenAmount } from '@ujira/core';
import { describe, expectTypeOf, it } from 'vitest';

import type {
  AdapterPorts,
  AttestationFields,
  AttesterSigner,
  Bytes32,
  CallOptions,
  ChainAddress,
  ChainHealth,
  Destination,
  Ed25519Signature,
  ExternalSignerRole,
  HealthState,
  KeyRef,
  MandateAction,
  MandateActionRequest,
  MandateRef,
  NetworkId,
  PayRequest,
  SignPayload,
  SignatureResult,
  SignerHealth,
  SignerProvider,
  SignerRef,
  SigningSummary,
  StellarNetworkConfig,
  TenantScope,
  UnixSeconds,
  Uuid,
} from './index.js';

interface SignerTypes {
  payload: SignPayload;
  result: SignatureResult;
  ref: SignerRef;
  provider: SignerProvider;
  attester: AttesterSigner;
  fields: AttestationFields;
  health: SignerHealth;
  keyRef: KeyRef;
}

// None may be any.
expectTypeOf<
  { [K in keyof SignerTypes]: 0 extends 1 & SignerTypes[K] ? K : never }[keyof SignerTypes]
>().toBeNever();

describe('the types carry no vendor encoding', () => {
  it('a signature is raw ed25519 bytes and its public key, nothing else', () => {
    expectTypeOf<SignatureResult>().toEqualTypeOf<Ed25519Signature>();
    expectTypeOf<SignatureResult['kind']>().toEqualTypeOf<'ed25519'>();
    expectTypeOf<keyof SignatureResult>().toEqualTypeOf<
      'kind' | 'signature' | 'publicKey' | 'requestId'
    >();
    expectTypeOf<SignatureResult['signature']>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<SignatureResult['publicKey']>().toEqualTypeOf<Uint8Array>();
  });

  it('payloads are typed intents over plain encodings', () => {
    expectTypeOf<SignPayload['kind']>().toEqualTypeOf<
      | 'stellar_tx'
      | 'stellar_fee_bump'
      | 'stellar_reserve_sandwich'
      | 'stellar_auth_entry'
      | 'sep10_challenge'
      | 'attestation'
    >();
    expectTypeOf<SignPayload['network']>().toEqualTypeOf<NetworkId>();
    expectTypeOf<Extract<SignPayload, { kind: 'stellar_tx' }>['xdr']>().toEqualTypeOf<string>();
    expectTypeOf<
      Extract<SignPayload, { kind: 'stellar_fee_bump' }>['xdr']
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Extract<SignPayload, { kind: 'stellar_auth_entry' }>['entryXdr']
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Extract<SignPayload, { kind: 'sep10_challenge' }>['xdr']
    >().toEqualTypeOf<string>();
    // Attestations are fields the signer lays out itself, never raw bytes.
    expectTypeOf<
      Extract<SignPayload, { kind: 'attestation' }>['fields']
    >().toEqualTypeOf<AttestationFields>();
  });

  it('attestation fields are structured, with the destination address and tag', () => {
    expectTypeOf<AttestationFields>().toEqualTypeOf<{
      readonly mandate: MandateRef;
      readonly recipientRef: Bytes32;
      readonly countryPolicyHash: Bytes32;
      readonly policyEpoch: bigint;
      readonly validUntil: UnixSeconds;
      readonly destination: Destination;
    }>();
    expectTypeOf<AttestationFields['destination']>().toEqualTypeOf<{
      readonly address: ChainAddress;
      readonly tag: bigint | null;
    }>();
  });

  it('the port takes call options and returns plain shapes', () => {
    expectTypeOf<Parameters<SignerProvider['sign']>>().toEqualTypeOf<
      [SignerRef, SignPayload, CallOptions]
    >();
    expectTypeOf<ReturnType<SignerProvider['sign']>>().toEqualTypeOf<Promise<SignatureResult>>();
    expectTypeOf<ReturnType<SignerProvider['address']>>().toEqualTypeOf<Promise<ChainAddress>>();
    expectTypeOf<ReturnType<SignerProvider['health']>>().toEqualTypeOf<Promise<SignerHealth>>();
    expectTypeOf<Parameters<SignerProvider['health']>[0]>().toEqualTypeOf<CallOptions>();
    expectTypeOf<Parameters<AttesterSigner['signAttestation']>>().toEqualTypeOf<
      [AttestationFields, CallOptions]
    >();
    expectTypeOf<ReturnType<AttesterSigner['signAttestation']>>().toEqualTypeOf<
      Promise<SignatureResult>
    >();
    expectTypeOf<ReturnType<AttesterSigner['publicKey']>>().toEqualTypeOf<Promise<Uint8Array>>();
  });

  it('signer health reports state, latency and reasons', () => {
    expectTypeOf<SignerHealth['state']>().toEqualTypeOf<HealthState>();
    expectTypeOf<SignerHealth['signP95Ms']>().toEqualTypeOf<number | null>();
    expectTypeOf<SignerHealth['reasons']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<ChainHealth['signerHealthy']>().toEqualTypeOf<boolean>();
  });
});

describe('signer refs', () => {
  it('names every key UJIRA holds and the external wallet', () => {
    expectTypeOf<SignerRef['kind']>().toEqualTypeOf<
      'executor' | 'fee_sponsor' | 'sep10' | 'managed_agent' | 'attester' | 'external'
    >();
    expectTypeOf<SignerRef['network']>().toEqualTypeOf<NetworkId>();
    expectTypeOf<Extract<SignerRef, { kind: 'executor' }>['keyId']>().toEqualTypeOf<string>();
    expectTypeOf<Extract<SignerRef, { kind: 'sep10' }>['anchorId']>().toEqualTypeOf<string>();
  });

  it('a managed agent key is bound to its tenant', () => {
    expectTypeOf<
      Extract<SignerRef, { kind: 'managed_agent' }>['scope']
    >().toEqualTypeOf<TenantScope>();
    expectTypeOf<Extract<SignerRef, { kind: 'managed_agent' }>['agentId']>().toEqualTypeOf<Uuid>();
  });

  it('external ref with role recovery', () => {
    expectTypeOf<{
      readonly kind: 'external';
      readonly network: 'stellar:testnet';
      readonly role: 'recovery';
      readonly address: ChainAddress;
    }>().toExtend<SignerRef>();
    expectTypeOf<'recovery'>().toExtend<ExternalSignerRole>();
    expectTypeOf<ExternalSignerRole>().toEqualTypeOf<
      'principal' | 'agent' | 'approver' | 'guardian' | 'recovery'
    >();
    // Executors are UJIRA's channel accounts and never sign as an external wallet.
    expectTypeOf<{
      readonly kind: 'external';
      readonly network: NetworkId;
      readonly role: 'executor';
      readonly address: ChainAddress;
    }>().not.toExtend<SignerRef>();
    // A recovery action names its recovery member as the signer.
    expectTypeOf<{
      readonly scope: TenantScope;
      readonly mandate: MandateRef;
      readonly action: { readonly op: 'recovery_revoke' };
      readonly signer: Extract<SignerRef, { kind: 'external' }>;
    }>().toExtend<MandateActionRequest>();
  });

  it('requests and the adapter ports carry the signer', () => {
    expectTypeOf<MandateActionRequest['signer']>().toEqualTypeOf<SignerRef>();
    expectTypeOf<PayRequest['signer']>().toEqualTypeOf<SignerRef>();
    expectTypeOf<AdapterPorts['signer']>().toEqualTypeOf<SignerProvider>();
  });

  it('the signing summary covers every mandate action, the five new ones included', () => {
    expectTypeOf<MandateAction['op']>().toExtend<SigningSummary['action']>();
    expectTypeOf<
      | 'set_recovery_threshold'
      | 'lower_fee_cap'
      | 'cancel_principal_proposal'
      | 'recovery_revoke'
      | 'recovery_rotate_agent'
    >().toExtend<SigningSummary['action']>();
    expectTypeOf<SigningSummary['amount']>().toEqualTypeOf<TokenAmount | undefined>();
  });
});

describe('key references', () => {
  it('configuration pins provider, key ID and address, and holds no secret', () => {
    expectTypeOf<KeyRef>().toEqualTypeOf<{
      readonly provider: string;
      readonly keyId: string;
      readonly address: string;
    }>();
    expectTypeOf<StellarNetworkConfig['executor']['keys'][number]>().toEqualTypeOf<KeyRef>();
    expectTypeOf<StellarNetworkConfig['sep10'][number]>().toEqualTypeOf<{
      readonly anchorId: string;
      readonly key: KeyRef;
    }>();
  });
});
