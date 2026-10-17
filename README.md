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

| Command                         | What it does                                                                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                    | Builds every package through Turborepo                                                                                                                                                                                                             |
| `pnpm typecheck`                | Checks package scripts, then runs `tsc` in strict mode on every package, root level files and `scripts/`                                                                                                                                           |
| `pnpm lint`                     | Checks package scripts, then runs type-aware ESLint with `--max-warnings 0` on packages, root files and `scripts/`                                                                                                                                 |
| `pnpm format:check`             | Checks formatting with Prettier                                                                                                                                                                                                                    |
| `pnpm test`                     | Runs the tests of every package under `packages/` and `apps/`, and of `scripts/`, in one Vitest run, with an 85 percent coverage threshold over their `src/` TypeScript files and `scripts/embedded-metadata.ts` (test and `.d.ts` files excluded) |
| `pnpm metadata:check`           | Fails when any tracked file carries an embedded provenance manifest or XMP packet, naming each file                                                                                                                                                |
| `pnpm metadata:strip <file...>` | Removes those blocks from SVG, PNG and JPEG files in place                                                                                                                                                                                         |

Every source file starts with the proprietary license header below, with the year the file was created (any four digit year is accepted). `pnpm lint` fails on any source file without it, in a package or at the root. A source file that no `tsconfig.json` includes also fails lint, so nothing slips past the checks. Every folder with a `package.json` under `packages/` or `apps/` must be a workspace member matched by a `<dir>/*` glob in `pnpm-workspace.yaml`, and must define `build`, `lint`, `typecheck` and `test` scripts. The workspace script check reads the text of those four scripts and rejects the common ways a script can exit 0 after a failure, with a message naming the package and script. Commands may only be chained with `&&`; `|` (including `||`), `;`, a single `&`, backticks, `$(`, process substitution (`<(` and `>(`) and newlines are rejected. Redirection with `>`, `>>`, `<` and file descriptor duplication such as `2>&1` is allowed, since it does not change the exit code. Each `&&` step must start with one of exactly `tsc`, `eslint`, `vitest`, `prettier` or `next`, written as a bare name. Any other first word is rejected, including `!`, `(`, package managers, shells and `node`, as is a first word containing `$`, a quote, `=`, `/` or a backslash, and any environment variable assignment before the command. Its `lint` script must set `--max-warnings 0` exactly once. This covers the common hand offs only: the check does not read the files a tool loads or the other flags passed to it. Running fixed commands from the root instead of trusting package scripts is tracked in #16. Symlinked folders, folders without a `package.json` and loose files directly in `packages/` or `apps/` are rejected.

```ts
// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.
```

## Embedded metadata in assets

Design tools can embed a signed provenance manifest (C2PA, a JUMBF box) or an XMP packet in exported images. These can name the program that produced the file and are invisible in a text diff, so `pnpm metadata:check` scans every file tracked by git and fails on any of them. It reports, per file: an SVG that declares the C2PA namespace (`xmlns:c2pa` or any namespace URI containing `c2pa`), contains a `c2pa:` element, has a `<metadata>` element holding C2PA, XMP or RDF content, or contains an XMP packet; a PNG with a `caBX` chunk, a `tEXt`, `zTXt` or `iTXt` chunk holding XMP, or data after `IEND`; a JPEG with an APP11 JUMBF segment or an APP1 XMP segment; and a raw C2PA JUMBF box or XMP packet in any other file. A PNG or JPEG that cannot be parsed (bad signature, bad chunk CRC, truncated segment) is reported too. Plain `<metadata>` text, `<title>` and ordinary PNG text chunks are allowed.

Before committing brand assets, run `pnpm metadata:strip <file...>`. It parses PNG chunks and JPEG segments and copies everything it keeps byte for byte, so pixel data is never decoded or recompressed, and it removes only the flagged SVG elements and namespace declarations. It writes a file only when the result passes the check, and refuses formats other than SVG, PNG and JPEG. Compressed files such as `.svgz` are not decompressed, so their contents are not checked; commit SVG uncompressed.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `development`, `staging` and `main`. A single `Verify` job lints the workflow files with actionlint, installs with `pnpm install --frozen-lockfile`, then runs `pnpm metadata:check`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build` and `pnpm audit --prod`. The build runs because it compiles with each package's `tsconfig.build.json`, which typecheck does not use. The coverage report is uploaded as the `coverage` artifact even when tests fail (Vitest writes it on failure because `coverage.reportOnFailure` is set), so a failing test or a missed threshold can be inspected; a missing report is only an error when every earlier step passed. Any failing step fails the run, and a newer push to the same ref cancels the run in progress.

Node.js comes from `.nvmrc` and pnpm from `packageManager`, and the pnpm store is cached on the hash of `pnpm-lock.yaml`. Every third-party action is pinned to a full commit SHA with its release tag in a trailing comment, and the workflow token is read only. To bump an action, resolve the new tag to its commit SHA (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, dereferencing annotated tags) and update both the SHA and the comment.

Run the workflow linter locally with `actionlint` before pushing changes to `.github/workflows/`.
