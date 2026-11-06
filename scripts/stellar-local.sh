#!/usr/bin/env bash
# Copyright (c) 2026 Qomira Labs. All rights reserved.
# Proprietary and confidential. Unauthorized copying is prohibited.
#
# Starts and stops the local Stellar network the opt-in integration tests run
# against. It runs with testnet's passphrase, because the adapter only signs
# for the networks it knows, and it is reachable on the loopback address only.
#
# It runs the protocol testnet runs, 30, rather than the image's default, so
# the contracts behave as they do where they are deployed. Quickstart applies
# that upgrade after RPC first answers, so up waits until the network reports
# it and has closed some ledgers under it before handing the URL over.
#
# The image is pinned by digest. Memory and CPU are capped, because the
# machines this runs on are shared, and the network is meant to live only as
# long as one test run: stop it as soon as the run ends.
#
# Usage:
#   scripts/stellar-local.sh up     start it, wait until it is ready, print the URL to export
#   scripts/stellar-local.sh down   stop and remove it
#
# Environment: UJIRA_STELLAR_LOCAL_PORT (default 18000) and
# UJIRA_STELLAR_LOCAL_NAME (default ujira-stellar-local).
# Needs docker, curl and python3.

set -euo pipefail

# stellar/quickstart v682-b1552.1-latest, published 2026-10-22.
image='stellar/quickstart@sha256:dcb99032d2292c8408d551518edbd23448b5c7d8a8999211157ac4d3d6a1f56f'
name="${UJIRA_STELLAR_LOCAL_NAME:-ujira-stellar-local}"
port="${UJIRA_STELLAR_LOCAL_PORT:-18000}"
url="http://127.0.0.1:${port}/rpc"
protocol=30
# Ledgers to close under the protocol before the network counts as ready.
settle=20

# "<protocol> <ledger>" as the network reports them, or nothing while it cannot answer.
latest() {
  curl -s --max-time 4 -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' "$url" |
    python3 -c 'import json, sys
r = json.load(sys.stdin)["result"]
print(r["protocolVersion"], r["sequence"])' 2> /dev/null || true
}

case "${1:-}" in
  up)
    docker rm -f "$name" > /dev/null 2>&1 || true
    docker run -d --name "$name" \
      --memory 1536m --memory-swap 1536m --cpus 1.5 \
      -p "127.0.0.1:${port}:8000" \
      -e 'NETWORK_PASSPHRASE=Test SDF Network ; September 2015' \
      "$image" --local --enable core,rpc --limits testnet --protocol-version "$protocol" > /dev/null
    upgraded_at=''
    for _ in $(seq 1 120); do
      read -r now_protocol now_ledger <<< "$(latest) "
      if [ "${now_protocol:-}" = "$protocol" ]; then
        upgraded_at="${upgraded_at:-$now_ledger}"
        if [ "$now_ledger" -ge $((upgraded_at + settle)) ]; then
          echo "UJIRA_STELLAR_LOCAL_RPC=${url}"
          exit 0
        fi
      fi
      if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2> /dev/null)" != true ]; then
        break
      fi
      sleep 5
    done
    echo "stellar-local: the network did not reach protocol ${protocol}" >&2
    docker logs --tail 40 "$name" >&2 || true
    docker rm -f "$name" > /dev/null 2>&1 || true
    exit 1
    ;;
  down)
    docker rm -f "$name" > /dev/null 2>&1 || true
    ;;
  *)
    echo "usage: scripts/stellar-local.sh up|down" >&2
    exit 2
    ;;
esac
