#!/usr/bin/env bash
# Copyright (c) 2026 Qomira Labs. All rights reserved.
# Proprietary and confidential. Unauthorized copying is prohibited.
#
# Runs the dashboard's Playwright suite on Linux x64, the platform CI runs on
# and the one the visual baselines are rendered for, from any machine with
# Docker. The checkout is copied into the container and installed there from
# the lockfile, so nothing from the host's node_modules is used.
#
#   apps/dashboard/scripts/e2e-linux.sh            the full suite, as in CI
#   apps/dashboard/scripts/e2e-linux.sh --update   re-render the visual baselines
#                                                  and write them back to e2e/
set -euo pipefail

mode="${1:-check}"
case "$mode" in
  check) suite='pnpm --filter @ujira/dashboard exec playwright test' ;;
  --update) suite='pnpm --filter @ujira/dashboard exec playwright test --grep "visual snapshots" --update-snapshots=all' ;;
  *) echo "usage: $0 [--update]" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/../../.." && pwd)"
playwright="$(node -p "require('$root/apps/dashboard/package.json').devDependencies['@playwright/test']")"
pnpm_version="$(sed -n 's/^  PNPM_VERSION: //p' "$root/.github/workflows/ci.yml")"
pnpm_sha="$(sed -n "s/^  PNPM_EXE_SHA512: '\(.*\)'$/\1/p" "$root/.github/workflows/ci.yml")"
out="$root/apps/dashboard/e2e/__screenshots__"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Tracked and new files only, never ignored output such as node_modules.
# COPYFILE_DISABLE stops macOS tar from adding ._ metadata files, and
# --no-xattrs keeps its extended attributes out, which GNU tar warns about
# on every file inside the container.
(cd "$root" && git ls-files -z --cached --others --exclude-standard) |
  (cd "$root" && COPYFILE_DISABLE=1 tar --no-xattrs --null -T - -czf "$work/src.tgz")

docker run --rm --platform linux/amd64 \
  -e CI=true -e NEXT_TELEMETRY_DISABLED=1 \
  -e PNPM_VERSION="$pnpm_version" -e PNPM_SHA="$pnpm_sha" -e SUITE="$suite" \
  -v "$work:/work" \
  "mcr.microsoft.com/playwright:v${playwright}-noble" \
  bash -euo pipefail -c '
    mkdir /src && tar -xzf /work/src.tgz -C /src && cd /src
    # The workspace check reads the git index.
    git init -q && git add -A
    curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o /tmp/pnpm.tgz "https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-${PNPM_VERSION}.tgz"
    echo "${PNPM_SHA}  /tmp/pnpm.tgz" | sha512sum --check --strict
    mkdir /tmp/pnpm && tar -xzf /tmp/pnpm.tgz -C /tmp/pnpm --strip-components 1 package/pnpm
    export PATH="/tmp/pnpm:$PATH"
    pnpm install --frozen-lockfile --ignore-scripts
    pnpm build
    eval "$SUITE"
    cp -r apps/dashboard/e2e/__screenshots__ /work/screenshots
  '

if [ "$mode" = --update ]; then
  rm -rf "$out"
  cp -r "$work/screenshots" "$out"
  echo "Updated $(find "$out" -name '*.png' | wc -l | tr -d ' ') baselines in ${out#"$root"/}"
fi
