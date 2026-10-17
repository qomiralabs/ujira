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

| Command               | What it does                                                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`          | Builds every package through Turborepo                                                                                                                                                                                                                                           |
| `pnpm typecheck`      | Checks package scripts, then runs `tsc` in strict mode on every package, root level files and `scripts/`                                                                                                                                                                         |
| `pnpm lint`           | Checks package scripts, then runs type-aware ESLint with `--max-warnings 0` on packages, root files and `scripts/`                                                                                                                                                               |
| `pnpm format:check`   | Checks formatting with Prettier                                                                                                                                                                                                                                                  |
| `pnpm test`           | Runs the tests of every package under `packages/` and `apps/` in one Vitest run, with an 85 percent coverage threshold over their `src/` TypeScript files (test and `.d.ts` files excluded)                                                                                      |
| `pnpm licenses:check` | Checks the license of every production and dev dependency of every workspace project against its allowlist (dev adds MPL-2.0), cross checks the listing against `pnpm-lock.yaml`, and fails naming each package, version and license; on success writes `THIRD_PARTY_NOTICES.md` |

Every source file starts with the proprietary license header below, with the year the file was created (any four digit year is accepted). `pnpm lint` fails on any source file without it, in a package or at the root. A source file that no `tsconfig.json` includes also fails lint, so nothing slips past the checks. Every folder with a `package.json` under `packages/` or `apps/` must be a workspace member matched by a `<dir>/*` glob in `pnpm-workspace.yaml`, and must define `build`, `lint`, `typecheck` and `test` scripts that do not suppress failures (no `||` or `; true`). Its `lint` script must set `--max-warnings 0` exactly once. Symlinked folders, folders without a `package.json` and loose files directly in `packages/` or `apps/` are rejected.

```ts
// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.
```

Commit `THIRD_PARTY_NOTICES.md` whenever dependencies change. The file is generated, sorted and platform independent, so a rerun on an unchanged lockfile leaves no diff.

Packages that declare `os`, `cpu` or `libc` are installed only on matching platforms, so `pnpm licenses list` cannot see most of them. Each one in `pnpm-lock.yaml` must have an entry in `scripts/platform-licenses.json` (name, version, license, source URL), and the check fails on any that is missing. Review the license on the registry before adding an entry. The check makes no network calls.

Run the check through pnpm (`pnpm licenses:check`). It uses the pnpm binary that runs the script, never one found on `PATH`, and refuses one installed inside the repository.
