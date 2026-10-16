# ujira

UJIRA: pay people anywhere in their own money. Services, router, API, dashboard and onboarding widget.

## Development

Requirements:

- Node.js 24 LTS (the exact version is in `.nvmrc`; run `nvm use`)
- pnpm 10.34.7 (pinned in the `packageManager` field of `package.json`; `corepack enable` picks it up)

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Root commands:

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `pnpm build`        | Builds every package through Turborepo                               |
| `pnpm typecheck`    | Runs `tsc` in strict mode on every package and the root config files |
| `pnpm lint`         | Runs ESLint with type-aware rules and `--max-warnings 0`             |
| `pnpm format:check` | Checks formatting with Prettier                                      |
| `pnpm test`         | Runs every package's tests through Vitest with coverage              |

Every source file starts with the proprietary license header below. `pnpm lint` fails on any file without it.

```ts
// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.
```
