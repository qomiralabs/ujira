# @ujira/identity

Decides whether a recipient may be paid on a payout method under a mandate instance.

## Eligibility

`createIdentityService(ports).eligibility(ctx, { recipientId, methodId, mandateInstanceId })` returns `{ eligible: true, assurance, expiresAt }` or `{ eligible: false, reason }`. Reasons come from the closed list `ELIGIBILITY_REFUSAL_REASONS`. Malformed ids, a malformed tenant and invalid stored settings throw typed errors instead.

What a payout needs is data, never a chain test:

- The project's `identity.recipientRequirement`: `self_pre_kyc` (the default) needs a verified Self document proof, `principal_attested` needs the principal's own verification, and `none` needs nothing. `none` is honoured on allowlist mandates only; under an attested or both mandate the default applies.
- A rail that declares `requiresRecipientKyc` also needs the delivering anchor's verified SEP-12 KYC, matched on the method's anchor.

Checks run in a fixed order and the first failure decides the reason: mandate instance, recipient, payout method, rail, then each needed verification. A provider switched off with `identity.providers.<name>.enabled` refuses with `PROVIDER_UNAVAILABLE`, but only for payouts that need that provider.

## Ports

The service is given an `IdentityStore`, a `RailCatalog` (`railCatalogFromRegistry` reads the adapters' declared rails), the validated configuration and a clock. The store is implemented in the database package once the recipient and identity tables exist. `@ujira/identity/testing` has an in-memory store and row builders.

## Rules

- No chain SDK and no chain or network comparison here. The root lint rule `ujira/no-chain-branching` covers this package, and `src/chain-branching-lint.test.ts` pins it.
- Coverage is 95 percent on every metric: `pnpm --filter @ujira/identity test`.
