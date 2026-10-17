# ujira

UJIRA: pay people anywhere in their own money. Services, router, API, dashboard and onboarding widget.

## Development

Requirements:

- Node.js 24 LTS (the exact version is in `.nvmrc`; run `nvm use`)
- pnpm 12.14.0, pinned in the `packageManager` field of `package.json` (`corepack enable` picks it up). The `+sha512` suffix is the SHA-512 of the `pnpm` npm package, which since pnpm 12 is a small shim: corepack refuses a shim whose hash does not match, but the binary that actually runs comes from the platform package `@pnpm/exe.<platform>` and is checked only against the integrity recorded in the npm registry metadata. CI therefore does not use `pnpm/action-setup` (which also drops the suffix and self updates from the registry). It downloads the `@pnpm/exe.linux-x64` tarball for `PNPM_VERSION` itself, fails unless the tarball matches `PNPM_EXE_SHA512` in `.github/workflows/ci.yml`, the same way the actionlint download is checked, and puts that binary first on `PATH`.

To bump pnpm, update both pins in the same change:

1. `package.json`: take `npm view pnpm@<version> dist.integrity`, drop the `sha512-` prefix, base64 decode it, hex encode the result and write `pnpm@<version>+sha512.<hex>` to `packageManager`.
2. `.github/workflows/ci.yml`: set `PNPM_VERSION` to `<version>`, and set `PNPM_EXE_SHA512` to the same conversion of `npm view @pnpm/exe.linux-x64@<version> dist.integrity` (for example `node -p "Buffer.from('<base64>', 'base64').toString('hex')"`). Then set `PNPM_BINARY_SHA512` to the SHA-512 of the `package/pnpm` file inside that tarball (`tar -xzf exe.linux-x64-<version>.tgz package/pnpm && sha512sum package/pnpm`), after checking the tarball against `PNPM_EXE_SHA512`.

CI checks these pins in three ways:

- `node scripts/check-package-manager.ts "$PNPM_VERSION"` parses `package.json` with a strict JSON parser (`scripts/strict-json.ts`) that rejects duplicate keys at any depth, so a second `packageManager` key cannot hide behind the first, and fails unless `packageManager` is `pnpm@$PNPM_VERSION+sha512.<128 hex>`.
- Every step that runs pnpm starts with `scripts/assert-pnpm.sh`, which fails unless `pnpm` on `PATH` is `${RUNNER_TEMP}/pnpm/pnpm`, hashes to `PNPM_BINARY_SHA512` and reports `PNPM_VERSION`. A step that only uses an action, such as the pnpm cache in `actions/setup-node`, cannot run the script; the setup step asserts the binary just before it.
- `scripts/check-workflow-pnpm.sh` fails on any workflow step whose `run` script calls pnpm without running `scripts/assert-pnpm.sh` first. `scripts/check-workflow-pnpm.test.sh` and `scripts/assert-pnpm.test.sh` test both scripts.

TypeScript is pinned to 6.0.3 because typescript-eslint 8 supports only `typescript <6.1.0`. Upgrade to TypeScript 7 once a typescript-eslint release lists it in its peer range.

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Root commands:

| Command                         | What it does                                                                                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                    | Builds every package through Turborepo                                                                                                                                                                                                                                           |
| `pnpm typecheck`                | Checks package scripts, then runs `tsc` in strict mode on every package, root level files and `scripts/`                                                                                                                                                                         |
| `pnpm lint`                     | Checks package scripts, then runs type-aware ESLint with `--max-warnings 0` on packages, root files and `scripts/`                                                                                                                                                               |
| `pnpm format:check`             | Checks formatting with Prettier                                                                                                                                                                                                                                                  |
| `pnpm test`                     | Runs the tests of every package under `packages/` and `apps/`, and of `scripts/`, in one Vitest run, with an 85 percent coverage threshold over their `src/` TypeScript files and the pure helpers in `scripts/` (test and `.d.ts` files excluded)                               |
| `pnpm licenses:check`           | Checks the license of every production and dev dependency of every workspace project against its allowlist (dev adds MPL-2.0), cross checks the listing against `pnpm-lock.yaml`, and fails naming each package, version and license; on success writes `THIRD_PARTY_NOTICES.md` |
| `pnpm metadata:check`           | Fails when any tracked file carries an embedded provenance manifest or XMP packet, naming each file                                                                                                                                                                              |
| `pnpm metadata:strip <file...>` | Removes those blocks from SVG, PNG and JPEG files in place                                                                                                                                                                                                                       |
| `pnpm invisible:check`          | Fails on literal format, bidirectional control and separator characters in tracked text files, naming the file, line, column and code point                                                                                                                                      |

Every source file starts with the proprietary license header below, with the year the file was created (any four digit year is accepted). `pnpm lint` fails on any source file without it, in a package or at the root. A source file that no `tsconfig.json` includes also fails lint, so nothing slips past the checks. Every folder with a `package.json` under `packages/` or `apps/` must be a workspace member matched by a `<dir>/*` glob in `pnpm-workspace.yaml`, and must define `build`, `lint`, `typecheck` and `test` scripts. The workspace script check reads the text of those four scripts and rejects the common ways a script can exit 0 after a failure, with a message naming the package and script. Commands may only be chained with `&&`; `|` (including `||`), `;`, a single `&`, backticks, `$(`, process substitution (`<(` and `>(`) and newlines are rejected. Redirection with `>`, `>>`, `<` and file descriptor duplication such as `2>&1` is allowed, since it does not change the exit code. Each `&&` step must start with one of exactly `tsc`, `eslint`, `vitest`, `prettier` or `next`, written as a bare name. Any other first word is rejected, including `!`, `(`, package managers, shells and `node`, as is a first word containing `$`, a quote, `=`, `/` or a backslash, and any environment variable assignment before the command. Its `lint` script must set `--max-warnings 0` exactly once. This covers the common hand offs only: the check does not read the files a tool loads or the other flags passed to it. Running fixed commands from the root instead of trusting package scripts is tracked in #16. Symlinked folders, folders without a `package.json` and loose files directly in `packages/` or `apps/` are rejected.

```ts
// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.
```

Commit `THIRD_PARTY_NOTICES.md` whenever dependencies change. The file is generated, sorted and platform independent, so a rerun on an unchanged lockfile leaves no diff.

Packages that declare `os`, `cpu` or `libc` are installed only on matching platforms, so `pnpm licenses list` cannot see most of them. Each one in `pnpm-lock.yaml` must have an entry in `scripts/platform-licenses.json` (name, version, license, source URL), and the check fails on any that is missing. Review the license on the registry before adding an entry. The check makes no network calls.

Run the check through pnpm (`pnpm licenses:check`). It uses the pnpm binary that runs the script, never one found on `PATH`, and refuses one installed inside the repository.

## Embedded metadata in assets

Design tools can embed a signed provenance manifest (C2PA, a JUMBF box) or an XMP packet in exported images. These can name the program that produced the file and are invisible in a text diff, so `pnpm metadata:check` scans every file tracked by git and fails on any of them, naming each file. A tracked file missing from the working tree fails too, and file names are printed with control characters and bytes that are not UTF-8 escaped. It reports:

- SVG: a C2PA namespace declaration (`xmlns:c2pa`, or any namespace URI containing `c2pa` after character references are decoded), a `c2pa:` element, a `<metadata>` element holding C2PA, XMP, RDF or base64 JUMBF content, an XMP packet, base64 JUMBF anywhere in the file (including inside a `data:` URI), and an unclosed `<metadata>`, `c2pa:`, XMP element or packet. An SVG that is not valid UTF-8, such as one saved as UTF-16, is reported as not valid.
- PNG: a `caBX` chunk (any letter case), a `tEXt`, `zTXt` or `iTXt` chunk holding XMP or a C2PA box after inflating compressed text and decoding `Raw profile type` hex, and data after `IEND`.
- JPEG: APP11 JUMBF segments of a C2PA manifest (every segment of the box, other APP11 boxes are kept), APP1 XMP segments, including ones between progressive scans, and data after `EOI`.
- Any other file: a raw or base64 C2PA JUMBF box or an XMP packet.

A PNG or JPEG that cannot be parsed (bad signature, bad chunk CRC, truncated segment, no `EOI`, text that does not inflate, data after a zlib stream, a text chunk inflating past 16 MiB or a file's text chunks inflating past 64 MiB in total) is reported too, and so is a `.png`, `.jpg` or `.jpeg` file that does not start like one. Plain `<metadata>` text, `<title>` and ordinary PNG text chunks are allowed. Every scan is linear in the file size.

Before committing brand assets, run `pnpm metadata:strip <file...>`. It parses PNG chunks and JPEG segments and copies everything it keeps byte for byte, so pixel data is never decoded or recompressed, and it removes only the flagged SVG elements and namespace declarations. It writes a file only when the result passes the check, refuses symlinks and anything that is not a regular file, and refuses formats other than SVG, PNG and JPEG. Compressed files such as `.svgz` are not decompressed, so their contents are not checked; commit SVG uncompressed.

## Invisible characters

`pnpm invisible:check` reads every tracked file as bytes. Only files with an extension on the short binary list in `scripts/invisible-characters.ts` (`png`, `jpg`, `jpeg`, `gif`, `webp`, `ico`, `woff`, `woff2`, `wasm`, `pdf`) are skipped, and only when their content starts with that format's signature; a listed name with other content fails. Every other file must be valid UTF-8 and is scanned in full, and a NUL byte in it is reported as U+0000, so a NUL cannot make a source file skip the check. It fails on any character in the Unicode categories Cf (format characters such as the byte order mark, zero width characters and the bidirectional controls U+202A to U+202E and U+2066 to U+2069), Zl and Zp (U+2028 and U+2029), using the Unicode tables built into Node.js rather than a hand written list. It also fails on the lookalike no break space (U+00A0), narrow no break space (U+202F) and minus sign (U+2212), except in files listed in `scripts/invisible-characters-allowlist.txt`. Tests and data that need any of these characters write them as escapes such as `\u202E`.

## Dependency release age

A dependency version must be at least 14 days old before pnpm installs or locks it (`minimumReleaseAge: 20160`, in minutes, in `pnpm-workspace.yaml`). Most malicious releases are found and pulled within that window. `pnpm install --frozen-lockfile` checks every lockfile entry against the setting again, so CI fails at the install step on any version that is too new, and also on any version the registry cannot date (`minimumReleaseAgeIgnoreMissingTime: false`). `scripts/release-age.test.ts` proves both against a local registry stub using the repository's own settings.

`minimumReleaseAgeExclude` lists exact `name@version` entries only. The entries under the 2026-10-17 baseline comment are the versions that were already locked when the setting was introduced; `minimumReleaseAgeExcludePrune` drops each one when its version leaves the lockfile. Add a new entry only for an urgent security patch that cannot wait 14 days, with a comment above it giving the advisory and the reason. Never exclude a package name or a scope.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `development`, `staging` and `main`. A single `Verify` job lints the workflow files with actionlint, installs with `pnpm install --frozen-lockfile`, runs `pnpm licenses:check` and fails if `THIRD_PARTY_NOTICES.md` then differs from the committed file, then runs `pnpm metadata:check`, `pnpm invisible:check`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build` and `pnpm audit --prod`. The build runs because it compiles with each package's `tsconfig.build.json`, which typecheck does not use. The coverage report is uploaded as the `coverage` artifact even when tests fail (Vitest writes it on failure because `coverage.reportOnFailure` is set), so a failing test or a missed threshold can be inspected; a missing report is only an error when every earlier step passed. Any failing step fails the run, and a newer push to the same ref cancels the run in progress.

Node.js comes from `.nvmrc` and pnpm from the verified download described above, and the pnpm store is cached on the hash of `pnpm-lock.yaml`. Every third-party action is pinned to a full commit SHA with its release tag in a trailing comment, and the workflow token is read only. To bump an action, resolve the new tag to its commit SHA (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, dereferencing annotated tags) and update both the SHA and the comment.

Run the workflow linter locally with `actionlint` before pushing changes to `.github/workflows/`.
