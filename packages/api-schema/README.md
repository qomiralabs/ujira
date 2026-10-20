# @ujira/api-schema

The typed contract for the v1 read API, written as zod schemas. The API
validates its responses against it and generates its OpenAPI document from it;
the dashboard builds against the fixtures and mocks it ships.

## Entry points

- `@ujira/api-schema`: the schemas and their types, the route table, the
  money wire helpers (`toWireMoney`, `fromWireMoney`, `toWireToken`,
  `fromWireToken`), `parseQuery`, `buildProblem`, `assertMatchesSchema`,
  `assertResponseMatchesSchema` and `buildOpenApiDocument`.
- `@ujira/api-schema/fixtures`: `generateFixtures({ seed, payouts, edge })`,
  deterministic for a given seed, and `edgeFixtures()`, which covers every
  status and method, right to left and long names, several dollar currencies,
  zero and maximum amounts, every low-balance case and 10,000 payouts.
- `@ujira/api-schema/msw`: `createHandlers({ fixtures, scope })`, mock handlers
  for every read route with tenant scoping, filters, keyset pages and problem
  bodies. `msw` is an optional peer dependency, needed only for this entry.

## Rules the schemas enforce

- Money is an integer count of minor units carried as a string, with its
  currency and scale. Numbers, decimal strings and the wrong scale are refused.
- `safeParse` returns a result for every input and never throws, so a caller
  does not need to wrap it. A cross-field rule stays quiet when a field it
  reads has already been rejected, rather than converting text it cannot
  trust.
- Token amounts name their network, and totals are checked exactly (legs add
  up to the settlement amount, charged is settlement plus take).
- Every tenant resource carries `principalId` and `projectId`.
- Statuses, methods and the other enums are closed lists.

## OpenAPI

`openapi/openapi.json` is generated from the schemas and committed for review.
A test fails when it drifts. After changing a schema, regenerate it with
`pnpm --filter @ujira/api-schema openapi` and review the diff.
