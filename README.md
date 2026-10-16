# ujira

UJIRA: pay people anywhere in their own money. Services, router, API, dashboard and onboarding widget.

## Development

Requirements:

- Node.js 24 LTS (the exact version is in `.nvmrc`; run `nvm use`)
- pnpm 12.14.0 (pinned in the `packageManager` field of `package.json`; `corepack enable` picks it up)

TypeScript is pinned to 6.0.3 because typescript-eslint 8 supports only `typescript <6.1.0`. Upgrade to TypeScript 7 once a typescript-eslint release lists it in its peer range.

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Root commands:

| Command             | What it does                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm build`        | Builds every package through Turborepo                                                                             |
| `pnpm typecheck`    | Runs `tsc` in strict mode on every package, root level files and `scripts/`                                        |
| `pnpm lint`         | Checks package scripts, then runs type-aware ESLint with `--max-warnings 0` on packages, root files and `scripts/` |
| `pnpm format:check` | Checks formatting with Prettier                                                                                    |
| `pnpm test`         | Runs every package's tests in one Vitest run with an 85 percent coverage threshold                                 |

Every source file starts with the proprietary license header below, with the year the file was created (any four digit year is accepted). `pnpm lint` fails on any source file without it, in a package or at the root. A source file that no `tsconfig.json` includes also fails lint, so nothing slips past the checks. Every folder with a `package.json` under `packages/` or `apps/` must be a workspace member matched by a `<dir>/*` glob in `pnpm-workspace.yaml`, and must define `build`, `lint`, `typecheck` and `test` scripts that do not suppress failures (no `||` or `; true`). Its `lint` script must pass `--max-warnings 0`. Symlinked folders there are rejected.

```ts
// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.
```
