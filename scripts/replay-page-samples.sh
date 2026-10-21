#!/usr/bin/env bash
# Copyright (c) 2026 Qomira Labs. All rights reserved.
# Proprietary and confidential. Unauthorized copying is prohibited.
#
# Replays the recorded page samples through the real Lighthouse CI assert
# command and the committed lighthouserc.json.
#
# The samples under scripts/fixtures/page-performance/recorded-samples are
# three runs of one route from one CI job, taken from identical bytes, which
# scored 0.79, 0.75 and 0.91 with 512.5, 651.2 and 136.5 ms of blocking
# time. The spread between them is wider than the distance from the failing
# median to the bar, so a failure on those two metrics said nothing about
# whether the branch had regressed. They are reported now instead of gating.
#
# Two directions, because a replay that can only pass proves nothing:
#   1. the committed config must not fail these samples;
#   2. the same samples, with those two bars put back to error, must fail,
#      which is what makes the first result mean something.
#
# Lighthouse CI reads reports from .lighthouseci in the working directory,
# and its --lhr flag reads file names from the folder given but opens them in
# .lighthouseci, so each direction runs in its own temporary directory.
#
# Usage: scripts/replay-page-samples.sh
# Exit codes: 0 both directions behaved, 1 either did not, 2 the fixtures or
# the Lighthouse CI binary are missing.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
samples="$here/scripts/fixtures/page-performance/recorded-samples"
config="$here/apps/dashboard/lighthouserc.json"
lhci="$here/apps/dashboard/node_modules/.bin/lhci"

for path in "$samples" "$config" "$lhci"; do
  if [ ! -e "$path" ]; then
    echo "replay-page-samples: $path is missing; run pnpm install first" >&2
    exit 2
  fi
done

count=$(find "$samples" -maxdepth 1 -name 'lhr-*.json' | wc -l | tr -d ' ')
if [ "$count" != 3 ]; then
  echo "replay-page-samples: expected 3 recorded samples, found $count" >&2
  exit 2
fi

work=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$work"' EXIT

# The armed config is derived from the committed one rather than kept beside
# it, so the second direction cannot go stale, and the rewrite must actually
# change something or this check would be comparing a file with itself.
node - "$config" "$work/armed.json" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [, , from, to] = process.argv;
const text = readFileSync(from, 'utf8');
const armed = text.replace(/"warn"/g, '"error"');
const changed = (text.match(/"warn"/g) ?? []).length;
if (changed !== 2) {
  console.error(`replay-page-samples: expected 2 reported metrics in the config, found ${changed}`);
  process.exit(2);
}
writeFileSync(to, armed);
NODE

run_assert() {
  local name="$1" rc_file="$2" dir="$work/$1"
  mkdir -p "$dir/.lighthouseci"
  cp "$samples"/lhr-*.json "$dir/.lighthouseci/"
  # The assert command colours its output and wraps each metric name in
  # escape codes, which would split the names the checks below look for, so
  # the codes are stripped as the output is saved. PIPESTATUS carries the
  # command's own exit code rather than the filter's.
  ( cd "$dir" && "$lhci" assert --config "$rc_file" ) 2>&1 |
    sed $'s/\033\\[[0-9;]*m//g' > "$work/$name.out"
  return "${PIPESTATUS[0]}"
}

status=0

if run_assert committed "$config"; then
  echo "pass: the committed config reports the recorded samples without failing"
else
  echo "FAIL: the committed config fails the recorded samples" >&2
  echo "      These three samples came from identical bytes, so failing them" >&2
  echo "      blocks a branch for a quiet runner rather than a regression." >&2
  sed 's/^/      /' "$work/committed.out" >&2
  status=1
fi

if run_assert armed "$work/armed.json"; then
  echo "FAIL: the recorded samples pass even with both bars set to error" >&2
  echo "      The replay is testing nothing: either the samples no longer" >&2
  echo "      carry the recorded values or the bars no longer apply to them." >&2
  sed 's/^/      /' "$work/armed.out" >&2
  status=1
else
  echo "pass: the same samples do fail when those two bars are errors"
fi

# The failing direction must fail on the two metrics under test and not on
# something incidental, such as a report the assert command could not read.
if [ "$status" = 0 ]; then
  for metric in categories.performance total-blocking-time; do
    if ! grep -q "$metric" "$work/armed.out"; then
      echo "FAIL: the armed run did not fail on $metric" >&2
      sed 's/^/      /' "$work/armed.out" >&2
      status=1
    fi
  done
fi

if [ "$status" = 0 ]; then
  echo "replay-page-samples: both directions behaved"
fi
exit "$status"
