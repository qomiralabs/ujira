#!/usr/bin/env bash
# Copyright (c) 2026 Qomira Labs. All rights reserved.
# Proprietary and confidential. Unauthorized copying is prohibited.
#
# Fails unless every workflow step whose `run` script calls pnpm starts with
# scripts/assert-pnpm.sh, so each step proves it runs the pinned binary
# before it runs pnpm. Comments and blank lines may come first. A step runs
# pnpm when `pnpm` appears as a command word: paths such as
# "${RUNNER_TEMP}/pnpm/pnpm", file names such as pnpm.tgz and comments do not
# count. Steps that only `uses:` an action cannot be checked here.
#
# Usage: scripts/check-workflow-pnpm.sh [repository root]
# Exit codes: 0 every pnpm step asserts first, 1 steps named on stderr,
# 2 no workflow files.
set -euo pipefail

root=${1:-"$(cd "$(dirname "$0")/.." && pwd)"}
shopt -s nullglob
files=("$root"/.github/workflows/*.yml "$root"/.github/workflows/*.yaml)
if [ "${#files[@]}" -eq 0 ]; then
  echo "check-workflow-pnpm: no workflow files in $root/.github/workflows" >&2
  exit 2
fi

awk '
  function indent_of(s) { match(s, /^ */); return RLENGTH }
  function unquote(s,   q, first, last) {
    q = sprintf("%c", 39)
    first = substr(s, 1, 1)
    last = substr(s, length(s), 1)
    if (length(s) >= 2 && first == last && (first == "\"" || first == q)) return substr(s, 2, length(s) - 2)
    return s
  }
  function runs_pnpm(s) {
    return s ~ /(^|[^A-Za-z0-9_.\/@${}-])pnpm([^A-Za-z0-9_.\/@-]|$)/
  }
  function finish_step(   i, line, first, pnpm) {
    if (has_run) {
      first = ""
      pnpm = 0
      for (i = 1; i <= count; i++) {
        line = lines[i]
        sub(/^[ \t]+/, "", line)
        sub(/[ \t]+$/, "", line)
        if (line == "" || line ~ /^#/) continue
        if (first == "") first = line
        if (runs_pnpm(line)) pnpm = 1
      }
      if (pnpm) {
        steps++
        if (first !~ /^(\.\/)?scripts\/assert-pnpm\.sh$/) {
          bad++
          printf "%s:%d: step \"%s\" runs pnpm without first running scripts/assert-pnpm.sh\n", \
            FILENAME, run_line, (name == "" ? "(unnamed)" : name) > "/dev/stderr"
        }
      }
    }
    in_step = 0; has_run = 0; in_block = 0; count = 0; name = ""
  }
  FNR == 1 { if (NR > 1) finish_step() }
  {
    sub(/\r$/, "")
    if (in_block) {
      if ($0 ~ /^[ \t]*$/ || indent_of($0) > block_indent) { lines[++count] = $0; next }
      in_block = 0
    }
    if (match($0, /^ *- [A-Za-z_-]+:/)) {
      finish_step()
      in_step = 1
      step_indent = indent_of($0)
      key_line = $0
      sub(/^ *- /, "", key_line)
      key_indent = step_indent + 2
    } else if (in_step && $0 !~ /^[ \t]*$/ && $0 !~ /^[ \t]*#/ && indent_of($0) <= step_indent) {
      finish_step()
      next
    } else {
      key_line = $0
      sub(/^ */, "", key_line)
      key_indent = indent_of($0)
    }
    if (!in_step) next
    if (key_line ~ /^name:/) {
      name = key_line
      sub(/^name:[ ]*/, "", name)
      name = unquote(name)
    } else if (key_line ~ /^run:/) {
      value = key_line
      sub(/^run:[ ]*/, "", value)
      has_run = 1
      run_line = FNR
      if (value ~ /^[|>][+-]?[0-9]*$/) {
        in_block = 1
        block_indent = key_indent
      } else {
        lines[++count] = unquote(value)
      }
    }
  }
  END {
    finish_step()
    if (bad > 0) {
      printf "check-workflow-pnpm: %d of %d step(s) that run pnpm do not assert the pinned binary first\n", bad, steps > "/dev/stderr"
      exit 1
    }
    printf "check-workflow-pnpm: %d step(s) that run pnpm, all assert the pinned binary first\n", steps
  }
' "${files[@]}"
