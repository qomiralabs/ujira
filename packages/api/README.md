# @ujira/api

The versioned REST API, on [Hono](https://hono.dev), under `/v1`. Every
endpoint is declared as data in a route table and runs through one shared
pipeline, so validation, tenant scoping, errors, logs and the OpenAPI document
are the same for every route.

## Run it locally

```sh
pnpm --filter @ujira/core --filter @ujira/chain-adapter --filter @ujira/db --filter @ujira/api-schema build
pnpm --filter @ujira/api build
pnpm --filter @ujira/api start
curl -s http://127.0.0.1:8080/v1/health
curl -s http://127.0.0.1:8080/v1/openapi.json
```

Settings, all optional:

| Variable                         | Default     | Meaning                                   |
| -------------------------------- | ----------- | ----------------------------------------- |
| `UJIRA_API_PORT`                 | `8080`      | Port to listen on                         |
| `UJIRA_API_HOST`                 | `127.0.0.1` | Address to bind; loopback by default      |
| `UJIRA_API_REQUEST_TIMEOUT_MS`   | `10000`     | Deadline for every request, 100 to 60000  |
| `UJIRA_API_BODY_LIMIT_BYTES`     | `1048576`   | Largest JSON body accepted                |
| `UJIRA_API_ENVIRONMENT`          | `sandbox`   | `sandbox` or `production`                 |
| `UJIRA_API_EMBED_ORIGINS`        | none        | Origins a browser may send a key from     |
| `UJIRA_API_TRUSTED_PROXY_HEADER` | none        | Forwarded header naming the client        |
| `UJIRA_API_TRUSTED_PROXY_HOP`    | none        | Entry to believe, counted from the right  |
| `UJIRA_API_ADDRESS_HMAC_KEY`     | random      | Keys address digests; production needs it |

The database settings are the `UJIRA_DB_*` ones in `packages/db/.env.example`.
With none of them set, the local server refuses every key, so only the public
routes answer; `production` refuses to start that way.

## Limits on public routes

A public route has no key to limit by, so it names a group with `addressLimit`,
and the pipeline limits it by client address before reading its body. A public
route with no limit has to be on the short list in `client-address.test.ts`.

By default nothing forwarded is believed and the address is the socket's peer, so
a caller cannot choose their own bucket. Behind a proxy that would put every client
in the proxy's one bucket, so production logs `no_trusted_proxy` at startup.

To trust a proxy, set both proxy settings; one without the other refuses to start.
A proxy appends the peer it saw, so hops count from the right, and the right value
is the number of proxies you run in front of the API. With one proxy writing
`X-Forwarded-For`, that is `x-forwarded-for` and `1`. Too low a hop limits your own
proxy, and too high a hop lets a caller choose their bucket.

A missing or malformed entry shares one bucket, and IPv6 is limited per /64. A
bucket's key is a keyed digest, so no address reaches the table or a log.
`UJIRA_API_ADDRESS_HMAC_KEY` is 32 bytes as hex, the same on every instance, from
the secret manager.

## Adding an endpoint

1. Put the request and response schemas in `@ujira/api-schema` (read routes
   go in its `ROUTES` table; write endpoints add their request schemas there
   too). The API imports them; it does not define its own wire shapes.
2. Declare the route in its own file under `src/routes/` and add it to
   `V1_ROUTES` in `src/routes/index.ts`.
3. Regenerate the OpenAPI document with `pnpm --filter @ujira/api openapi`
   and commit `openapi/openapi.json` with the change.

A read route that is already in the contract needs only its scope and handler:

```ts
export const listApprovalsRoute = contractRoute('listApprovals', {
  scope: 'approvals:write',
  handler: async ({ query }, { tenant, call }) => {
    // Hand `tenant` to every repository call and `call` to every adapter call.
    return repository.listApprovals(tenant, query, call.signal);
  },
});
```

Any other tenant route declares its own path, schemas and scope:

```ts
export const createPayoutRoute = defineTenantRoute({
  id: 'createPayout',
  method: 'POST',
  path: '/v1/payouts',
  summary: 'Request a payout',
  scope: 'payouts:write',
  rateLimit: 'payout_creation',
  body: CreatePayoutRequest,
  response: { status: 202, name: 'PayoutAccepted', schema: PayoutAccepted },
  errors: ['DESTINATION_INVALID', 'MANDATE_REFUSED'],
  handler: async ({ body }, { tenant, call, log }) => {
    /* ... */
  },
});
```

`definePublicRoute` is for routes with no tenant, such as health. It must say
why it needs no key, its handler gets no tenant, and it must return no tenant
data.

`defineWebhookRoute` is for a provider's signed delivery. The handler gets the
exact bytes and only the headers it names, and must check the signature before
it believes any of it. `POST /v1/identity/self-webhook` is the first:
`v1Routes({ selfWebhook })` takes anything shaped like the identity service's
`handleWebhook`. The served table uses `SELF_WEBHOOK_NOT_CONFIGURED`, which
answers 503 `WEBHOOK_UNAVAILABLE` until Self has its secrets and durable stores.

`POST /v1/recipients/{id}/methods/{methodId}/wallet-challenges` and
`/wallet-proofs` run the identity service's wallet proof flow for a key with
`recipients:write`. The served table uses `WALLET_PROOF_NOT_CONFIGURED` until
the flow has its tables and the adapter has its wallet proof methods.

`GET /v1/receipts/{id}` and `GET /v1/payouts/{id}/receipt` serve the principal's
copy of a receipt, `GET /v1/receipt-exports` a filtered set as CSV and
`GET /v1/receipts/{id}/pdf` one as a PDF, all for a key with `receipts:read`.
`GET /v1/receipt-verifications/{receiptNumber}?code=` needs no key: the code
printed on a receipt finds it, and the answer is the recipient view and the
result of checking it, with nothing that belongs to a tenant. Until the receipts
tables are in, `v1Routes` has no `ReceiptReads` and all of these answer 503.

### What the pipeline does for every route

In order: a request id (the `Request-Id` header, and `call.correlationId` for
adapter calls); a deadline (`signal`, which aborts after the request timeout);
for tenant routes, the credential, the rate limits and then the route's scope; path, query and
body validation; for tenant writes, the `Idempotency-Key`; the handler; the response, parsed by its schema; for tenant
routes, a check that no `principalId` or `projectId` in the body belongs to
someone else; and one access log line.

Rules that follow from it:

- The tenant comes only from the credential. A handler never reads one from
  the path, the query or the body.
- A handler returns the body; the pipeline sets the status and headers. A
  body that does not match the response schema becomes a 500, never a
  response the document does not describe.
- Money in a body is the contract's wire form: an integer count of minor
  units as a string, with its currency and scale.
- Pass `signal` to anything that waits, and `call` to every chain adapter
  call.

## API keys

A key reads `ujk_<env>_<id>_<secret><checksum>`, all base32 lower case: `env` is
`live` or `test`, `id` is 16 characters (80 random bits), `secret` is 52 characters
(256 random bits) and `checksum` is 7 characters of CRC32 over the rest. The
prefix `ujk_<env>_<id>` names the key and is stored; of the secret only its SHA-256
is stored. Nothing here writes a key, a prefix or a hash to a log.

A key goes in `Authorization: Bearer`, and nowhere else. What is checked, in order:

| Check                                 | Refused with                     | Costs a query    |
| ------------------------------------- | -------------------------------- | ---------------- |
| `Origin`, if sent, is an embed        | `403 ORIGIN_NOT_ALLOWED`         | no               |
| The header, format and checksum       | `401 TOKEN_MALFORMED`            | no               |
| The key's environment                 | `401 TOKEN_ENVIRONMENT_MISMATCH` | records an event |
| Known, secret, not expired or revoked | `401 TOKEN_INVALID`, all alike   | yes              |
| The rate limits                       | `429 RATE_LIMITED`               | yes              |
| The route's scope                     | `403 INSUFFICIENT_SCOPE`         | no               |

`test` keys work only in the sandbox and `live` keys only in production. `/v1`
sends no CORS headers to anyone.

A key refused on its environment or at the lookup is recorded in
`ops.security_events` by its public prefix, and kept for 90 days. If the record
cannot be written the client still gets its refusal, and the failure is logged.

A good lookup is cached for at most 30 seconds, so a revoked key stops working
within that time on every instance. `last_used_at` is written at most once per
five minutes.

The closed list of scopes is `API_SCOPES` in `src/auth.ts`, and the database holds
the same list in a check constraint. Every route declares its scope, and a server
will not start with a route that has none; `src/scopes.test.ts` runs that check
over the whole route table.

### Rate limits

Token buckets in the unlogged table `ops.rate_limit_buckets`, shared by every
instance, one call per request. Every tenant route takes from the key's bucket and
the principal's:

| Bucket                     | Rate       | Burst |
| -------------------------- | ---------- | ----- |
| Per key                    | 20 per sec | 40    |
| Per principal              | 50 per sec | 100   |
| Payout creation, principal | 10 per sec | 10    |

A request takes from every bucket it names or from none, so a key past its own
limit does not use up its principal's bucket. A route opts into the payout limit
with `rateLimit: 'payout_creation'`. Tenant responses carry `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Reset`, for whichever bucket is tightest; a
429 adds `Retry-After`. If the buckets cannot be reached the answer is 503, never
an unlimited request.

## Mandates

`POST /v1/mandates` takes the limits, the recipient mode, the fee cap and, per chain,
the roles. A principal's own wallet signs everything that changes a mandate, so it
answers with one signing request per chain, along with the address the contract
will deploy at, the fee cap beside the agreed rate, whether the operations guardian
is on it, and any warning about a single key principal.

| Route                                              | Prepares or reads                     |
| -------------------------------------------------- | ------------------------------------- |
| `GET /v1/mandates/{id}`                            | Limits, usage, roles, pending changes |
| `GET /v1/mandates/{id}/funding`                    | Per chain funding instructions        |
| `POST /v1/mandates/{id}/lower-fee-cap`             | `lower_fee_cap`                       |
| `POST /v1/mandates/{id}/revoke`                    | `revoke`, and what to withdraw after  |
| `POST /v1/mandates/{id}/withdraw`                  | `withdraw` of the whole balance       |
| `POST /v1/mandates/{id}/cancel-principal-proposal` | `cancel_principal_proposal`           |

A mandate reads as `deploying` until its factory's `mandate_created` event has been
read, whatever is at its address. After a revoke, the mandate names the withdrawal
as its next action until the balance is gone. A withdrawal the principal cannot
receive answers `422 TRANSFER_FAILED` with a `fixes` entry, and nothing changes on
chain; prepare it again with a new key once that is fixed.

A second run of a request, after a process died mid way, finds the rows the first
run wrote, under a unique constraint on the request's key, and hands back the same
mandate and the same things to sign. The create salt comes from the key too, so a
retry can only ever target the same contract.

The served table uses `MANDATES_NOT_CONFIGURED` until an assembled chain adapter and
the production stores exist.

## Recipients

| Route                              | Scope              | Shows                                        |
| ---------------------------------- | ------------------ | -------------------------------------------- |
| `POST /v1/recipients`              | `recipients:write` | The id, country and status, nothing personal |
| `GET /v1/recipients`               | `recipients:read`  | The same for each, nothing personal          |
| `GET /v1/recipients/{id}`          | `recipients:read`  | Personal data and payout methods             |
| `POST /v1/recipients/{id}/methods` | `recipients:write` | The method, without its details              |

Personal data and method details are encrypted through the `PersonalDataCipher` port before anything stores them, under a key bound to the tenant and the recipient. They reach only `recipient_pii` and the method's encrypted columns. A write's answer is stored for replay, so it never holds them, and the server refuses to start with a write route that declares any.

Every destination goes through the capture onboarding uses, so these routes refuse exactly what it refuses, including a muxed or memo destination the rail cannot pay, and an address where a payout would be burned, such as the settlement asset's issuer. `createRecipientEndpoints` takes those addresses as `neverPayable`, from `settlementAddressesOf`. The detail on a refusal is `DESTINATION_INVALID`.

A `reference` names one recipient in a project, so sending it again finds the same recipient, and the first personal data given for it stands. It is stored only as a keyed hash. Without a reference, the idempotency key plays that part, so a retry of one request finds the recipient its first run made.

Until the data keys exist the served table uses `RECIPIENTS_NOT_CONFIGURED`, which answers 503, so nothing personal can be stored unencrypted.

## Payouts

| Route                  | Scope           | Answers                                                        |
| ---------------------- | --------------- | -------------------------------------------------------------- |
| `POST /v1/payouts`     | `payouts:write` | 202 with the id, what was asked for and `queued`               |
| `GET /v1/payouts`      | `payouts:read`  | A page, newest first, under the contract's filters             |
| `GET /v1/payouts/{id}` | `payouts:read`  | Legs, charges, timeline, the rule that allowed it, the receipt |

A create takes the mandate, the recipient, the amount in minor units, and optionally
the method and a task id. A project whose recipients bear the cash-out cost asks in
US dollars, held as the mandate's dollar token at par; one whose principal bears it
asks in the currency the recipient must receive. Leaving out the method takes the
recipient's first active one. A split is not taken yet.

The payout and the worker's job are written in one transaction through a
`PayoutScheduler`, and the answer comes back at once; the payout runs from there.
The payout carries the request's `Idempotency-Key` under a unique constraint of its
own, so a handler run again after its process died finds the first payout, and
schedules nothing. The create takes from the payout creation bucket as well.

A list cursor is signed with the server's cursor key over the caller, the route and
the filters, so an altered cursor, another tenant's, or one sent with other filters
is `400 INVALID_CURSOR`. The page size can change between pages.

`charges` restates the settlement total, the take, the agreed rate and what is
charged, the total plus the take. Until the fee tables are in, the take is the sum of
the live attempt's leg fees. `approvals.required` reads 0 until approvals record
their quorum. A recipient's name is decrypted for the read through `recipientNames`,
and a recipient with none shows a label from its id.

The served table uses `PAYOUTS_NOT_CONFIGURED`, which answers 503, until the worker's
queue is in, so no payout is taken that nothing would run.

## Idempotency

Every tenant write, meaning anything but a `GET`, needs an `Idempotency-Key` header
of up to 255 characters from `A-Za-z0-9_.:-`. Without one the answer is
`400 IDEMPOTENCY_KEY_INVALID`, after the key, the limits and the scope have been
checked and before the handler runs. A key belongs to one project, for 7 days.

| A request with a key that is    | Gets                                             |
| ------------------------------- | ------------------------------------------------ |
| New                             | Runs the handler                                 |
| The same request, finished      | The stored answer, unchanged                     |
| The same request, still running | `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After` |
| A different request             | `422 IDEMPOTENCY_KEY_REUSED`                     |

"The same request" means the method, the path, the query and the exact body bytes.
A replay carries `Idempotent-Replayed: true` and the `Request-Id` of the attempt it
repeats. A 5xx or a 429 is not stored, because it says to try again, so a retry
runs. A body that fails validation uses up nothing, because nothing ran.

The `unique (principal_id, project_id, idempotency_key)` constraint is what decides
who wins a key, so all of this holds across instances. It cannot cover a process
that dies mid request: the lease runs out after two minutes and a retry runs the
handler again. So **a handler that moves money must also write
`context.idempotencyKey` under a unique constraint of its own**.

A write's answer is stored in clear for those 7 days, and personal data has one
home, encrypted. So a write route cannot be declared with personal data in its
response: the server refuses to start with one, by the field's name or by
`personalData()` in the schema. `storedResponseProblems` runs that over the route
table. A read route serves personal data instead, which is not stored.

## Errors

Every failure is an RFC 9457 problem body with a stable `code`, a fixed
`title`, the `status` and the `requestId`, sent as
`application/problem+json`. Codes are defined once, in `PROBLEM_CODES` in
`@ujira/api-schema`, and are never renamed or moved to another status.

- Throw `new ApiError(code, { detail, errors })` for a failure the handler
  knows about. `detail` is fixed text: never a value from the request or from
  a dependency.
- Let anything else escape. `toApiError` maps it: chain adapter errors by
  `ADAPTER_ERROR_MAP` (an outage is `CHAIN_UNAVAILABLE`, a mandate of another
  tenant is `NOT_FOUND`), mandate refusals by their spec name through
  `MANDATE_ERROR_MAP`, which covers every rule in the vendored spec table, `DatabaseUnavailableError` from `@ujira/db` is
  `DB_UNAVAILABLE`, and anything unknown is `INTERNAL`, logged by class name
  only.
- `DB_UNAVAILABLE`, `CHAIN_UNAVAILABLE`, `REQUEST_TIMEOUT` (503),
  `RATE_LIMITED` (429) and `IDEMPOTENCY_IN_PROGRESS` (409) carry `Retry-After`. An adapter error's `retryAfterMs`
  can lengthen it.
- A path id that does not parse is `NOT_FOUND`. A bad query is
  `INVALID_FILTER` (or, for contract routes, `INVALID_CURSOR` and
  `LIMIT_OUT_OF_RANGE` as `parseQuery` decides). A bad body is
  `INVALID_REQUEST` with field errors; a body that is not JSON is
  `UNSUPPORTED_MEDIA_TYPE`, and one over the limit `PAYLOAD_TOO_LARGE`.
- An unknown path is `NOT_FOUND`; a known path with the wrong method is
  `METHOD_NOT_ALLOWED` with `Allow`.

## Logs

One JSON object per line, with a closed set of fields (`LogFields` in
`src/log.ts`): route template, method, status, duration, principal, project,
error code and class name, issue paths, a resource id and a count. There is no
field for a message, a header, a query value or a body, so personal data has
nowhere to go. Handlers log through `context.log`, which attaches the request
id.

## OpenAPI

`openapi/openapi.json` is generated from `V1_ROUTES` and committed. It is
served at `GET /v1/openapi.json`. Components keep the names they have in
`@ujira/api-schema`, and only the ones some route reaches are included. CI
runs `pnpm --filter @ujira/api openapi:check`, which fails when the committed
document is stale.
