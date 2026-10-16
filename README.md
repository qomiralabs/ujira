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

| Command             | What it does                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`        | Builds every package through Turborepo                                                                                                                                                      |
| `pnpm typecheck`    | Checks package scripts, then runs `tsc` in strict mode on every package, root level files and `scripts/`                                                                                    |
| `pnpm lint`         | Checks package scripts, then runs type-aware ESLint with `--max-warnings 0` on packages, root files and `scripts/`                                                                          |
| `pnpm format:check` | Checks formatting with Prettier                                                                                                                                                             |
| `pnpm test`         | Runs the tests of every package under `packages/` and `apps/` in one Vitest run, with an 85 percent coverage threshold over their `src/` TypeScript files (test and `.d.ts` files excluded) |

Every source file starts with the proprietary license header below, with the year the file was created (any four digit year is accepted). `pnpm lint` fails on any source file without it, in a package or at the root. A source file that no `tsconfig.json` includes also fails lint, so nothing slips past the checks. Every folder with a `package.json` under `packages/` or `apps/` must be a workspace member matched by a `<dir>/*` glob in `pnpm-workspace.yaml`, and must define `build`, `lint`, `typecheck` and `test` scripts that do not suppress failures (no `||` or `; true`). Its `lint` script must set `--max-warnings 0` exactly once. Symlinked folders, folders without a `package.json` and loose files directly in `packages/` or `apps/` are rejected.

```ts
// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.
```

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `development`, `staging` and `main`. A single `Verify` job lints the workflow files with actionlint, installs with `pnpm install --frozen-lockfile`, then runs `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (the coverage report is uploaded as the `coverage` artifact) and `pnpm audit --prod`. Any failing step fails the run, and a newer push to the same ref cancels the run in progress.

Node.js comes from `.nvmrc` and pnpm from `packageManager`, and the pnpm store is cached on the hash of `pnpm-lock.yaml`. Every third-party action is pinned to a full commit SHA with its release tag in a trailing comment, and the workflow token is read only. To bump an action, resolve the new tag to its commit SHA (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, dereferencing annotated tags) and update both the SHA and the comment.

Run the workflow linter locally with `actionlint` before pushing changes to `.github/workflows/`.
