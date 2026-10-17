#!/usr/bin/env bash
# Copyright (c) 2026 Qomira Labs. All rights reserved.
# Proprietary and confidential. Unauthorized copying is prohibited.
#
# Self test for check-workflow-pnpm.sh. Each case writes a workflow into a
# temp directory and checks the exit code and output. The last case runs the
# check on this repository's own workflows.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/check-workflow-pnpm.sh"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$work"' EXIT

passed=0
failures=0
case_dir=

# workflow <case name>: reads a workflow from stdin into a new case folder
workflow() {
  case_dir="$work/$1"
  mkdir -p "$case_dir/.github/workflows"
  cat >"$case_dir/.github/workflows/ci.yml"
}

# expect <case name> <exit code> [text the output must contain]...
expect() {
  local name=$1 want=$2
  shift 2
  local out code=0 needle
  out=$("$script" "$case_dir" 2>&1) || code=$?
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

workflow asserted <<'YAML'
jobs:
  verify:
    steps:
      - name: Install
        run: |
          scripts/assert-pnpm.sh
          pnpm install --frozen-lockfile
      - name: Lint
        run: |
          # The assertion comes first, after comments and blank lines.

          scripts/assert-pnpm.sh
          pnpm lint
YAML
expect "steps that assert first pass" 0 "2 step(s) that run pnpm, all assert the pinned binary first"

workflow single_line <<'YAML'
jobs:
  verify:
    steps:
      - name: Typecheck
        run: pnpm typecheck
YAML
expect "a one line run of pnpm fails" 1 'ci.yml:5: step "Typecheck" runs pnpm without first running scripts/assert-pnpm.sh'

workflow assert_after <<'YAML'
jobs:
  verify:
    steps:
      - name: Build
        run: |
          pnpm build
          scripts/assert-pnpm.sh
YAML
expect "an assertion after pnpm fails" 1 'step "Build" runs pnpm'

workflow assert_in_other_step <<'YAML'
jobs:
  verify:
    steps:
      - name: Assert
        run: scripts/assert-pnpm.sh
      - name: Test
        run: |
          pnpm test
YAML
expect "an assertion in an earlier step does not count" 1 'step "Test" runs pnpm'

workflow forms <<'YAML'
jobs:
  verify:
    steps:
      - name: Chained
        run: echo start && pnpm audit
      - name: Substituted
        run: |
          echo "$(pnpm store path)"
      - name: Folded
        run: >-
          pnpm
          format:check
      - run: pnpm build
      - name: Quoted
        run: "pnpm lint"
YAML
expect "pnpm after &&, in a substitution, folded, unnamed or quoted fails" 1 \
  'step "Chained"' 'step "Substituted"' 'step "Folded"' 'step "(unnamed)"' 'step "Quoted"' "5 of 5 step(s)"

workflow not_pnpm <<'YAML'
jobs:
  verify:
    steps:
      - name: Set up pnpm
        run: |
          curl -fsSLo pnpm.tgz "https://registry.example.invalid/pnpm.tgz"
          tar -xzf pnpm.tgz -C "${RUNNER_TEMP}/pnpm" package/pnpm
          echo "${RUNNER_TEMP}/pnpm" >> "${GITHUB_PATH}"
      - name: Comment only
        run: |
          # pnpm install would go here
          echo nothing
      - name: Uses
        uses: actions/setup-node@0000000000000000000000000000000000000000
        with:
          cache: pnpm
YAML
expect "paths, file names, comments and uses steps are not pnpm runs" 0 "0 step(s) that run pnpm"

workflow wrong_assertion <<'YAML'
jobs:
  verify:
    steps:
      - name: Install
        run: |
          scripts/assert-pnpm.sh || true
          pnpm install
      - name: Lint
        run: |
          echo scripts/assert-pnpm.sh
          pnpm lint
YAML
expect "an assertion that can be ignored or is not a command fails" 1 'step "Install"' 'step "Lint"'

workflow later_key <<'YAML'
jobs:
  verify:
    steps:
      - name: Install
        env:
          CI: true
        run: |
          scripts/assert-pnpm.sh
          pnpm install
        shell: bash
      - name: Next
        run: pnpm lint
YAML
expect "keys around run do not hide the next step" 1 'step "Next"' "1 of 2 step(s)"

mkdir -p "$work/no_workflows"
case_dir="$work/no_workflows"
expect "a tree without workflows exits 2" 2 "no workflow files"

case_dir="$repo_root"
expect "this repository's workflows assert pnpm in every step" 0 "all assert the pinned binary first"

echo
echo "$passed passed, $failures failed"
[ "$failures" -eq 0 ]
