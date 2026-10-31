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

| Variable                       | Default     | Meaning                                  |
| ------------------------------ | ----------- | ---------------------------------------- |
| `UJIRA_API_PORT`               | `8080`      | Port to listen on                        |
| `UJIRA_API_HOST`               | `127.0.0.1` | Address to bind; loopback by default     |
| `UJIRA_API_REQUEST_TIMEOUT_MS` | `10000`     | Deadline for every request, 100 to 60000 |
| `UJIRA_API_BODY_LIMIT_BYTES`   | `1048576`   | Largest JSON body accepted               |

Until token authentication lands, the local server refuses every key, so only
the public routes answer.

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
  body: CreatePayoutRequest,
  response: { status: 201, name: 'PayoutDetail', schema: PayoutDetail },
  errors: ['DESTINATION_INVALID', 'MANDATE_REFUSED'],
  handler: async ({ body }, { tenant, call, log }) => {
    /* ... */
  },
});
```

`definePublicRoute` is for routes with no tenant, such as health. It must say
why it needs no key, its handler gets no tenant, and it must return no tenant
data.

### What the pipeline does for every route

In order: a request id (the `Request-Id` header, and `call.correlationId` for
adapter calls); a deadline (`signal`, which aborts after the request timeout);
for tenant routes, the credential and then the route's scope; path, query and
body validation; the handler; the response, parsed by its schema; for tenant
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
  tenant is `NOT_FOUND`), `DatabaseUnavailableError` from `@ujira/db` is
  `DB_UNAVAILABLE`, and anything unknown is `INTERNAL`, logged by class name
  only.
- `DB_UNAVAILABLE`, `CHAIN_UNAVAILABLE`, `REQUEST_TIMEOUT` (503) and
  `RATE_LIMITED` (429) carry `Retry-After`. An adapter error's `retryAfterMs`
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
