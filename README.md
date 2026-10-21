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
| `pnpm build`                    | Runs the workspace check, then `tsc -p tsconfig.build.json` for every workspace member, members that others depend on first                                                                                                                                                      |
| `pnpm typecheck`                | Runs the workspace check, then `tsc --noEmit` on the root `tsconfig.json` (root files and `scripts/`) and on every member's `tsconfig.json`                                                                                                                                      |
| `pnpm lint`                     | Runs the workspace check, then one type-aware ESLint run over the whole repository with the root `eslint.config.js` and `--max-warnings 0`                                                                                                                                       |
| `pnpm format:check`             | Checks formatting with Prettier                                                                                                                                                                                                                                                  |
| `pnpm test`                     | Runs the tests of every package under `packages/` and `apps/`, and of `scripts/`, in one Vitest run, with an 85 percent coverage threshold over their `src/` TypeScript files and the pure helpers in `scripts/` (test and `.d.ts` files excluded)                               |
| `pnpm licenses:check`           | Checks the license of every production and dev dependency of every workspace project against its allowlist (dev adds MPL-2.0), cross checks the listing against `pnpm-lock.yaml`, and fails naming each package, version and license; on success writes `THIRD_PARTY_NOTICES.md` |
| `pnpm metadata:check`           | Fails when any tracked file carries an embedded provenance manifest or XMP packet, naming each file                                                                                                                                                                              |
| `pnpm metadata:strip <file...>` | Removes those blocks from SVG, PNG and JPEG files in place                                                                                                                                                                                                                       |
| `pnpm invisible:check`          | Fails on literal format, bidirectional control and separator characters in tracked text files, naming the file, line, column and code point                                                                                                                                      |

### What the root gate checks

`pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check` and `pnpm test` never run package scripts or member config files for the tools. They run fixed commands, so a package cannot change what they check:

- Lint is `eslint --config eslint.config.js --max-warnings 0 .` from the root. `--config` turns off config lookup, so an `eslint.config.js` inside a package is ignored, and no flag comes from a package. ESLint gets an explicit list of projects, the root `tsconfig.json` and each member's `tsconfig.json`, instead of looking up the nearest tsconfig for each file, so lint sees the same program as typecheck.
- Typecheck and build run through `scripts/gate.ts`, which resolves `tsc` from the `typescript` package and runs it with the current Node binary for each member found by the workspace check. The only input taken from a member is its project file. Typecheck first builds the members that other members depend on, then checks every project and reports every failure; build stops at the first failure.
- Build empties each member's `dist`, then runs `tsc` with `--noEmitOnError`, so a failing build leaves no output behind. It refuses to build a member whose `dist` is not a real folder inside it (a symlink named `dist` would send the output elsewhere, for example into `node_modules`).
- Test is `vitest run --coverage --configLoader native` with the root `vitest.config.ts`, which defines one project per member itself instead of loading member `vitest.config` files: tests under `src/` by default, with per member settings in the root config (`@ujira/ui` adds its `.tsx` and `tokens/` tests, `@ujira/payouts` its `spikes/` tests and their timeouts). A gate test fails if any tracked `*.test.ts` or `*.test.tsx` is in no project. The native loader and a Vitest cache outside the checkout mean the test run writes nothing into the repository.
- Format check is `prettier --config .prettierrc.json --no-editorconfig --ignore-path .prettierignore --check .`, so Prettier never looks for, or runs, a config file next to a member's files, and reads only `.prettierignore`.

The commands still read files that a member controls, so the workspace check (`scripts/check-workspace-scripts.ts`, which runs first) covers those:

- Every folder with a `package.json` under `packages/` or `apps/` must be a workspace member matched by a `<dir>/*` glob in `pnpm-workspace.yaml`, with a name no other member uses. Globs outside `packages/` and `apps/`, symlinked folders, folders without a `package.json` and loose files directly in `packages/` or `apps/` are rejected.
- `pnpm-workspace.yaml` is read with a YAML parser, and the member set must match what `pnpm ls -r` reports, so pnpm cannot install a member the checks do not see.
- Every member has a `tsconfig.json` and a `tsconfig.build.json` that extend exactly `../../tsconfig.base.json` and set no top level keys other than `extends`, `compilerOptions`, `include`, `exclude`, `files` and `$schema` (so no `references`). The only compiler options a member may set are `rootDir`, `outDir`, `noEmit`, `lib`, `types`, `jsx`, `plugins` and `allowImportingTsExtensions`, the last only together with `noEmit: true`. Every strictness flag, `skipLibCheck` and `noCheck` therefore come from the base config only. `outDir` must be `dist`, and `rootDir` and every `include`, `exclude` and `files` entry must stay inside the member folder, so a member build cannot write over files that later steps read. `tsconfig.build.json` must not set `noEmit`.
- A member that depends on `next` or has a `next.config.*` file is rejected until the gate knows how to build a Next.js app.
- No member and not the root may define an install time script (`preinstall`, `install`, `postinstall`, `preprepare`, `prepare`, `postprepare`, `prepublish` or `pnpm:devPreinstall`), since pnpm runs those during install, before any check. CI also installs with `--ignore-scripts`; no dependency needs an install script today.
- No symlink in a member's folders that the check walks, no symlink named `dist`, `node_modules`, `coverage` or `.turbo`, and no symlink tracked by git (mode `120000`) in a member. The check does not look inside a member's own untracked output folders, such as a real `dist` or `node_modules`; nothing in them is tracked, and the build refuses a `dist` that is not a real folder inside the member.
- No tracked file may be matched by an ignore rule (`git ls-files -c -i --exclude-standard` must be empty). Lint and format skip ignored paths but tsc builds them, so a force added file under, say, `src/money/dist/` would otherwise ship unchecked. ESLint and Prettier ignore `dist`, `coverage` and `.turbo` only at the repository root and at member roots, so the same names deeper in a member are linted and formatted. The tsconfig and formatter checks skip them only there too, and match file names in any letter case.
- The root `.gitignore` is the only one: a nested `.gitignore` could re-include files under a member's `dist` so that git no longer reports them as ignored. Independently of any ignore file, nothing may be tracked in a member's `dist`, `coverage`, `.turbo`, `build` or `out` folder, and the build deletes each member's `dist` before running `tsc`, so nothing committed or left there can reach the build output.
- The only tsconfig or jsconfig files in the repository are the root `tsconfig.json` and `tsconfig.base.json` and the two at each member root. The only formatter configuration is the root `.prettierrc.json`: no other `.prettierrc*`, `prettier.config.*` or `.editorconfig`, and no `prettier` key in a member `package.json`.
- Every source file that ESLint sees must be included by some `tsconfig.json`, otherwise the type-aware lint fails, so narrowing a member's `include` cannot hide a file from lint.

Not covered: inline `eslint-disable` comments in source (unused ones fail through `reportUnusedDisableDirectives`, and money source ignores inline config entirely), and writes into ignored folders such as `node_modules`, which the CI working tree check below cannot see; the `outDir` and path rules above are what keep member builds out of them.

Package scripts are conveniences for working inside one package. Members must still define `build`, `lint`, `typecheck` and `test`, and the workspace check keeps them to plain tool commands so running one by hand behaves like the gate. Commands may only be chained with `&&`; `|` (including `||`), `;`, a single `&`, backticks, `$(`, process substitution (`<(` and `>(`) and newlines are rejected. Redirection with `>`, `>>`, `<` and file descriptor duplication such as `2>&1` is allowed. Each `&&` step must start with one of exactly `tsc`, `eslint`, `vitest`, `prettier` or `next`, written as a bare name, with no environment variable assignment before it, and the `lint` script must set `--max-warnings 0` exactly once.

Every source file starts with the proprietary license header below, with the year the file was created (any four digit year is accepted). `pnpm lint` fails on any source file without it.

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

## Secret scanning

The `secrets` job in `.github/workflows/ci.yml` runs `scripts/secret-scan.sh` with gitleaks 8.30.1 (MIT licensed), downloaded from its GitHub release and checked against a pinned SHA-256. It checks out the full history and scans every commit reachable from the checked out commit, not only the change, so a key that was committed and later deleted still fails. Merge commits are scanned against each parent, so a key added while resolving a merge is found, and every file is read as text, so a `.gitattributes` entry such as `-diff` or `binary` cannot hide one. The scan refuses a shallow clone and fails unless gitleaks reports scanning exactly the commits it should: every commit with a change in a file it does not delete (commits that only delete, rename or change a mode have nothing to scan). Findings are redacted in the log.

Two limits apply to any line based scanner. Binary files are handed to gitleaks as text, so a key stored as plain text inside one is found, but a compressed or encoded one is not; a commit that only adds binary files still passes. A token split across lines, or assembled from pieces in code, is not caught either. To cover the first, the scan also refuses, by name and in any case, any commit in the history that adds or changes a key or env file, binary or not: `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk`, `.p8` and `.der` files, private ssh keys such as `id_rsa` or `id_ed25519` (their `.pub` halves are allowed), and `.env`, `.env.*`, `.envrc` and `*.env` files other than `.env.example`. Names are read unquoted, so non-ASCII names are checked too. Key material and environment values belong in the secret manager.

`.gitleaks.toml` holds the default rules of gitleaks 8.30.1 with upstream's global allowlist removed, so lockfiles, `node_modules`, images, `.pem`, `.key` and `.log` files, `go.sum` and files named `gitleaks.toml` are scanned like any other file. Upstream rule allowlists that list sample keys or passwords (for the GCP API key and NuGet password rules, and one hex stopword) are removed too. The rule allowlists that remain only drop placeholders, words and template syntax, and the self test scans the file with every allowlist stripped so no key shaped literal can return. Its header names the upstream file, its hash and every edit. Inline `gitleaks:allow` comments are ignored and any `.gitleaksignore` fails the scan, so `.gitleaks.toml` is the only allowlist. Each allowlist entry must cover a single synthetic test fixture and say why it is safe; path wide and rule wide exclusions are not allowed.

On pull requests the scan reads `.gitleaks.toml` from the base branch rather than from the change, so an edit to that file in a pull request does not change the rules that pull request is scanned with; the edit takes effect once it is merged. This is not a complete guarantee: a pull request can still edit `scripts/secret-scan.sh` or the workflow, and review is the control for those. A base branch without `.gitleaks.toml` gets the gitleaks built in default rules, never an empty set, and for that run upstream's global allowlist and its path skips apply again.

`scripts/secret-scan.test.sh` plants generated fake keys in throwaway repositories and checks that each one fails: in an ordinary commit, in a commit later deleted, behind `gitleaks:allow`, behind a `.gitleaksignore`, in a merge resolution, in files marked `-diff` or `binary`, in each path upstream skips (lockfiles, `node_modules`, `.svg`, a text `.png`, `.pem`, `.key`, `.log`, `go.sum`, any `gitleaks.toml`), and in a pull request that tries to replace the rules. It checks that key and env files are refused, also when removed later and with non-ASCII names, that `.pub` keys and `.env.example` pass, that delete only, rename only, mode only, binary, symlink and empty commits pass with the commit count matched exactly, and that `.gitleaks.toml` itself holds no key shaped literal. Both scripts run locally once gitleaks is installed (`brew install gitleaks`):

```sh
scripts/secret-scan.sh
scripts/secret-scan.test.sh
```

A manual run of gitleaks must pass the config as an absolute path, as `scripts/secret-scan.sh` does (`--config "$PWD/.gitleaks.toml"`, not `--config .gitleaks.toml`). When a relative config path matches the path of the file inside the repository, gitleaks silently skips findings in the config file itself.

Merging: this repository must stay squash-only. A pull request branch may hold commits, such as test probes or fixups, that never reach `development` only because every merge is a squash merge, and the scan on `development` relies on that. Enabling merge commits or rebase merging requires revisiting the secret scan first.

Keep `.env` files untracked; only `.env.example` belongs in git.

## Dashes

No file may contain an em dash or an en dash. `scripts/check-dashes.sh` searches the content git holds for every tracked file, prints each hit as `path:line:text` and exits 1 on any. Every file is read as text, so a NUL byte cannot make one look binary and skip the check; a file is skipped only when its extension is one of a short list of binary formats and its content starts with that format's signature. A dash in a path fails too, reported as the path with a note, and both kinds are reported in one run. Staged content counts; an edit left only in the working tree does not, and a commit time check covers that. `scripts/test-check-dashes.sh` is its self test. The `dashes` CI job runs the self test, then the check, and the check still reports when the self test fails. Both scripts are shared with ujira-contracts, ujira-docs and ujira-mcp, identical apart from the licence header, so a change is made in all four.

## Pull requests

Every pull request starts from `.github/pull_request_template.md`: the linked issue, what and why, the tests run with their output, docs, a checklist, the reviews the change type needs, and the merge rules (squash only, and any commit after an approval needs review again). `scripts/check-pr-template.sh` fails if the template loses any of these or stops being plain ASCII, and `scripts/check-pr-template.test.sh` proves it; CI runs both. `.github/CODEOWNERS` names the owner of each top level path. It is advisory: on the current GitHub plan branch protection cannot require code owner review (qomiralabs/ujira#229).

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `development`, `staging` and `main`, in three jobs. The `secrets` job is described under Secret scanning above, and the `dashes` job under Dashes. The `Verify` job lints the workflow files with actionlint, checks the pull request template, installs with `pnpm install --frozen-lockfile --ignore-scripts`, runs `pnpm licenses:check` and fails if `THIRD_PARTY_NOTICES.md` then differs from the committed file, then runs `pnpm metadata:check`, `pnpm invisible:check`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm audit --prod` and finally `pnpm test`. Tests run last because test files are member code, and the test step runs on a read-only bind mount of the checkout, `node_modules` included, which stops ordinary writes from a test to an installed tool or a source file. Coverage, the JUnit report and the Vitest cache are written outside the checkout. A step after the tests fails if `git status` reports anything or any file in the checkout has a change time (ctime) after the start of the test step. Known gap, tracked separately: a test that uses `sudo` to remount the checkout, or writes to the pnpm store outside it, is not stopped by this step. After typecheck and after build it fails if `git status --porcelain --untracked-files=all` reports anything, since those steps may only write ignored output such as `dist/`. The build runs because it compiles with each member's `tsconfig.build.json`, which typecheck does not use. The coverage report is uploaded as the `coverage` artifact even when tests fail (Vitest writes it on failure because `coverage.reportOnFailure` is set), so a failing test or a missed threshold can be inspected (both reports are written under the runner's temp folder); a missing report is only an error when every earlier step passed. Any failing step fails the run, and a newer push to the same ref cancels the run in progress.

Node.js comes from `.nvmrc` and pnpm from the verified download described above, and the pnpm store is cached on the hash of `pnpm-lock.yaml`. Every third-party action is pinned to a full commit SHA with its release tag in a trailing comment, and the workflow token is read only. To bump an action, resolve the new tag to its commit SHA (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, dereferencing annotated tags) and update both the SHA and the comment.

Run the workflow linter locally with `actionlint` before pushing changes to `.github/workflows/`.
