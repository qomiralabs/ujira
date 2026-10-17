#!/usr/bin/env bash
# Copyright (c) 2026 Qomira Labs. All rights reserved.
# Proprietary and confidential. Unauthorized copying is prohibited.
#
# Self test for assert-pnpm.sh. Each case installs a stand in pnpm under a
# temporary RUNNER_TEMP and checks the exit code and output.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/assert-pnpm.sh"
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$work"' EXIT

passed=0
failures=0

sha512() {
  if command -v sha512sum >/dev/null 2>&1; then
    sha512sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 512 "$1" | cut -d ' ' -f 1
  fi
}

# setup <case name> <version the stand in prints>
setup() {
  runner_temp="$work/$1"
  mkdir -p "$runner_temp/pnpm" "$runner_temp/other"
  printf '#!/bin/sh\necho %s\n' "$2" >"$runner_temp/pnpm/pnpm"
  chmod +x "$runner_temp/pnpm/pnpm"
  hash=$(sha512 "$runner_temp/pnpm/pnpm")
  path="$runner_temp/pnpm:/usr/bin:/bin"
}

# expect <case name> <exit code> [text the output must contain]...
expect() {
  local name=$1 want=$2
  shift 2
  local out code=0 needle
  out=$(env -i PATH="$path" RUNNER_TEMP="$runner_temp" PNPM_VERSION="${version-12.14.0}" \
    PNPM_BINARY_SHA512="$hash" "$script" 2>&1) || code=$?
  if [ "$code" -ne "$want" ]; then
    echo "FAIL: $name: exit $code, want $want"
    printf '%s\n' "$out" | sed 's/^/    /'
    failures=$((failures + 1))
    return
  fi
  for needle in "$@"; do
    if ! printf '%s\n' "$out" | grep -qF -- "$needle"; then
      echo "FAIL: $name: output does not mention '$needle'"
      printf '%s\n' "$out" | sed 's/^/    /'
      failures=$((failures + 1))
      return
    fi
  done
  echo "ok: $name"
  passed=$((passed + 1))
}

setup ok 12.14.0
expect "the pinned binary passes" 0 "assert-pnpm: pnpm 12.14.0 at $runner_temp/pnpm/pnpm matches the pinned SHA-512"

setup wrong_hash 12.14.0
hash=$(printf '%0128d' 0)
expect "a binary with another hash fails" 1 "does not match PNPM_BINARY_SHA512"

setup shadowed 12.14.0
printf '#!/bin/sh\necho 12.14.0\n' >"$runner_temp/other/pnpm"
chmod +x "$runner_temp/other/pnpm"
path="$runner_temp/other:$path"
expect "another pnpm earlier on PATH fails" 1 "pnpm resolves to $runner_temp/other/pnpm"

setup missing 12.14.0
rm "$runner_temp/pnpm/pnpm"
expect "no pnpm on PATH fails" 1 "pnpm resolves to nothing"

setup wrong_version 12.13.0
expect "a binary reporting another version fails" 1 "reports version 12.13.0, expected 12.14.0"

setup no_env 12.14.0
version=
expect "an empty PNPM_VERSION fails" 1 "PNPM_VERSION is not set"
unset version

echo
echo "$passed passed, $failures failed"
[ "$failures" -eq 0 ]
