# ujira

UJIRA: pay people anywhere in their own money. Services, router, API, dashboard and onboarding widget.

## Development

Requirements:

- Node.js 24 LTS (the exact version is in `.nvmrc`; run `nvm use`)
- pnpm 12.14.0 (pinned in the `packageManager` field of `package.json` with the SHA-512 of the npm registry tarball; `corepack enable` picks it up and refuses a download whose hash does not match). To bump pnpm, take `npm view pnpm@<version> dist.integrity`, drop the `sha512-` prefix, base64 decode it, hex encode the result and write `pnpm@<version>+sha512.<hex>`

TypeScript is pinned to 6.0.3 because typescript-eslint 8 supports only `typescript <6.1.0`. Upgrade to TypeScript 7 once a typescript-eslint release lists it in its peer range.

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Root commands:

| Command             | What it does                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`        | Runs the workspace check, then `tsc -p tsconfig.build.json` for every workspace member, members that others depend on first                                                                 |
| `pnpm typecheck`    | Runs the workspace check, then `tsc --noEmit` on the root `tsconfig.json` (root files and `scripts/`) and on every member's `tsconfig.json`                                                 |
| `pnpm lint`         | Runs the workspace check, then one type-aware ESLint run over the whole repository with the root `eslint.config.js` and `--max-warnings 0`                                                  |
| `pnpm format:check` | Checks formatting with Prettier                                                                                                                                                             |
| `pnpm test`         | Runs the tests of every package under `packages/` and `apps/` in one Vitest run, with an 85 percent coverage threshold over their `src/` TypeScript files (test and `.d.ts` files excluded) |

### What the root gate checks

`pnpm lint`, `pnpm typecheck` and `pnpm build` never run package scripts. They run fixed commands, so a package script cannot change what they check:

- Lint is `eslint --config eslint.config.js --max-warnings 0 .` from the root. `--config` turns off config lookup, so an `eslint.config.js` inside a package is ignored, and no flag comes from a package.
- Typecheck and build run through `scripts/gate.ts`, which resolves `tsc` from the `typescript` package and runs it with the current Node binary for each member found by the workspace check. The only input taken from a member is its project file. Typecheck first builds the members that other members depend on, then checks every project and reports every failure; build stops at the first failure.

The commands still read files that a member controls, so the workspace check (`scripts/check-workspace-scripts.ts`, which runs first) covers those:

- Every folder with a `package.json` under `packages/` or `apps/` must be a workspace member matched by a `<dir>/*` glob in `pnpm-workspace.yaml`, with a name no other member uses. Globs outside `packages/` and `apps/`, symlinked folders, folders without a `package.json` and loose files directly in `packages/` or `apps/` are rejected.
- Every member has a `tsconfig.json` and a `tsconfig.build.json` that extend exactly `../../tsconfig.base.json` and set no compiler options other than `rootDir`, `outDir`, `noEmit`, `lib`, `types`, `jsx` and `plugins`. Every strictness flag, `skipLibCheck` and `noCheck` therefore come from the base config only. `tsconfig.build.json` must not set `noEmit`.
- A member with a `next.config.*` file is rejected until the gate knows how to build a Next.js app.
- Every source file that ESLint sees must be included by some `tsconfig.json`, otherwise the type-aware lint fails, so narrowing a member's `include` cannot hide a file from lint.

Not covered: inline `eslint-disable` comments in source (unused ones fail through `reportUnusedDisableDirectives`, and money source ignores inline config entirely), and `pnpm test`, which loads each member's `vitest.config.ts` as a project.

Package scripts are conveniences for working inside one package. Members must still define `build`, `lint`, `typecheck` and `test`, and the workspace check keeps them to plain tool commands so running one by hand behaves like the gate. Commands may only be chained with `&&`; `|` (including `||`), `;`, a single `&`, backticks, `$(`, process substitution (`<(` and `>(`) and newlines are rejected. Redirection with `>`, `>>`, `<` and file descriptor duplication such as `2>&1` is allowed. Each `&&` step must start with one of exactly `tsc`, `eslint`, `vitest`, `prettier` or `next`, written as a bare name, with no environment variable assignment before it, and the `lint` script must set `--max-warnings 0` exactly once.

Every source file starts with the proprietary license header below, with the year the file was created (any four digit year is accepted). `pnpm lint` fails on any source file without it.

```ts
// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.
```

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `development`, `staging` and `main`. A single `Verify` job lints the workflow files with actionlint, installs with `pnpm install --frozen-lockfile`, then runs `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build` and `pnpm audit --prod`. The build runs because it compiles with each member's `tsconfig.build.json`, which typecheck does not use. The coverage report is uploaded as the `coverage` artifact even when tests fail (Vitest writes it on failure because `coverage.reportOnFailure` is set), so a failing test or a missed threshold can be inspected; a missing report is only an error when every earlier step passed. Any failing step fails the run, and a newer push to the same ref cancels the run in progress.

Node.js comes from `.nvmrc` and pnpm from `packageManager`, and the pnpm store is cached on the hash of `pnpm-lock.yaml`. Every third-party action is pinned to a full commit SHA with its release tag in a trailing comment, and the workflow token is read only. To bump an action, resolve the new tag to its commit SHA (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, dereferencing annotated tags) and update both the SHA and the comment.

Run the workflow linter locally with `actionlint` before pushing changes to `.github/workflows/`.
