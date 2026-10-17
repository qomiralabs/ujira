#!/usr/bin/env bash
# Copyright (c) 2026 Qomira Labs. All rights reserved.
# Proprietary and confidential. Unauthorized copying is prohibited.
#
# Asserts that `pnpm` on PATH is the binary CI installed and verified: it must
# resolve to ${RUNNER_TEMP}/pnpm/pnpm, hash to PNPM_BINARY_SHA512 and report
# PNPM_VERSION. Every CI step that runs pnpm calls this first, so a later step
# cannot run a different pnpm put on PATH by an earlier one.
#
# Exit codes: 0 the pinned binary, 1 anything else.
set -euo pipefail

fail() {
  echo "assert-pnpm: $*" >&2
  exit 1
}

[ -n "${RUNNER_TEMP:-}" ] || fail "RUNNER_TEMP is not set"
[ -n "${PNPM_VERSION:-}" ] || fail "PNPM_VERSION is not set"
[ -n "${PNPM_BINARY_SHA512:-}" ] || fail "PNPM_BINARY_SHA512 is not set"

expected="${RUNNER_TEMP}/pnpm/pnpm"
actual=$(command -v pnpm || true)
[ "$actual" = "$expected" ] || fail "pnpm resolves to ${actual:-nothing}, expected $expected"

if command -v sha512sum >/dev/null 2>&1; then
  hash=$(sha512sum "$expected" | cut -d ' ' -f 1)
else
  hash=$(shasum -a 512 "$expected" | cut -d ' ' -f 1)
fi
[ "$hash" = "$PNPM_BINARY_SHA512" ] || fail "$expected does not match PNPM_BINARY_SHA512 (got $hash)"

version=$("$expected" --version)
[ "$version" = "$PNPM_VERSION" ] || fail "$expected reports version $version, expected $PNPM_VERSION"

echo "assert-pnpm: pnpm $version at $expected matches the pinned SHA-512"
