# @ujira/identity

Decides whether a recipient may be paid on a payout method under a mandate instance.

## Eligibility

`createIdentityService(ports).eligibility(ctx, { recipientId, methodId, mandateInstanceId })` returns `{ eligible: true, assurance, expiresAt }` or `{ eligible: false, reason }`. Reasons come from the closed list `ELIGIBILITY_REFUSAL_REASONS`. Malformed ids, a malformed tenant and invalid stored settings throw typed errors instead.

What a payout needs is data, never a chain test:

- The project's `identity.recipientRequirement`: `self_pre_kyc` (the default) needs a verified Self document proof, `principal_attested` needs the principal's own verification, and `none` needs nothing. `none` is honoured on allowlist mandates only; under an attested or both mandate the default applies.
- A rail that declares `requiresRecipientKyc` also needs the delivering anchor's verified SEP-12 KYC, matched on the method's anchor.

Checks run in a fixed order and the first failure decides the reason: mandate instance, recipient, payout method, rail, then each needed verification. A provider switched off with `identity.providers.<name>.enabled` refuses with `PROVIDER_UNAVAILABLE`, but only for payouts that need that provider.

## Attestation

`createAttestationService(ports).attest(ctx, { attemptId, legIndex, mandateInstanceId, methodId })` is internal and never a public route. It runs these checks in order, and the first that fails decides the reason (`ATTESTATION_REFUSAL_REASONS`):

1. The instance is active, in attested or both mode, and the attester key on chain is the attester's own key (`MANDATE_INACTIVE`, `WRONG_RECIPIENT_MODE`, `ATTESTER_MISMATCH`).
2. The leg's recipient is active (`RECIPIENT_INACTIVE`).
3. The destination comes from an active payout method of that recipient, never from the caller (`DESTINATION_NOT_BOUND`).
4. The method's latest evidence is accepted for the mode (`DESTINATION_UNVERIFIED`). Attested mode accepts a wallet signature, a partner confirmation, or a forwarder built on a wallet verified by signature or session; both mode accepts any recorded level.
   4a. `checkDestination` with the destination, the mandate's asset, the leg amount and the proof's signer, read fresh: `DESTINATION_NOT_RECEIVABLE` with its reason, `DESTINATION_UNVERIFIED` for a signer that is no longer current, `PROVIDER_UNAVAILABLE` on an outage.
5. The identity requirement is met and not expired (`IDENTITY_REQUIRED`, with the eligibility reason as detail).
6. The recipient's country is in the mandate's policy and is the method's country (`COUNTRY_NOT_ALLOWED`).
7. The stored list hashes to the stored hash and to the hash on chain (`POLICY_HASH_MISMATCH`). The hash is SHA-256 of the codes, each once, sorted and comma joined (`countryPolicyHash`).
8. `valid_until = min(now + ttl, identity expiry)`, refused under 60 seconds (`VALIDITY_TOO_SHORT`).
9. The attestation row is inserted as pending and committed, then the attester signs, then the row is marked signed or failed.

A refusal writes nothing and signs nothing. Every chain and attester call has a timeout (`identity.attestation.callTimeoutMs`); an outage refuses with `PROVIDER_UNAVAILABLE`, a fault or the caller giving up is thrown. A signing failure marks the row failed and throws `AttestationSigningError`.

## Self Pre-KYC

`createSelfVerification(ports)` runs recipient verification with Self. UJIRA never holds the recipient's documents.

- `startSelfSession(ctx, { recipientId, returnUrl })` starts the one Pre-KYC flow of the environment. The flow rules are fixed: minimum age 18, OFAC on, the excluded countries from config, no reveals, high security, backend mode. The identity row id is the session's `externalUuid` and the TTL is 1800 seconds. An unexpired pending session is handed back instead of a new one.
- `handleWebhook({ rawBody, headers, correlationId })` answers `POST /v1/identity/self-webhook` in `packages/api`. It checks the signature over the exact bytes and the signed time, the environment and the flow id, then dedupes on `<verification_id>-completed` and maps by `external_uuid`. A result older than the one already applied changes nothing, and neither does an error or lapsed session after a final result.
- A valid result sets `verified`, assurance `document_zk`, for 365 days. A valid result for a person already verified as another recipient of the same principal is stored as `rejected` with `duplicate_person`, and the principal is alerted. `SELF_CREDITS_EXHAUSTED` alerts operations and leaves the recipient pending.
- Only references, statuses, an HMAC of the nullifier and a SHA-256 of the raw body are stored. The proof, the user context data and the body are discarded.
- A `sk_test_` key is refused in production and a `sk_live_` key everywhere else.

The webhook signature scheme here (`self-signature: t=<time>,v1=<HMAC-SHA256 of "<time>.<body>">`) and the payload fields are provisional until the Self spike records real deliveries. Self's own verifier plugs in behind `SelfWebhookVerifier`.

## Wallet proof

`createWalletProofFlow(ports)` records that a recipient controls a payout destination, the evidence attest reads.

- `createWalletChallenge(ctx, { recipientId, methodId })` issues the adapter's challenge text for an active method of that recipient, valid for 600 seconds. Only hashes of the nonce and the text are stored, so the wallet's copy comes back with the proof. The host in the text comes from the adapter's configuration, never from a request.
- `submitWalletProof(ctx, { challengeId, message, nonce, signature, signer? })` checks the challenge, verifies the signature through the adapter, and runs `checkDestination` before anything is written. A challenge is consumed in the same write that records the proof, so it backs one row however many proofs race for it. A proof that fails leaves the challenge open until it expires, so a recipient who adds a missing trustline can send it again.
- A refusal is a result: `WALLET_PROOF_INVALID`, `WALLET_PROOF_EXPIRED`, `WALLET_SIGNER_NOT_AUTHORIZED` or `DESTINATION_NOT_RECEIVABLE` with its reason. A chain outage throws `ProviderUnavailableError`.
- `levelAcceptedForMode` is the table of which evidence each recipient mode takes.

## Ports

The service is given an `IdentityStore`, a `RailCatalog` (`railCatalogFromRegistry` reads the adapters' declared rails), the validated configuration and a clock. Attestation adds the chain calls (`AttestationChain`), the `AttesterSigner`, the `AttestationLog` and the payouts service's legs. Self adds a `SelfClient`, a `SelfWebhookVerifier`, the `ProviderEventStore` dedupe table, `IdentityAlerts` and the `IdentityWriteStore` side of the store. The stores and the log are implemented in the database package once the identity, event and attestation tables exist. `@ujira/identity/testing` has in-memory stores, a fake chain that builds the real 47 byte message, a local ed25519 attester, row builders and a ready attestation world with one breaker per check.

## Rules

- No chain SDK and no chain or network comparison here. The root lint rule `ujira/no-chain-branching` covers this package, and `src/chain-branching-lint.test.ts` pins it.
- Coverage is 95 percent on every metric: `pnpm --filter @ujira/identity test`.
