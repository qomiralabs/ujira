#!/usr/bin/env bash
# Copyright (c) 2026 Qomira Labs. All rights reserved.
# Proprietary and confidential. Unauthorized copying is prohibited.
#
# Runs the database tests of an earlier commit against this checkout's
# migrations. During a deploy the new schema goes out before the new code,
# so the code already running must keep working against it; that is what an
# expand migration promises, and this is where the promise is checked.
#
# The earlier commit is checked out beside this one, its migrations folder
# is replaced by this checkout's, and so is the migration runner, because
# the runner is deploy tooling that ships with the migrations rather than
# code that was already running. Everything else, the repository code and
# its tests, is the earlier commit's.
#
# Usage: scripts/db-previous-release.sh <ref>

set -euo pipefail

ref="${1:?usage: scripts/db-previous-release.sh <ref>}"
root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
tree="${work}/tree"

cleanup() {
  git -C "$root" worktree remove --force "$tree" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

git -C "$root" worktree add --detach "$tree" "$ref" > /dev/null

if [ ! -f "${tree}/packages/db/src/migrate.ts" ]; then
  echo "db-previous-release: ${ref} has no database package, so there is no earlier code to check"
  exit 0
fi

rm -rf "${tree}/packages/db/migrations"
cp -R "${root}/packages/db/migrations" "${tree}/packages/db/migrations"
cp "${root}/packages/db/src/migrate.ts" "${tree}/packages/db/src/migrate.ts"

cd "$tree"
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec vitest run --configLoader native --project @ujira/db
echo "db-previous-release: the database tests of ${ref} pass against this checkout's migrations"
